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
vi.mock('../src/cli/doctor.ts', () => ({
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
let root, runtime, oldHome, input;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.events = [];
  fixture.ready = false;
  fixture.loaded.mockReturnValue(false);
  fixture.doctor.mockResolvedValue({ status: 'ok' });
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
