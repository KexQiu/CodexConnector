import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { readCredentials } from '../../src/feishu/credentials.ts';
import { FeishuRuntime } from '../../src/feishu/runtime.ts';
import { FeishuApi, FeishuApiError } from '../../src/feishu/api.ts';
import { receiptMarker } from '../../src/feishu/sender.ts';
import {
  privateDirectory,
  startServer,
  connectClient,
  versionBaseline,
  cleanupDirectory,
  ProbeBlocked,
  delay,
} from './probe-support.mjs';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    config: { type: 'string', default: 'config/feishu.local.json' },
    timeout: { type: 'string', default: '900' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.live) {
  console.log(
    'pnpm gate:gateway --live [--config config/feishu.local.json] [--timeout 900]\n人工参与 M3 闭环：两条新建任务、重复刷新按钮、回复旧卡片续跑。仅使用专用单聊和临时项目，故意丢弃一次真实发送回包以验证历史核对，不安装服务。',
  );
  process.exit(values.help ? 0 : 1);
}
const timeout = Number(values.timeout);
if (!Number.isInteger(timeout) || timeout < 60 || timeout > 1800)
  throw new Error('timeout must be 60..1800');
process.umask(0o077);
const credentials = readCredentials(resolve(values.config));
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const code = runId.slice(-8),
  prefix = `M3 ${code} `;
