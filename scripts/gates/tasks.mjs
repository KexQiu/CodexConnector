import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { z } from 'zod';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { threadResultSchema } from '../../src/codex/schemas.ts';
import {
  privateDirectory,
  startServer,
  connectClient,
  versionBaseline,
  cleanupDirectory,
  ProbeBlocked,
  delay,
} from './probe-support.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !values.live) {
  console.log(
    'pnpm gate:tasks --live\nRuns three bounded model tasks using the existing login and a private test workspace: new, continue, worker restart. Keeps private DB/backup/report under .artifacts/m2. Does not send Feishu messages, change global config, or delete history. Requires --live.',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const exec = promisify(execFile);
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const artifacts = resolve('.artifacts/m2', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const directory = await privateDirectory('codex-m2-');
const dataDir = join(artifacts, 'state');
await mkdir(dataDir, { mode: 0o700 });
const report = {
  runId,
  date: new Date().toISOString(),
  baseline: versionBaseline(),
  cases: [],
  cleanup: [],
};
let server, client, db, activeCli;
const configPath = join(artifacts, 'config.private.json');
let stopping;
let cleaning;
const cleanup = () => (cleaning ??= cleanupOwned());
async function cleanupOwned() {
  if (activeCli && activeCli.exitCode === null && activeCli.signalCode === null) {
    const exited = once(activeCli, 'exit');
    activeCli.kill('SIGTERM');
    await Promise.race([exited, delay(2_000)]);
    if (activeCli.exitCode === null && activeCli.signalCode === null) activeCli.kill('SIGKILL');
    await exited;
  }
  activeCli = undefined;
  client?.close();
  db?.close();
  db = undefined;
  if (server) {
    await server.diagnostics(join(artifacts, 'server.private.log'));
    report.cleanup.push(await server.stop());
    server = undefined;
  }
  await cleanupDirectory(directory);
  report.cleanup.push({ temporaryDirectoryRemoved: true });
}
async function stopOnSignal() {
  await cleanup();
  report.status = 'BLOCKED';
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  process.exit(130);
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    stopping ??= stopOnSignal();
  });
async function check(name, fn) {
  const started = Date.now();
  const evidence = await fn();
  report.cases.push({ name, status: 'PASS', durationMs: Date.now() - started, evidence });
  console.log(JSON.stringify(report.cases.at(-1)));
}
function cli(args) {
  const run = exec(process.execPath, [resolve('dist/index.js'), ...args, '--config', configPath], {
    timeout: 210_000,
    maxBuffer: 1024 * 1024,
  });
  // Attach rejection immediately: a deliberately stopped worker exits nonzero.
  return {
    child: run.child,
    result: run.then(
      ({ stdout }) => ({ code: 0, value: JSON.parse(stdout) }),
      (error) => ({ code: error.code, stdout: error.stdout, error }),
    ),
  };
}
async function mustCli(args) {
  const result = await cli(args).result;
  assert.equal(result.code, 0, `CLI ${args[0]} failed (inspect private evidence)`);
  return result.value;
}
const turnStartCount = () =>
  db.prepare("SELECT count(*) FROM rpc_operations WHERE method = 'turn/start'").pluck().get();
async function create(key, text, threadId) {
  const prompt = join(directory, `${key}.txt`);
  await writeFile(prompt, text, { mode: 0o600 });
  const args = [
    'task-create',
    '--project',
    'fixture',
    '--request-key',
    key,
    '--prompt-file',
    prompt,
  ];
  if (threadId) args.push('--thread-id', threadId);
  return { args, task: await mustCli(args) };
}
const instruction =
  'This is a bounded local gateway test. Do not use tools, read files, access personal data, call connectors, browse, spawn agents, or modify configuration. ';
try {
  await check('isolated-integrations-existing-login', async () => {
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
        mcp_servers: z
          .record(z.string(), z.object({ enabled: z.boolean().optional() }))
          .default({}),
        features: z.record(z.string(), z.unknown()).default({}),
      }),
    });
    let config = await client.request(
      'config/read',
      { includeLayers: false, cwd: directory },
      schema,
    );
    const names = Object.entries(config.config.mcp_servers)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([name]) => name);
    if (names.length) {
      client.close();
      report.cleanup.push({ stage: 'discovery', ...(await server.stop()) });
      if (names.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
        throw new ProbeBlocked('Unsupported MCP name');
      extraConfig.push(...names.map((name) => `mcp_servers.${name}.enabled=false`));
      server = await startServer({
        directory,
        homeMode: 'existing',
        transport: 'unix',
        extraConfig,
      });
      client = await connectClient(server);
      config = await client.request(
        'config/read',
        { includeLayers: false, cwd: directory },
        schema,
      );
    }
    assert.equal(
      Object.values(config.config.mcp_servers).filter((entry) => entry.enabled !== false).length,
      0,
    );
    for (const feature of ['hooks', 'plugins', 'apps', 'multi_agent'])
      assert.equal(config.config.features[feature], false);
    const account = await client.request(
      'account/read',
      { refreshToken: false },
      z.object({
        account: z.object({ type: z.string() }).nullable(),
        requiresOpenaiAuth: z.boolean(),
      }),
    );
    if (!account.account && account.requiresOpenaiAuth)
      throw new ProbeBlocked('Existing login unavailable');
    await writeFile(
      configPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          dataDir,
          maxConcurrentTasks: 1,
          codex: {
            binary: report.baseline.binary,
            endpoint: server.endpoint,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
          },
          feishu: {
            appId: 'm2-fixture',
            tenantKey: 'm2-fixture',
            allowedOpenId: 'm2-fixture',
            credentialsFile: join(directory, 'unused.json'),
          },
          projects: [
            { key: 'fixture', name: 'M2 private fixture', root: directory, remoteWrite: true },
          ],
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    return {
      enabledMcpServers: 0,
      externalIntegrationsDisabled: true,
      accountAvailable: Boolean(account.account),
    };
  });
  let first;
  await check('cli-new-task-and-request-replay', async () => {
    first = await create('new', instruction + 'Reply exactly M2_NEW_OK.');
    assert.equal(first.task.status, 'queued');
    db = openGatewayDatabase(join(dataDir, 'gateway.sqlite'));
    const result = await mustCli(['worker', '--once', '--timeout', '180']);
    assert.equal(result.status, 'completed');
    first.task = await mustCli(['task', first.task.taskId, '--result']);
    assert.match(first.task.result, /M2_NEW_OK/);
    const replay = await mustCli(first.args);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.taskId, first.task.taskId);
    await mustCli(['worker', '--once']);
    assert.equal(turnStartCount(), 1);
    return {
      status: first.task.status,
      resultMatched: true,
      duplicateReturnedSameTask: true,
      turnStartCount: 1,
    };
  });
  await check('cli-continue-owned-thread', async () => {
    const next = await create(
      'continue',
      instruction + 'Reply exactly M2_CONTINUE_OK.',
      first.task.threadId,
    );
    await mustCli(['worker', '--once', '--timeout', '180']);
    const result = await mustCli(['task', next.task.taskId, '--result']);
    assert.equal(result.status, 'completed');
    assert.equal(result.threadId, first.task.threadId);
    assert.match(result.result, /M2_CONTINUE_OK/);
    assert.equal(turnStartCount(), 2);
    return { status: result.status, sameThread: true, resultMatched: true, turnStartCount: 2 };
  });
  await check('cli-worker-restart-live-turn', async () => {
    const next = await create(
      'recovery',
      instruction +
        'Write the integers 1 through 300 in order, separated by spaces, then end with M2_RECOVERY_OK.',
      first.task.threadId,
    );
    const running = cli(['worker', '--once', '--timeout', '180']);
    activeCli = running.child;
    const store = new TaskStore(db);
    let observed;
    for (let attempt = 0; attempt < 300; attempt++) {
      observed = store.get(next.task.taskId);
      if (observed.status === 'running' && observed.turn_id) break;
      if (['completed', 'failed', 'unknown'].includes(observed.status)) break;
      await delay(20);
    }
    if (observed?.status !== 'running')
      throw new ProbeBlocked('No active turn observed before restart; cannot claim live recovery');
    activeCli.kill('SIGTERM');
    const stopped = await running.result;
    activeCli = undefined;
    assert.equal(stopped.code, 130);
    assert.equal(store.get(next.task.taskId).status, 'unknown');
    assert.equal(store.diagnostics().locks, 2);
    await mustCli(['worker', '--once', '--timeout', '180']);
    const result = await mustCli(['task', next.task.taskId, '--result']);
    assert.equal(result.status, 'completed');
    assert.equal(result.turnId, observed.turn_id);
    assert.match(result.result, /M2_RECOVERY_OK/);
    assert.equal(turnStartCount(), 3);
    assert.equal(store.diagnostics().locks, 0);
    const history = await client.request(
      'thread/read',
      { threadId: result.threadId, includeTurns: true },
      threadResultSchema,
    );
    assert.equal(history.thread.turns.length, 3);
    assert(history.thread.turns.every((turn) => turn.status === 'completed'));
    return {
      interruptedState: 'running',
      disconnectedState: 'unknown',
      recoveredState: result.status,
      sameTurn: true,
      historyTurns: 3,
      turnStartCount: 3,
      locksReleased: true,
    };
  });
  await check('cli-project-discovery-and-backup-restore', async () => {
    const projects = await mustCli(['projects']);
    assert(projects.some((project) => project.key === 'fixture' && project.remoteWrite === true));
    assert(
      projects
        .filter((project) => project.source === 'codex')
        .every((project) => project.remoteWrite === false),
    );
    const sessions = await mustCli(['sessions', '--project', 'fixture']);
    assert(sessions.data.some((thread) => thread.id === first.task.threadId));
    const backup = join(artifacts, 'backup.sqlite');
    await mustCli(['db-backup', '--destination', backup]);
    const restoredDb = openGatewayDatabase(backup);
    try {
      const restored = new TaskStore(restoredDb);
      assert.equal(restored.list().length, 3);
      assert(restored.list().every((task) => task.status === 'completed'));
      assert.match(restored.result(first.task.taskId), /M2_NEW_OK/);
      assert.equal(restored.diagnostics().integrity, 'ok');
    } finally {
      restoredDb.close();
    }
    for (const file of [backup, join(dataDir, 'gateway.sqlite')])
      assert.equal((await stat(file)).mode & 0o077, 0);
    return {
      configuredProjectFound: true,
      discoveredProjectsReadOnly: true,
      threadFound: true,
      restoredTasks: 3,
      integrity: 'ok',
      privateDatabaseFiles: true,
    };
  });
  report.status = 'PASS';
} catch (error) {
  report.status = error instanceof ProbeBlocked ? 'BLOCKED' : 'FAIL';
  report.error = {
    type: error.name,
    message: 'Inspect private error file; no credentials are included in the public summary',
  };
  await writeFile(
    join(artifacts, 'error.private.json'),
    JSON.stringify({ name: error.name, message: error.message, stack: error.stack }, null, 2) +
      '\n',
    { mode: 0o600 },
  );
} finally {
  await cleanup();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ status: report.status, report: join(artifacts, 'report.json') }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
