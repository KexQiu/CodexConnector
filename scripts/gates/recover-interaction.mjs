import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openReadonlyDatabase, openGatewayDatabase } from '../../src/persistence/database.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { TaskWorker } from '../../src/tasks/worker.ts';
import { FeishuSender, receiptMarker } from '../../src/feishu/sender.ts';
import { FeishuApi } from '../../src/feishu/api.ts';
import { readCredentials } from '../../src/feishu/credentials.ts';
import { startServer, connectClient, versionBaseline, cleanupDirectory } from './probe-support.mjs';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    source: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (!values.live || !values.source || values.help) {
  console.log(
    'node --import tsx scripts/gates/recover-interaction.mjs --live --source .artifacts/m4/APPROVALS_RUN\n仅核对已退出的 M4 审批探针原 thread/turn，复制数据库后恢复，不提交新 turn；确认终态后更新原飞书卡。',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const runId =
  new Date().toISOString().replaceAll(':', '-') + '-recovery-' + randomUUID().slice(0, 8);
const artifacts = resolve('.artifacts/m4', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const report = { runId, status: 'RUNNING', checks: {}, cleanup: [] };
let directory,
  created = false,
  server,
  client,
  db,
  worker;
try {
  report.baseline = versionBaseline();
  const source = resolve(values.source);
  assert(source.startsWith(resolve('.artifacts/m4') + '/'));
  const prior = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'));
  assert(['approvals', 'inputs'].includes(prior.suite));
  assert(['FAIL', 'BLOCKED'].includes(prior.status));
  assert(prior.cleanup.some((c) => c.ownedProcessExited));
  const original = openReadonlyDatabase(join(source, 'gateway.sqlite'));
  let task;
  try {
    const tasks = original.prepare('SELECT * FROM tasks').all();
    assert.equal(tasks.length, 1);
    task = tasks[0];
    assert.equal(task.status, 'unknown');
    assert(
      task.turn_id &&
        task.thread_id &&
        (prior.suite === 'approvals'
          ? task.prompt.includes('M4_APPROVAL_PROBE')
          : task.prompt.startsWith('This is a harmless test of the real request_user_input tool.')),
    );
    await original.backup(join(artifacts, 'gateway.sqlite'));
  } finally {
    original.close();
  }
  directory = task.cwd;
  assert.match(directory, /^\/private\/tmp\/codex-m4-[a-zA-Z0-9]+$/);
  await mkdir(directory, { mode: 0o700 });
  created = true;
  report.sourceRun = prior.runId;
  const extraConfig = [
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.shell_snapshot=false',
    'mcp_servers={}',
  ];
  const schema = z.object({
    config: z.object({
      mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
      features: z.record(z.string(), z.unknown()),
    }),
  });
  server = await startServer({ directory, homeMode: 'existing', transport: 'unix', extraConfig });
  client = await connectClient(server);
  let effective = await client.request(
    'config/read',
    { includeLayers: false, cwd: directory },
    schema,
  );
  const names = Object.entries(effective.config.mcp_servers)
    .filter(([, s]) => s.enabled !== false)
    .map(([name]) => name);
  if (names.length) {
    assert(names.every((name) => /^[a-zA-Z0-9_-]+$/.test(name)));
    client.close();
    report.cleanup.push(await server.stop());
    extraConfig.push(...names.map((name) => `mcp_servers.${name}.enabled=false`));
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
  const config = JSON.parse(await readFile(join(source, 'config.private.json'), 'utf8'));
  config.codex.endpoint = server.endpoint;
  config.dataDir = artifacts;
  db = openGatewayDatabase(join(artifacts, 'gateway.sqlite'));
  const store = new TaskStore(db);
  const starts = () =>
    db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get();
  const before = starts();
  worker = new TaskWorker(store, config);
  // Read/recover only. No approval is granted, even if the server reissues an old request.
  worker.interactions.receive = (request) => worker.rpc.reject(request);
  await worker.start();
  const recovered = store.get(task.task_id);
  assert.equal(recovered.turn_id, task.turn_id);
  assert.equal(recovered.thread_id, task.thread_id);
  assert(['completed', 'interrupted', 'failed'].includes(recovered.status));
  assert.equal(starts(), before);
  assert.equal(store.diagnostics().locks, 0);
  report.checks.exactTurnAfterServerExit = 'PASS';
  report.checks.noNewTurnOrApproval = 'PASS';
  report.taskStatus = recovered.status;
  const credentials = readCredentials(resolve('config/feishu.local.json'));
  const api = new FeishuApi(credentials);
  const sender = new FeishuSender(store, credentials, api);
  for (let i = 0; i < 50; i++) {
    await sender.reconcileOne();
    await sender.flushOne();
    if (
      !db
        .prepare("SELECT 1 FROM outbox WHERE state NOT IN ('delivered','superseded') LIMIT 1")
        .get()
    )
      break;
  }
  assert(
    !db.prepare("SELECT 1 FROM outbox WHERE state NOT IN ('delivered','superseded') LIMIT 1").get(),
  );
  const remote = await api.get(recovered.notification_message_id);
  assert.equal(remote.chat_id, credentials.testChatId);
  assert.equal(remote.sender.id, credentials.appId);
  const latest = store.get(task.task_id);
  const delivered = db
    .prepare(
      "SELECT outbox_id FROM outbox WHERE task_id=? AND card_version=? AND state='delivered'",
    )
    .get(task.task_id, latest.version);
  assert(delivered);
  assert(!remote.deleted && remote.body.content.includes(receiptMarker(delivered.outbox_id)));
  report.checks.originalCardUpdated = 'PASS';
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = { name: error.name, reason: 'Inspect private diagnostic' };
  await writeFile(
    join(artifacts, 'error.private.json'),
    JSON.stringify({ message: error.message, stack: error.stack }, null, 2) + '\n',
    { mode: 0o600 },
  );
} finally {
  worker?.close();
  client?.close();
  if (db?.open) {
    report.finalState = new TaskStore(db).diagnostics();
    db.close();
  }
  if (server) {
    await server.diagnostics(join(artifacts, 'server.private.log'));
    report.cleanup.push(await server.stop());
  }
  if (created) {
    await cleanupDirectory(directory);
    report.cleanup.push({ temporaryDirectoryRemoved: true });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ status: report.status, report: join(artifacts, 'report.json') }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
