import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({
  options: { runtime: { type: 'string' }, binary: { type: 'string' } },
});
const root = values.runtime ? join(resolve(values.runtime), 'backend') : resolve('src');
const extension = values.runtime ? 'js' : 'ts';
const module = (path) => import(pathToFileURL(join(root, `${path}.${extension}`)).href);
const { runDoctor, doctorMessage } = await module('cli/doctor');
const { resolveCodexBinary } = await module('codex/binary');
const { runService } = await module('service/runner');
const { readHealth, ServiceLeases } = await module('service/state');
const { privateDirectory, processAlive } = await module('service/files');
const { gatewayConfigSchema, servicePolicySchema } = await module('config/schema');
const { CodexRpcClient } = await module('codex/rpc-client');

// Run the same app-server supervisor with a private fixture, no Feishu credentials
// and no model turn. Never connect to another App's server or alter its files.
process.umask(0o077);
const binary = resolveCodexBinary(values.binary);
const doctor = await runDoctor(binary);
assert.equal(doctor.status, 'ok', doctorMessage(doctor));
const directory = await mkdtemp('/private/tmp/cc-native-startup-');
privateDirectory(directory);
const config = gatewayConfigSchema.parse({
  schemaVersion: 1,
  dataDir: directory,
  codex: {
    binary,
    endpoint: `unix://${join(directory, 'rpc.sock')}`,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  },
  feishu: {
    appId: 'cli_fixture',
    tenantKey: 'fixture',
    allowedOpenId: 'ou_fixture',
    credentialsSource: 'desktop',
  },
  projectless: { enabled: false },
  projects: [],
});
const manifest = {
  schemaVersion: 1,
  application: 'CodexConnector',
  uid: process.getuid(),
  preparedAt: new Date().toISOString(),
  configPath: join(directory, 'fixture-owned'),
  configHash: '',
  dataDir: directory,
  node: process.execPath,
  binary: await realpath(binary),
  entry: process.argv[1],
  buildHash: '',
  codexHome: await realpath(process.env.CODEX_HOME ?? join(homedir(), '.codex')),
  policy: servicePolicySchema.parse({}),
  plistHashes: { 'app-server': '', gateway: '' },
};
const controller = new globalThis.AbortController();
const owned = new Set();
let failure;
const operation = runService(manifest, 'app-server', {
  desktop: true,
  signal: controller.signal,
  validate: () => Promise.resolve(config),
  onChild: (pid) => {
    if (pid) owned.add(pid);
  },
}).catch((error) => {
  failure = error;
  return 1;
});
let result;
try {
  const deadline = Date.now() + 35_000;
  while (!readHealth(directory, 'app-server').ready && Date.now() < deadline && !failure)
    await delay(100);
  if (failure) throw failure;
  assert.equal(
    readHealth(directory, 'app-server').ready,
    true,
    'App Server isolation/readiness check failed',
  );
  const rpc = new CodexRpcClient({ endpoint: config.codex.endpoint });
  try {
    await rpc.connect();
    // The supervisor has already asserted effective hooks/plugins/apps/agents/MCP isolation.
    const { z } = await import('zod');
    const account = await rpc.request(
      'account/read',
      { refreshToken: false },
      z.object({ account: z.unknown().nullable() }),
      5000,
    );
    result = {
      codex: doctor.checks.codex.actual,
      compatibility: doctor.checks.codex.status,
      ready: true,
      loginAvailable: account.account !== null,
      feishuConnected: false,
      modelTasks: 0,
    };
  } finally {
    rpc.close();
  }
} finally {
  controller.abort();
  const exit = await operation;
  const leases = new ServiceLeases(directory);
  try {
    assert.equal(exit, 0, 'Owned supervisor cleanup was not confirmed');
    assert.equal(leases.active().length, 0, 'Owned lease/child survived cleanup');
    assert.equal([...owned].some(processAlive), false, 'Owned child survived cleanup');
  } finally {
    leases.close();
  }
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...result, ownedChildrenExited: true }));
