import { setImmediate } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireFeishuAppLock, acquireFeishuSetupLock } from '../src/feishu/app-lock.ts';
import { ServiceLeases } from '../src/service/state.ts';
import { createHash } from 'node:crypto';
import { FeishuSetupBackend, acceptBinding } from '../src/feishu/setup-backend.ts';
import {
  FEISHU_SETUP_MANIFEST,
  assertAuthorizationUrl,
  unchecked,
} from '../src/feishu/setup-contracts.ts';
import { DesktopFeishuSetup } from '../src/desktop/feishu-setup.ts';
import { DesktopVault, defaultSettings } from '../src/desktop/vault.ts';
import { stoppedStatus } from '../src/desktop/contracts.ts';
import { DesktopDraftCache } from '../src/desktop/draft-cache.ts';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';

let root;
const pair = { appId: 'cli_test', appSecret: 'PRIVATE_ONBOARDING_SECRET' };
const binding = { tenantKey: 'tenant', allowedOpenId: 'ou_user', testChatId: 'oc_chat' };
const credentials = { ...pair, ...binding };
const cipher = {
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString(),
};
const settings = () => ({ ...defaultSettings(), feishu: { appId: pair.appId, ...binding } });
const turn = () => setImmediate();
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function message(text, overrides = {}) {
  return {
    event_id: randomUUID(),
    app_id: pair.appId,
    tenant_key: binding.tenantKey,
    sender: { sender_type: 'user', sender_id: { open_id: binding.allowedOpenId } },
    message: {
      message_id: 'om_fixture',
      chat_id: binding.testChatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
    ...overrides,
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-onboarding-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('F0 installed SDK registration contract', () => {
  const begin = {
    device_code: 'private_device',
    verification_uri_complete: 'https://accounts.feishu.cn/setup?user_code=test',
    expires_in: 60,
    interval: 1,
  };
  it('uses createOnly and the minimal manifest; returns credentials only over the private result', async () => {
    vi.spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce(begin)
      .mockResolvedValueOnce({
        client_id: pair.appId,
        client_secret: pair.appSecret,
        user_info: { open_id: binding.allowedOpenId, tenant_brand: 'feishu' },
      });
    const progress = vi.fn();
    const backend = new FeishuSetupBackend(progress);
    const result = await backend.run({
      kind: 'register',
      mode: 'create',
      name: '测试机器人',
      operationId: randomUUID(),
    });
    expect(result).toEqual({ ...pair, scannerOpenId: binding.allowedOpenId });
    const qr = progress.mock.calls.find(([event]) => event.kind === 'qr')[0];
    const url = new URL(qr.url);
    expect(url.searchParams.get('createOnly')).toBe('true');
    const addons = JSON.parse(
      gunzipSync(Buffer.from(url.searchParams.get('addons'), 'base64url')).toString(),
    );
    expect(addons.preset).toBe(false);
    expect(addons.scopes.tenant).toEqual(FEISHU_SETUP_MANIFEST.scopes.tenant);
    expect(addons.events.items.tenant).toEqual(['im.message.receive_v1']);
    expect(addons.callbacks.items).toEqual(['card.action.trigger']);
    expect(JSON.stringify(progress.mock.calls)).not.toContain(pair.appSecret);
  });
  it.each(['access_denied', 'expired_token'])(
    'keeps the platform %s outcome distinct',
    async (code) => {
      vi.spyOn(defaultHttpInstance, 'post')
        .mockResolvedValueOnce(begin)
        .mockResolvedValueOnce({ error: code });
      const backend = new FeishuSetupBackend(() => {});
      await expect(
        backend.run({ kind: 'register', mode: 'create', name: '测试', operationId: randomUUID() }),
      ).rejects.toThrow(`setup:${code}`);
    },
  );
  it('pins an existing app and rejects a mismatched result', async () => {
    const progress = vi.fn();
    vi.spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce(begin)
      .mockResolvedValueOnce({ client_id: 'cli_another', client_secret: pair.appSecret });
    const backend = new FeishuSetupBackend(progress);
    await expect(
      backend.run({
        kind: 'register',
        mode: 'existing',
        name: '测试',
        appId: pair.appId,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow('setup:identity');
    const url = new URL(progress.mock.calls[0][0].url);
    expect(url.searchParams.get('clientID')).toBe(pair.appId);
    expect(url.searchParams.has('createOnly')).toBe(false);
  });
  it('cancels a late begin result without exposing a new QR or polling again', async () => {
    const gate = deferred();
    const progress = vi.fn();
    const post = vi.spyOn(defaultHttpInstance, 'post').mockReturnValue(gate.promise);
    const backend = new FeishuSetupBackend(progress);
    const run = backend
      .run({ kind: 'register', mode: 'create', name: '测试', operationId: randomUUID() })
      .catch((error) => error.message);
    await backend.cancel();
    expect(await run).toBe('setup:cancelled');
    gate.resolve(begin);
    await turn();
    await turn();
    expect(progress).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('does not continue on a Lark domain switch', async () => {
    vi.spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce(begin)
      .mockResolvedValue({ user_info: { tenant_brand: 'lark' } });
    const backend = new FeishuSetupBackend(() => {});
    await expect(
      backend.run({ kind: 'register', mode: 'create', name: '测试', operationId: randomUUID() }),
    ).rejects.toThrow('setup:region');
  });
  it('backs off on rate limiting and allows cancellation during polling', async () => {
    vi.useFakeTimers();
    const post = vi
      .spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce(begin)
      .mockResolvedValue({ error: 'slow_down' });
    const progress = vi.fn();
    const backend = new FeishuSetupBackend(progress);
    const run = backend
      .run({ kind: 'register', mode: 'create', name: '测试', operationId: randomUUID() })
      .catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(progress.mock.calls.some(([value]) => value.message?.includes('限流'))).toBe(true);
    await vi.advanceTimersByTimeAsync(5999);
    expect(post).toHaveBeenCalledTimes(2);
    await backend.cancel();
    await run;
    await vi.advanceTimersByTimeAsync(6001);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('binding and connection isolation', () => {
  it('accepts only the pinned human, app, p2p and live code', () => {
    const command = '/connector-bind random';
    const expiry = Date.now() + 300000;
    expect(
      acceptBinding(message(command), pair.appId, command, expiry, binding.allowedOpenId),
    ).toEqual(binding);
    expect(acceptBinding(message(command), pair.appId, command, expiry, 'ou_other')).toBeNull();
    expect(acceptBinding(message(command), 'cli_other', command, expiry)).toBeNull();
    expect(acceptBinding(message(command), pair.appId, command, Date.now() - 1)).toBeNull();
    for (const change of [
      { chat_type: 'group' },
      { message_type: 'image' },
      { content: 'invalid json' },
      { content: JSON.stringify({ text: '/connector-bind wrong' }) },
    ]) {
      const event = message(command);
      Object.assign(event.message, change);
      expect(acceptBinding(event, pair.appId, command, expiry)).toBeNull();
    }
    const bot = message(command);
    bot.sender.sender_type = 'app';
    expect(acceptBinding(bot, pair.appId, command, expiry)).toBeNull();
  });
  it('never dispatches binding commands to the normal task inbox, including expired replays', () => {
    const db = openGatewayDatabase(join(root, 'tasks.sqlite'));
    try {
      const store = new TaskStore(db);
      const inbox = new FeishuInbox(store, credentials);
      for (const command of [
        '/connector-bind obsolete',
        ' /connector-bind',
        '/CONNECTOR-BIND repeated',
      ])
        expect(inbox.receive('message', message(command)).outcome).toBe('ignored');
      expect(db.prepare('SELECT COUNT(*) FROM inbox').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
  it('shares an app lock across profiles and releases only its own connection', () => {
    const release = acquireFeishuAppLock(pair.appId, root);
    expect(() => acquireFeishuAppLock(pair.appId, root)).toThrow('已有本机连接');
    const other = acquireFeishuAppLock('cli_other', root);
    other();
    release();
    release();
    const next = acquireFeishuAppLock(pair.appId, root);
    next();
  });
  it('also respects the existing desktop gateway lease used by older builds', () => {
    const appId = `cli_test${randomUUID().replaceAll('-', '')}`;
    const key = createHash('sha256').update(appId).digest('hex').slice(0, 24);
    const directory = `/private/tmp/cc-${process.getuid()}/${key}`;
    const leases = new ServiceLeases(directory);
    const token = leases.acquire('gateway');
    try {
      expect(() => acquireFeishuSetupLock(appId)).toThrow('拒绝抢占');
    } finally {
      leases.release(token);
      leases.close();
    }
    const release = acquireFeishuSetupLock(appId);
    release();
    rmSync(directory, { recursive: true, force: true });
  });
  it('rejects a symlink lock store and arbitrary authorization URLs', () => {
    symlinkSync(join(root, 'victim'), join(root, 'connections.sqlite'));
    expect(() => acquireFeishuAppLock(pair.appId, root)).toThrow();
    for (const url of [
      'https://evil.test',
      'https://accounts.feishu.cn.evil.test',
      'https://user@accounts.feishu.cn',
      'file:///tmp/test',
      'https://accounts.feishu.cn:8443',
    ])
      expect(() => assertAuthorizationUrl(url)).toThrow();
  });
});

describe('F3 checks do not send messages or construct task execution', () => {
  function fixture(ready = true) {
    const close = vi.fn();
    const fetcher = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('tenant_access_token')
          ? { code: 0, tenant_access_token: 'token', expire: 7200 }
          : { code: 0, data: { has_more: false } },
    }));
    const socket = vi.fn((_credentials, _dispatcher, emit) => {
      if (ready) emit({ kind: 'connected', connected: true });
      return close;
    });
    return {
      backend: new FeishuSetupBackend(
        () => {},
        () => true,
        { socket, fetcher },
      ),
      close,
      fetcher,
      socket,
    };
  }
  it('checks token, one history page and WS handshake then closes', async () => {
    const { backend, close, fetcher } = fixture();
    const result = await backend.run({ kind: 'check', credentials, operationId: randomUUID() });
    expect(result.status).toBe('passed');
    expect(close).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([, args]) => args.method)).toEqual(['POST', 'GET']);
    expect(fetcher.mock.calls[1][0]).toContain('page_size=1');
    expect(JSON.stringify(result)).not.toContain('token');
  });
  it('reuses a verified current connection and skips creating a second socket', async () => {
    const { backend, socket } = fixture();
    expect(
      (
        await backend.run({
          kind: 'check',
          credentials,
          reuseConnection: true,
          operationId: randomUUID(),
        })
      ).status,
    ).toBe('passed');
    expect(socket).not.toHaveBeenCalled();
  });
  it('closes a diagnostic socket when cancelled or timed out', async () => {
    vi.useFakeTimers();
    const { backend, close } = fixture(false);
    const result = backend.run({ kind: 'check', credentials, operationId: randomUUID() });
    await vi.advanceTimersByTimeAsync(30000);
    expect((await result).status).toBe('failed');
    expect(close).toHaveBeenCalledOnce();
    const again = backend.run({ kind: 'check', credentials, operationId: randomUUID() });
    await vi.advanceTimersByTimeAsync(0);
    await backend.cancel();
    expect((await again).status).toBe('failed');
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('reports missing permissions and does not send any messages', async () => {
    const fetcher = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () =>
        url.includes('tenant_access_token')
          ? { code: 0, tenant_access_token: 'token', expire: 7200 }
          : { code: 99991672 },
    }));
    const close = vi.fn();
    const backend = new FeishuSetupBackend(
      () => {},
      () => false,
      {
        fetcher,
        socket: (_c, _d, emit) => {
          emit({ kind: 'connected', connected: true });
          return close;
        },
      },
    );
    const result = await backend.run({ kind: 'check', credentials, operationId: randomUUID() });
    expect(result.status).toBe('failed');
    expect(result.history.message).toContain('99991672');
    expect(result.credentials.status).toBe('passed');
    expect(result.websocket.status).toBe('passed');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('encrypted setup persistence and cache races', () => {
  function fixture() {
    const gate = deferred();
    const backend = {
      status: stoppedStatus(),
      invoke: vi.fn((method) => (method === 'setupRun' ? gate.promise : Promise.resolve())),
    };
    const vault = new DesktopVault(root, cipher);
    const publish = vi.fn();
    const controller = new DesktopFeishuSetup(vault, cipher, backend, publish);
    return { gate, backend, vault, controller, publish };
  }
  it('persists credentials before binding and restores without re-registering', async () => {
    const { gate, backend, vault, controller, publish } = fixture();
    const result = await controller.action({ kind: 'register', mode: 'create', name: '测试' });
    expect(result.phase).toBe('authorizing');
    await expect(
      controller.action({ kind: 'register', mode: 'create', name: '测试' }),
    ).rejects.toThrow('进行中');
    gate.resolve(pair);
    await turn();
    await turn();
    expect(readFileSync(join(root, 'feishu-setup.json'), 'utf8')).not.toContain(pair.appSecret);
    expect(JSON.stringify(publish.mock.calls)).not.toContain(pair.appSecret);
    const reopened = new DesktopFeishuSetup(vault, cipher, backend, () => {});
    expect(reopened.snapshot()).toMatchObject({
      phase: 'pending',
      appId: pair.appId,
      hasPending: true,
    });
    expect(backend.invoke).toHaveBeenCalledTimes(1);
  });
  it('discards late registration results after cancellation', async () => {
    const { gate, controller } = fixture();
    await controller.action({ kind: 'register', mode: 'create', name: '测试' });
    const cancelled = controller.cancel();
    gate.resolve(pair);
    await cancelled;
    expect(controller.snapshot().hasPending).toBe(false);
  });
  it('fails before registration when Keychain is unavailable', async () => {
    const { vault, backend } = fixture();
    const controller = new DesktopFeishuSetup(
      vault,
      {
        ...cipher,
        encrypt() {
          throw new Error('Keychain unavailable');
        },
      },
      backend,
      () => {},
    );
    await expect(
      controller.action({ kind: 'register', mode: 'create', name: '测试' }),
    ).rejects.toThrow('Keychain');
    expect(backend.invoke).not.toHaveBeenCalled();
  });
  it('waits for cancellation and cleanup before recording a skipped check', async () => {
    const { gate, backend, vault, controller } = fixture();
    const cleanup = deferred();
    vault.write('draft', vault.prepare(settings(), pair.appSecret));
    await controller.action({ kind: 'check' });
    backend.invoke.mockImplementation((method) =>
      method === 'setupCancel' ? cleanup.promise : gate.promise,
    );
    let done = false;
    const skip = controller.action({ kind: 'skip' }).then(() => {
      done = true;
    });
    await turn();
    expect(done).toBe(false);
    gate.resolve(unchecked('passed'));
    cleanup.resolve();
    await skip;
    expect(controller.snapshot().check.status).toBe('skipped');
  });
  it('keeps existing bindings until an explicit bind and local confirmation', async () => {
    const { gate, vault, controller } = fixture();
    vault.write('draft', vault.prepare(settings(), pair.appSecret));
    await controller.action({ kind: 'use-existing' });
    expect(controller.snapshot().phase).toBe('bound');
    await controller.action({ kind: 'bind' });
    gate.resolve({ ...binding, testChatId: 'oc_new' });
    await turn();
    await turn();
    expect(controller.snapshot().phase).toBe('confirming');
    expect(vault.read('draft').settings.feishu.testChatId).toBe('oc_chat');
    await controller.action({ kind: 'confirm' });
    expect(() => controller.merge(randomUUID())).toThrow('草稿已更新');
    controller.merge(vault.read('draft').revision);
    expect(vault.read('draft').settings.feishu.testChatId).toBe('oc_new');
    expect(controller.snapshot().hasPending).toBe(false);
  });
  it('records skip separately and invalidates a previous check after secret replacement', async () => {
    const { gate, vault, controller } = fixture();
    vault.write('draft', vault.prepare(settings(), pair.appSecret));
    await controller.action({ kind: 'check' });
    const passed = unchecked('passed');
    passed.checkedAt = Date.now();
    gate.resolve(passed);
    await turn();
    await turn();
    expect(controller.snapshot().check.status).toBe('passed');
    vault.write('draft', vault.prepare(settings(), 'replacement'));
    expect(controller.snapshot().check.status).toBe('changed');
    await controller.action({ kind: 'skip' });
    expect(controller.snapshot().check.status).toBe('skipped');
    expect(controller.snapshot().message).toContain('未验证');
  });
  it('preserves project edits made while imported credentials are being merged', async () => {
    const vault = new DesktopVault(root, cipher);
    const imported = { ...settings(), feishu: { appId: 'cli_new', ...binding } };
    const gate = deferred();
    const api = {
      saveDraft: async (value, secret) => {
        vault.write('draft', vault.prepare(value, secret));
        return { settings: value };
      },
    };
    const cache = new DesktopDraftCache(
      defaultSettings(),
      api,
      () => {},
      () => {},
    );
    cache.update(settings(), pair.appSecret);
    const merge = cache.mergeFeishu(async () => {
      await gate.promise;
      vault.write('draft', vault.prepare(imported, 'NEW_PRIVATE_SECRET'));
      return { settings: imported };
    });
    await turn();
    await turn();
    cache.update({ ...settings(), maxConcurrentTasks: 5 }, pair.appSecret);
    gate.resolve();
    const result = await merge;
    expect(result.snapshot.settings.maxConcurrentTasks).toBe(5);
    expect(vault.read('draft').settings.feishu.appId).toBe('cli_new');
    expect(vault.credentials(imported).appSecret).toBe('NEW_PRIVATE_SECRET');
    cache.dispose();
  });
});

it('private backend cancels registration and exits when its parent disconnects', async () => {
  const entry = new URL('../src/desktop/entry.ts', import.meta.url).href;
  const program = `import {defaultHttpInstance} from '@larksuiteoapi/node-sdk';
    defaultHttpInstance.post=async(_url,body)=>new URLSearchParams(body).get('action')==='begin'
      ? {device_code:'fixture',verification_uri_complete:'https://accounts.feishu.cn/test',expires_in:600,interval:5}
      : {error:'authorization_pending'};
    await import(${JSON.stringify(entry)}); process.send({ready:true});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let timer;
  try {
    const ready = await once(child, 'message');
    expect(ready[0].ready).toBe(true);
    const progress = once(child, 'message');
    child.send({
      id: 1,
      method: 'setupRun',
      args: { kind: 'register', mode: 'create', name: 'Fixture', operationId: randomUUID() },
    });
    expect((await progress)[0].value.kind).toBe('qr');
    const exit = once(child, 'exit');
    child.disconnect();
    await Promise.race([
      exit,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('backend did not exit')), 3000);
      }),
    ]);
    expect(child.exitCode).toBe(0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
