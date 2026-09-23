import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { RpcRejectedError } from '../../src/codex/rpc-client.ts';
import { GATEWAY_THREAD_POLICY } from '../../src/codex/protocol.ts';
import { threadResultSchema } from '../../src/codex/schemas.ts';
import { openReadonlyDatabase } from '../../src/persistence/database.ts';
import {
  startServer,
  connectClient,
  versionBaseline,
  cleanupDirectory,
  ProbeBlocked,
} from './probe-support.mjs';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    source: { type: 'string' },
    desktop: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (!values.live || !values.source || values.help) {
  console.log(
    'pnpm gate:ownership --live --source .artifacts/m4/CONTROLS_RUN [--desktop]\n只恢复已通过 M4 controls 的测试会话，不执行新模型。默认用两个自有 App Server 验证写锁。--desktop 分两步等待人工 GUI 观察，以标准输入 JSON 记录用户反馈；每步最多等待 30 分钟，退出只清理自有进程，不操作桌面进程或其他用户会话。',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const runId =
  new Date().toISOString().replaceAll(':', '-') +
  (values.desktop ? '-desktop-handoff-' : '-ownership-') +
  randomUUID().slice(0, 8);
const artifacts = resolve('.artifacts/m4', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
let directory,
  createdDirectory = false;
const report = {
  runId,
  mode: values.desktop ? 'desktop-observed' : 'two-owned-servers',
  status: 'RUNNING',
  startedAt: new Date().toISOString(),
  checks: {},
  cleanup: [],
  limitations: [
    values.desktop
      ? 'GUI observations come from the user, not automated UI inspection. RPC checks independently verify fixture ownership and unchanged history.'
      : 'Two independently owned App Servers model the writer conflict. No GUI process is stopped or automated.',
    'Reuses only the completed M4 controls fixture; no new model turn. Explicit owner shutdown is test-only, not an automatic Gateway handoff policy.',
  ],
};
const servers = [],
  clients = [];
const input = values.desktop
  ? createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  : undefined;
const cancellation = new globalThis.AbortController();
const checkpoint = async () => {
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
};
const observe = async (stage, action, outcomes) => {
  report.waitingFor = { stage, expiresAt: new Date(Date.now() + 1800_000).toISOString() };
  await checkpoint();
  console.log(
    JSON.stringify({ stage, threadId: report.threadId, report: join(artifacts, 'report.json') }),
  );
  let line;
  try {
    line = await input.question('GUI observation JSON> ', {
      signal: AbortSignal.any([AbortSignal.timeout(1800_000), cancellation.signal]),
    });
  } catch {
    throw new ProbeBlocked('No desktop observation before the 30-minute deadline');
  }
  const observation = z
    .object({
      action: z.literal(action),
      outcome: z.enum(outcomes),
      observation: z.string().trim().min(1).max(2000),
    })
    .strict()
    .parse(JSON.parse(line));
  delete report.waitingFor;
  return { ...observation, source: 'user-reported', recordedAt: new Date().toISOString() };
};
const stopOnSignal = () => cancellation.abort();
if (input) {
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
}
try {
  report.baseline = versionBaseline();
  const source = resolve(values.source);
  assert(source.startsWith(resolve('.artifacts/m4') + '/'));
  const prior = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'));
  assert.equal(prior.status, 'PASS');
  assert.equal(prior.suite, 'controls');
  const db = openReadonlyDatabase(join(source, 'gateway.sqlite'));
  let task;
  try {
    const tasks = db.prepare('SELECT thread_id,turn_id,cwd,status FROM tasks').all();
    assert.equal(tasks.length, 1);
    task = tasks[0];
  } finally {
    db.close();
  }
  assert.equal(task.status, 'interrupted');
  assert(task.thread_id);
  directory = task.cwd;
  assert.match(directory, /^\/private\/tmp\/codex-m4-[a-zA-Z0-9]+$/);
  // mkdir must fail if someone recreated this path after the controls probe cleaned it.
  await mkdir(directory, { mode: 0o700 });
  createdDirectory = true;
  report.sourceRun = prior.runId;
  const extraConfig = [
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.shell_snapshot=false',
    'mcp_servers={}',
  ];
  let first = await startServer({
    directory,
    homeMode: 'existing',
    transport: 'unix',
    extraConfig,
  });
  servers.push(first);
  let a = await connectClient(first);
  clients.push(a);
  const schema = z.object({
    config: z.object({
      mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
      features: z.record(z.string(), z.unknown()),
    }),
  });
  let effective = await a.request('config/read', { includeLayers: false, cwd: directory }, schema);
  const names = Object.entries(effective.config.mcp_servers)
    .filter(([, s]) => s.enabled !== false)
    .map(([n]) => n);
  if (names.length) {
    assert(names.every((n) => /^[a-zA-Z0-9_-]+$/.test(n)));
    a.close();
    report.cleanup.push(await first.stop());
    extraConfig.push(...names.map((n) => `mcp_servers.${n}.enabled=false`));
    first = await startServer({ directory, homeMode: 'existing', transport: 'unix', extraConfig });
    servers.push(first);
    a = await connectClient(first);
    clients.push(a);
    effective = await a.request('config/read', { includeLayers: false, cwd: directory }, schema);
  }
  assert(Object.values(effective.config.mcp_servers).every((s) => s.enabled === false));
  for (const name of ['hooks', 'plugins', 'apps', 'multi_agent'])
    assert.equal(effective.config.features[name], false);
  const second = await startServer({
    directory,
    homeMode: 'existing',
    transport: 'unix',
    extraConfig,
  });
  servers.push(second);
  const b = await connectClient(second);
  clients.push(b);
  const other = await b.request('config/read', { includeLayers: false, cwd: directory }, schema);
  assert(Object.values(other.config.mcp_servers).every((s) => s.enabled === false));
  const created = await a.request(
    'thread/resume',
    {
      ...GATEWAY_THREAD_POLICY,
      cwd: directory,
      runtimeWorkspaceRoots: [directory],
      threadId: task.thread_id,
      excludeTurns: true,
    },
    threadResultSchema,
    45000,
  );
  const id = created.thread.id;
  report.threadId = id;
  report.turnId = task.turn_id;
  const params = {
    ...GATEWAY_THREAD_POLICY,
    threadId: id,
    cwd: directory,
    runtimeWorkspaceRoots: [directory],
    excludeTurns: true,
  };
  let conflict;
  try {
    await b.request('thread/resume', params, threadResultSchema, 45000);
  } catch (error) {
    if (
      error instanceof RpcRejectedError &&
      error.code === -32600 &&
      error.remoteMessage.includes(`thread ${id} already has an active writer`)
    )
      conflict = error;
    else throw error;
  }
  if (!conflict) throw new ProbeBlocked('Expected writer conflict was not observed');
  report.checks.actualWriterConflict = 'PASS';
  if (values.desktop) {
    const before = await a.request(
      'thread/read',
      { threadId: id, includeTurns: true },
      threadResultSchema,
    );
    assert.equal(before.thread.turns.length, 1);
    assert.equal(before.thread.turns[0].id, task.turn_id);
    assert.equal(before.thread.turns[0].status, 'interrupted');
    report.guiOccupied = await observe('writer-held', 'release', ['occupied', 'history', 'error']);
    report.checks.guiWriterConflict =
      report.guiOccupied.outcome === 'occupied' ? 'PASS_USER_OBSERVED' : 'NOT_OBSERVED';
  }
  a.close();
  report.cleanup.push(await first.stop());
  if (values.desktop) {
    report.checks.explicitTestOwnerShutdown = 'PASS';
    report.guiReleased = await observe('writer-released', 'finish', [
      'history',
      'occupied',
      'error',
    ]);
    report.checks.guiResumeAfterRelease =
      report.guiReleased.outcome === 'history' ? 'PASS_USER_OBSERVED' : 'NOT_OBSERVED';
  } else {
    const resumed = await b.request('thread/resume', params, threadResultSchema, 45000);
    assert.equal(resumed.thread.id, id);
    assert.equal(resumed.thread.cwd, directory);
    assert.equal(resumed.thread.status.type, 'idle');
    report.checks.resumeAfterExplicitOwnerShutdown = 'PASS';
  }
  const history = await b.request(
    'thread/read',
    { threadId: id, includeTurns: true },
    threadResultSchema,
  );
  assert.equal(history.thread.turns.length, 1);
  assert.equal(history.thread.turns[0].id, task.turn_id);
  assert.equal(history.thread.turns[0].status, 'interrupted');
  report.checks.originalThreadNoNewModelTurn = 'PASS';
  if (
    values.desktop &&
    (report.guiOccupied.outcome !== 'occupied' || report.guiReleased.outcome !== 'history')
  )
    throw new ProbeBlocked(
      'Desktop behavior differs from the required conflict/release observations; inspect both user reports',
    );
  report.status = 'PASS';
} catch (error) {
  report.status = error instanceof ProbeBlocked ? 'BLOCKED' : 'FAIL';
  report.error = {
    name: error.name,
    reason: error instanceof ProbeBlocked ? error.message : 'Inspect private diagnostic',
  };
  await writeFile(
    join(artifacts, 'error.private.json'),
    JSON.stringify(
      {
        message: error.message,
        stack: error.stack,
        remoteMessage: error instanceof RpcRejectedError ? error.remoteMessage : undefined,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
} finally {
  input?.close();
  process.off('SIGINT', stopOnSignal);
  process.off('SIGTERM', stopOnSignal);
  delete report.waitingFor;
  for (const client of clients) client.close();
  for (const [index, server] of servers.entries()) {
    await server.diagnostics(join(artifacts, `server-${index}.private.log`));
    report.cleanup.push(await server.stop());
  }
  if (createdDirectory) {
    await cleanupDirectory(directory);
    report.cleanup.push({ temporaryDirectoryRemoved: true });
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
console.log(
  JSON.stringify({
    status: report.status,
    report: join(artifacts, 'report.json'),
    error: report.error,
  }),
);
process.exitCode = report.status === 'PASS' ? 0 : 1;