const artifacts = resolve('.artifacts/m3', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const directory = await privateDirectory('codex-m3-');
const report = {
  runId,
  startedAt: new Date().toISOString(),
  baseline: versionBaseline(),
  status: 'RUNNING',
  checks: {},
  cleanup: [],
  limitations: [
    'Same-message redelivery is a local replay of a captured real event, not platform automatic redelivery.',
    'Controlled response loss occurs after a real successful POST; this is not a network outage.',
    'Only the configured private chat and temporary project are used.',
  ],
};
const checkpoint = () =>
  writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
let server,
  client,
  db,
  runtime,
  stopped = false;
const stop = () => {
  stopped = true;
  runtime?.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const extraConfig = [
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.shell_snapshot=false',
    'mcp_servers={}',
    'model_reasoning_effort="low"',
  ];
  server = await startServer({ directory, homeMode: 'existing', transport: 'unix', extraConfig });
  client = await connectClient(server);
  const schema = z.object({
    config: z.object({
      mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
      features: z.record(z.string(), z.unknown()),
    }),
  });
  let effective = await client.request(
    'config/read',
    { includeLayers: false, cwd: directory },
    schema,
  );
  const names = Object.entries(effective.config.mcp_servers)
    .filter(([, s]) => s.enabled !== false)
    .map(([name]) => name);
  if (names.length) {
    client.close();
    report.cleanup.push({ stage: 'discovery', ...(await server.stop()) });
    if (names.some((n) => !/^[a-zA-Z0-9_-]+$/.test(n)))
      throw new ProbeBlocked('Unsupported MCP name');
    extraConfig.push(...names.map((n) => `mcp_servers.${n}.enabled=false`));
    server = await startServer({ directory, homeMode: 'existing', transport: 'unix', extraConfig });
    client = await connectClient(server);
    effective = await client.request(
      'config/read',
      { includeLayers: false, cwd: directory },
      schema,
    );
  }
  assert(Object.values(effective.config.mcp_servers).every((s) => s.enabled === false));
  for (const key of ['hooks', 'plugins', 'apps', 'multi_agent'])
    assert.equal(effective.config.features[key], false);
  client.close();
  client = undefined;
  report.checks.integrationIsolation = 'PASS';
  db = openGatewayDatabase(join(artifacts, 'gateway.sqlite'));
  const store = new TaskStore(db);
  const config = {
    schemaVersion: 1,
    dataDir: artifacts,
    maxConcurrentTasks: 1,
    codex: {
      binary: report.baseline.binary,
      endpoint: server.endpoint,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    },
    feishu: {
      appId: credentials.appId,
      tenantKey: credentials.tenantKey,
      allowedOpenId: credentials.allowedOpenId,
      credentialsFile: resolve(values.config),
    },
    projects: [{ key: 'fixture', name: 'M3 临时验收项目', root: directory, remoteWrite: true }],
  };
  await writeFile(join(artifacts, 'config.private.json'), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  const api = new FeishuApi(credentials);
  // Check read permissions before asking the user to submit a task.
  await api.history(credentials.testChatId, Date.now() - 60_000);
  report.checks.historyPermission = 'PASS';
  let injected = false,
    actualPosts = 0,
    actualPatches = 0,
    replayed = false,
    overlap = false,
    callbacks = 0,
    duplicateCallbacks = 0;
  const create = api.create.bind(api),
    update = api.update.bind(api);
  api.create = async (...args) => {
    const result = await create(...args);
    actualPosts++;
    if (!injected) {
      injected = true;
      throw new FeishuApiError('unknown');
    }
    return result;
  };
  api.update = async (...args) => {
    const result = await update(...args);
    actualPatches++;
    return result;
  };
  runtime = new FeishuRuntime(store, config, credentials, { prefix, api });
  const receive = runtime.inbox.receive.bind(runtime.inbox);
  runtime.inbox.receive = (kind, data) => {
    const result = receive(kind, data);
    if (kind === 'action' && ['accepted', 'duplicate'].includes(result.outcome)) {
      callbacks++;
      if (result.outcome === 'duplicate') duplicateCallbacks++;
    }
    if (kind === 'message' && result.outcome === 'accepted' && !replayed) {
      replayed = true;
      const replay = receive(kind, data);
      assert.equal(replay.outcome, 'duplicate');
      report.checks.realMessageLocalReplay = 'PASS';
    }
    return result;
  };
  await runtime.start();
  report.checks.connection = 'PASS';
  await checkpoint();
  const firstText =
    prefix +
    '/新建 fixture 不使用工具、不读取文件或个人数据。按顺序列出 1 到 800，最后写 M3_A_OK。';
  const secondText = prefix + '/新建 fixture 不使用工具、不读取文件或个人数据。只回复 M3_B_OK。';
  log('send-two-messages', { first: firstText, second: secondText });
  const deadline = Date.now() + timeout * 1000;
  let asked = false,
    finished = false;
  while (!stopped && Date.now() < deadline) {
    await runtime.tick();
    const tasks = store.list();
    if (tasks.filter((t) => ['queued', 'starting', 'running'].includes(t.status)).length >= 2)
      overlap = true;
    if (tasks.some((t) => ['failed', 'unknown'].includes(t.status)))
      throw new ProbeBlocked('Model task failed or became unknown; inspect local state');
    const first = tasks.find((t) => t.prompt.includes('M3_A_OK')),
      second = tasks.find((t) => t.prompt.includes('M3_B_OK'));
    if (
      first?.status === 'completed' &&
      second?.status === 'completed' &&
      first.notification_message_id &&
      second.notification_message_id &&
      !asked
    ) {
      const newestDelivered = tasks.every((t) =>
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM outbox WHERE task_id=? AND card_version=? AND state='delivered'",
            )
            .get(t.task_id, t.version),
        ),
      );
      if (newestDelivered) {
        asked = true;
        report.checks.twoPhoneTasksCompleted = 'PASS';
        report.checks.concurrentQueue = overlap ? 'PASS' : 'NOT_OBSERVED';
        await checkpoint();
        log('click-and-reply', {
          instruction:
            '在第一张（包含 M3_A_OK）的任务卡片上快速点击「刷新状态」两次，然后回复这张卡片发送下面的文本。不要回复第二张卡片。',
          text: prefix + '不使用工具、不读取文件。只回复 M3_CONTINUE_OK。',
        });
      }
    }
    const continued = tasks.find((t) => t.prompt.includes('M3_CONTINUE_OK'));
    if (
      asked &&
      continued?.status === 'completed' &&
      continued.notification_message_id &&
      duplicateCallbacks > 0
    ) {
      if (
        !db
          .prepare("SELECT 1 FROM outbox WHERE task_id=? AND card_version=? AND state='delivered'")
          .get(continued.task_id, continued.version)
      ) {
        await delay(500);
        continue;
      }
      assert.equal(continued.thread_id, first.thread_id);
      assert.notEqual(continued.thread_id, second.thread_id);
      assert.equal(tasks.length, 3);
      for (const task of tasks) {
        const latest = db
          .prepare("SELECT * FROM outbox WHERE task_id=? AND card_version=? AND state='delivered'")
          .get(task.task_id, task.version);
        assert(latest);
        const actual = await api.get(task.notification_message_id);
        assert(actual.body.content.includes(receiptMarker(latest.outbox_id)));
        assert.equal(
          db
            .prepare(
              "SELECT count(*) FROM outbox WHERE task_id=? AND operation='send' AND state='delivered'",
            )
            .pluck()
            .get(task.task_id),
          1,
        );
      }
      assert.equal(
        db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
        3,
      );
      assert.equal(
        db.prepare("SELECT count(*) FROM outbox WHERE state='unknown'").pluck().get(),
        0,
      );
      assert.equal(store.diagnostics().locks, 0);
      report.checks.oldCardReplyOwnership = 'PASS';
      report.checks.duplicateButton = 'PASS';
      report.checks.sameCardTerminalVerified = 'PASS';
      report.checks.lostSendResponseReconciled = 'PASS';
      report.evidence = {
        tasks: 3,
        turnStarts: 3,
        actualPosts,
        actualPatches,
        callbacks,
        duplicateCallbacks,
        injectedResponseLoss: injected,
        locks: 0,
      };
      report.status = overlap ? 'PASS' : 'PARTIAL';
      finished = true;
      break;
    }
    await delay(500);
  }
  if (!finished)
    throw new ProbeBlocked(stopped ? 'Interrupted' : 'Timed out waiting for phone interaction');
} catch (error) {
  report.status =
    error instanceof ProbeBlocked || (error instanceof FeishuApiError && error.apiCode === 99991672)
      ? 'BLOCKED'
      : 'FAIL';
  report.error = {
    type: error.name,
    ...(error instanceof FeishuApiError
      ? { outcome: error.outcome, http: error.httpStatus, code: error.apiCode }
      : { reason: error instanceof ProbeBlocked ? error.message : 'Inspect private diagnostic' }),
  };
  await writeFile(
    join(artifacts, 'error.private.json'),
    JSON.stringify({ name: error.name, message: error.message, stack: error.stack }, null, 2) +
      '\n',
    { mode: 0o600 },
  );
} finally {
  runtime?.close();
  client?.close();
  if (db?.open) db.close();
  if (server) {
    await server.diagnostics(join(artifacts, 'server.private.log'));
    report.cleanup.push(await server.stop());
  }
  await cleanupDirectory(directory);
  report.cleanup.push({ temporaryDirectoryRemoved: true });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await checkpoint();
}
log('finished', {
  status: report.status,
  report: join(artifacts, 'report.json'),
  error: report.error,
});
process.exitCode = report.status === 'PASS' ? 0 : 1;
