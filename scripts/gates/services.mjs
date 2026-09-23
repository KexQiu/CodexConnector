import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/schema.ts';
import { labels, readManifest, validateManifest, digest } from '../../src/service/plan.ts';
import { ServiceLeases, roles } from '../../src/service/state.ts';
import { privateDirectory, readPrivate, writeJson } from '../../src/service/files.ts';

const { values } = parseArgs({
  options: { live: { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean' } },
});
if (!values.live || !values.config || values.help) {
  console.log(
    'pnpm gate:services --live --config /absolute/config.json\n要求服务已安装、就绪、所有项目只读且没有任务。仅对清单匹配的两个 LaunchAgent 注入故障，测试顺序独立性、重启、卸载重装、备份恢复。结束恢复常驻服务；不提交模型任务、不操作 GUI，不代表 24 小时或睡眠/网络验收通过。',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const exec = promisify(execFile);
const config = await loadConfig(values.config),
  manifest = readManifest(config.dataDir);
await validateManifest(manifest);
assert(
  config.projects.every((project) => !project.remoteWrite),
  'Probe requires readonly projects',
);
const runId =
  new Date().toISOString().replaceAll(':', '-') + '-services-' + randomUUID().slice(0, 8);
const directory = resolve('.artifacts/m5', runId);
privateDirectory(directory);
const report = {
  runId,
  status: 'RUNNING',
  startedAt: new Date().toISOString(),
  checks: {},
  limitations: [
    'No model task is submitted. Prior M4 task recovery and isolated M5 WAL tests cover task state.',
    'User login, network switching, lock/sleep/wake and 24-hour supervised trial remain pending.',
  ],
};
const save = () => writeJson(join(directory, 'report.json'), report);
const cli = async (command, args = [], allowed = [0]) => {
  let stdout,
    code = 0;
  try {
    ({ stdout } = await exec(
      manifest.node,
      [manifest.entry, command, '--config', values.config, ...args],
      { timeout: 90_000, maxBuffer: 64 * 1024 },
    ));
  } catch (error) {
    code = error.code;
    stdout = error.stdout;
    if (!allowed.includes(code))
      throw new Error(`Service command ${command} failed`, { cause: error });
  }
  return { code, data: stdout?.trim() ? JSON.parse(stdout) : null };
};
const snapshot = async () => (await cli('service-status', [], [0, 2])).data;
const waitFor = async (predicate, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (predicate(state)) return state;
    await delay(1000);
  }
  throw new Error('Managed service did not reach the expected health state');
};
const installed = (role) => join(homedir(), 'Library', 'LaunchAgents', `${labels[role]}.plist`);
const target = (role) => `gui/${process.getuid()}/${labels[role]}`;
async function owned(role) {
  assert.equal(digest(readPrivate(installed(role))), manifest.plistHashes[role]);
  const { stdout } = await exec('/bin/launchctl', ['print', target(role)]);
  assert(stdout.split('\n').some((line) => line.trim() === `path = ${installed(role)}`));
}
async function launch(args) {
  await exec('/bin/launchctl', args, { timeout: 70_000 });
}
const check = (name, details = {}) => {
  report.checks[name] = { status: 'PASS', at: new Date().toISOString(), ...details };
  save();
  console.log(JSON.stringify({ check: name, status: 'PASS' }));
};
let authorizedToRecover = false;
save();
try {
  const initial = await snapshot();
  assert(initial.ready && initial.feishuConnected);
  assert.deepEqual(
    initial.database.statuses,
    [],
    'Task database must be empty before fault injection',
  );
  assert.equal(initial.database.locks, 0);
  for (const role of roles) await owned(role);
  authorizedToRecover = true;
  check('real-start-ready-and-feishu', { snapshot: initial });
  for (const role of roles) {
    const duplicate = await cli('service-run', [role], [1]);
    assert.equal(duplicate.code, 1);
  }
  check('duplicate-supervisors-rejected');
  // Stop only the managed App Server. Gateway must remain connected to Feishu.
  await launch(['bootout', target('app-server')]);
  const degraded = await waitFor(
    (s) =>
      !s.components.appServer.healthy &&
      s.components.gateway.healthy &&
      !s.components.gateway.rpcReady &&
      s.feishuConnected,
  );
  check('gateway-survives-upstream-offline', { snapshot: degraded });
  await launch(['bootstrap', `gui/${process.getuid()}`, installed('app-server')]);
  await waitFor((s) => s.ready);
  check('rpc-reconnect-with-gateway-started-first');
  const leases = new ServiceLeases(config.dataDir);
  let child;
  try {
    child = leases.active().find((row) => row.role === 'app-server')?.child_pid;
  } finally {
    leases.close();
  }
  assert(Number.isInteger(child));
  const { stdout: command } = await exec('/bin/ps', ['-p', String(child), '-o', 'command=']);
  assert(command.startsWith(`${manifest.binary} app-server --listen ${config.codex.endpoint}`));
  const beforeChild = await snapshot();
  process.kill(child, 'SIGKILL');
  await waitFor((s) => {
    const current = new ServiceLeases(config.dataDir);
    try {
      const pid = current.active().find((row) => row.role === 'app-server')?.child_pid;
      return (
        s.ready &&
        s.components.appServer.pid === beforeChild.components.appServer.pid &&
        pid &&
        pid !== child
      );
    } finally {
      current.close();
    }
  });
  check('owned-codex-child-crash-recovered');
  for (const role of roles) {
    await owned(role);
    const before = await snapshot(),
      key = role === 'app-server' ? 'appServer' : 'gateway';
    await launch(['kill', 'SIGKILL', target(role)]);
    await waitFor((s) => s.ready && s.components[key].pid !== before.components[key].pid);
    check(`${role}-launchd-crash-recovered`);
  }
  const maintenance = (await cli('service-maintain')).data;
  assert.equal(maintenance.integrity, 'ok');
  const restored = (
    await cli('service-restore-check', [
      '--backup',
      maintenance.backup,
      '--destination',
      join(directory, 'restored.sqlite'),
    ])
  ).data;
  assert.equal(restored.integrity, 'ok');
  assert.equal(restored.scope, 'offline-copy-only');
  check('online-backup-and-offline-restore', { maintenance, restored });
  const credentialsHash = digest(readFileSync(config.feishu.credentialsFile));
  await cli('service-stop');
  assert(!(await snapshot()).healthy);
  await cli('service-start');
  await waitFor((s) => s.ready);
  check('stop-start');
  await cli('service-uninstall');
  for (const role of roles) assert(!existsSync(installed(role)));
  assert(existsSync(join(config.dataDir, 'gateway.sqlite')));
  assert.equal(digest(readFileSync(config.feishu.credentialsFile)), credentialsHash);
  await cli('service-install');
  const final = await waitFor((s) => s.ready);
  assert.deepEqual(final.database.statuses, []);
  check('uninstall-retains-data-and-reinstall', { snapshot: final });
  for (const path of [
    values.config,
    config.feishu.credentialsFile,
    join(config.dataDir, 'gateway.sqlite'),
    join(config.dataDir, 'gateway.sqlite-wal'),
    join(config.dataDir, 'gateway.sqlite-shm'),
    join(config.dataDir, 'app-server.sock'),
    ...roles.map(installed),
  ])
    assert.equal(lstatSync(path).mode & 0o777, 0o600, 'Private file permissions');
  check('config-credentials-wal-shm-socket-plist-private');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error =
    error instanceof assert.AssertionError
      ? error.message.slice(0, 500)
      : 'Service lifecycle check failed; inspect local health/state logs';
  process.exitCode = 1;
} finally {
  if (authorizedToRecover) {
    try {
      await cli('service-install');
      await waitFor((s) => s.ready);
      report.recovery = 'managed-services-ready';
    } catch {
      report.recovery = 'requires-local-check';
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(directory, 'report.json'),
      recovery: report.recovery,
    }),
  );
}
