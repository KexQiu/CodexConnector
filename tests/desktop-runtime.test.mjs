import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  loaded: vi.fn(() => false),
  doctor: vi.fn(),
  run: vi.fn(),
  readHealth: vi.fn(),
  events: [],
  ready: false,
  delayDoctor: null,
}));
vi.mock('../src/cli/service.ts', () => ({ loaded: fixture.loaded }));
vi.mock('../src/cli/doctor.ts', async (original) => ({
  ...(await original()),
  runDoctor: fixture.doctor,
  inspectTaskDatabase: () => ({ statuses: [] }),
}));
vi.mock('../src/service/runner.ts', () => ({ runService: fixture.run }));
vi.mock('../src/service/state.ts', async (original) => ({
  ...(await original()),
  readHealth: fixture.readHealth,
}));
vi.mock('../src/codex/rpc-client.ts', () => ({
  CodexRpcClient: class {
    async connect() {}
    async request() {
      return { account: { type: 'chatgpt' } };
    }
    close() {}
  },
}));
import { DesktopRuntime } from '../src/desktop/runtime.ts';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { migrationSources, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
let root, runtime, oldHome, input;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.events = [];
  fixture.ready = false;
  fixture.loaded.mockReturnValue(false);
  fixture.doctor.mockResolvedValue({ status: 'ok', codexBinary: process.execPath });
  fixture.readHealth.mockImplementation((_dir, role) => ({
    ready: fixture.ready,
    rpcReady: fixture.ready,
    feishuConnected: role === 'gateway' && fixture.events.includes('gateway:start'),
  }));
  fixture.run.mockImplementation(async (_manifest, role, options) => {
    fixture.events.push(`${role}:start`);
    fixture.ready = true;
    await new Promise((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener('abort', resolve, { once: true });
    });
    fixture.events.push(`${role}:stop`);
    return 0;
  });
  root = mkdtempSync(join(tmpdir(), 'cc-runtime-'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'home');
  const identity = {
    appId: `cli_${root.split('-').pop()}`,
    tenantKey: 'tenant',
    allowedOpenId: 'ou_test',
    testChatId: 'oc_test',
  };
  input = {
    settings: { codexBinary: process.execPath, feishu: identity, projects: [] },
    dataDir: join(root, 'runtime'),
    credentials: { ...identity, appSecret: 'test-secret' },
  };
  runtime = new DesktopRuntime();
});
afterEach(async () => {
  await runtime.stop();
  if (oldHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});
it('starts once, shuts gateway down before its Codex backend, and tolerates repeated stop', async () => {
  await runtime.start(input);
  await expect(runtime.start(input)).rejects.toThrow('已启动');
  await Promise.all([runtime.stop(), runtime.stop()]);
  expect(fixture.events).toEqual([
    'app-server:start',
    'gateway:start',
    'gateway:stop',
    'app-server:stop',
  ]);
  expect(runtime.status().phase).toBe('stopped');
});
it('does not start any child when legacy services are loaded', async () => {
  fixture.loaded.mockReturnValue(true);
  await expect(runtime.start(input)).rejects.toThrow('LaunchAgent');
  expect(fixture.run).not.toHaveBeenCalled();
});
it('starts with a disconnected disabled project while retaining its configuration', async () => {
  const project = {
    key: 'offline',
    name: 'Disconnected volume',
    root: join(root, 'unmounted'),
    remotePermissions: { mode: 'disabled', networkAccess: false },
  };
  input.settings.projects = [project];
  await runtime.start(input);
  expect(fixture.events).toEqual(['app-server:start', 'gateway:start']);
  expect(input.settings.projects).toEqual([project]);
});
it('rejects an unavailable authorized project before the doctor or services are started', async () => {
  input.settings.projects = [
    {
      key: 'offline',
      name: 'Disconnected volume',
      root: join(root, 'unmounted'),
      remotePermissions: { mode: 'read-only', networkAccess: false },
    },
  ];
  await expect(runtime.start(input)).rejects.toThrow('Disconnected volume');
  expect(fixture.doctor).not.toHaveBeenCalled();
  expect(fixture.run).not.toHaveBeenCalled();
});
it('cancels startup on parent disconnect even while version inspection is pending', async () => {
  let release;
  fixture.doctor.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const starting = runtime.start(input);
  const stopped = runtime.stop();
  release({ status: 'ok' });
  await expect(starting).rejects.toThrow('启动已取消');
  await stopped;
  expect(fixture.run).not.toHaveBeenCalled();
});
it('does not terminate an independent process or use a name-based kill', async () => {
  const kill = vi.spyOn(process, 'kill');
  await runtime.start(input);
  await runtime.stop();
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});
it('keeps failed cleanup unresolved and permits a later stop once the owned group is absent', async () => {
  fixture.run.mockImplementation(async (_manifest, role, options) => {
    fixture.ready = true;
    if (role === 'app-server') options.onChild(2147483000);
    await new Promise((resolve) =>
      options.signal.addEventListener('abort', resolve, { once: true }),
    );
    return role === 'app-server' ? 1 : 0;
  });
  await runtime.start(input);
  await expect(runtime.stop()).rejects.toThrow('清理尚未确认');
  expect(runtime.status().phase).toBe('error');
  await runtime.stop();
  expect(runtime.status().phase).toBe('stopped');
});

it('starts the resolved executable while preserving the saved input and data profile', async () => {
  input.settings.codexBinary = '/Applications/ChatGPT.app/Contents/Resources/codex';
  await runtime.start(input);
  expect(fixture.run.mock.calls[0][0].binary).toBe(process.execPath);
  expect(fixture.run.mock.calls[0][0].dataDir).toBe(input.dataDir);
  expect(input.settings.codexBinary).toBe('/Applications/ChatGPT.app/Contents/Resources/codex');
});
it('reports an incompatible contract before starting either service', async () => {
  fixture.doctor.mockResolvedValue({
    status: 'incompatible',
    checks: { node: { ok: true }, codex: { ok: false, message: '核心协议不兼容：turn/interrupt' } },
  });
  await expect(runtime.start(input)).rejects.toThrow('核心协议不兼容：turn/interrupt');
  expect(fixture.run).not.toHaveBeenCalled();
});

it('checks upgrades before services start and releases the identity lock when preparation fails', async () => {
  mkdirSync(input.dataDir, { mode: 0o700 });
  const db = openGatewayDatabase(join(input.dataDir, 'gateway.sqlite'));
  try {
    for (const migration of migrationSources().slice(0, 9)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
        migration.version,
        migration.checksum,
      );
      db.pragma(`user_version=${migration.version}`);
    }
    db.prepare('INSERT INTO worker_lease VALUES (1,?,?)').run('live-worker', process.pid);
    await expect(runtime.start(input)).rejects.toThrow('无法确认旧进程已退出');
    expect(fixture.run).not.toHaveBeenCalled();
    expect(runtime.status().phase).toBe('stopped');
    db.prepare('DELETE FROM worker_lease').run();
    await runtime.start(input);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(fixture.events).toEqual(['app-server:start', 'gateway:start']);
  } finally {
    db.close();
  }
});
