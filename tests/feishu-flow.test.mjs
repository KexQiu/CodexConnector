import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopVault, defaultSettings } from '../src/desktop/vault.ts';
import { DesktopFeishuSetup } from '../src/desktop/feishu-setup.ts';
import { DesktopDraftCache } from '../src/desktop/draft-cache.ts';
import { FeishuSetupBackend } from '../src/feishu/setup-backend.ts';
import { stoppedStatus } from '../src/desktop/contracts.ts';
import { unchecked } from '../src/feishu/setup-contracts.ts';
import { writeJson } from '../src/service/files.ts';

let root;
const secret = 'ONLY_TEST_SECRET_NOT_A_REAL_CREDENTIAL';
const cipher = {
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString(),
};
const fields = {
  appId: 'cli_flow',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_user',
  testChatId: 'oc_chat',
};
const pair = { appId: fields.appId, appSecret: secret };
const settings = () => ({ ...defaultSettings(), feishu: fields });
const turn = () => setImmediate();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-flow-'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const vault = new DesktopVault(root, cipher);
  const backend = {
    status: stoppedStatus(),
    invoke: vi.fn(async (method, input) =>
      method === 'setupConnect'
        ? { expiresAt: Date.now() + 1800000, operationId: input.operationId, connected: true }
        : undefined,
    ),
  };
  const publish = vi.fn();
  const controller = new DesktopFeishuSetup(vault, cipher, backend, publish);
  return { vault, backend, controller, publish };
}
async function edit(controller, patch = {}) {
  const draft = controller.snapshot().draft;
  return controller.action({
    kind: 'edit',
    revision: draft.revision,
    fields,
    secret,
    name: '测试机器人',
    ...patch,
  });
}
it('keeps incomplete independent edits offline, private and recoverable without applying other pages', async () => {
  const { controller, vault, backend, publish } = fixture();
  vault.write('active', vault.prepare(settings(), secret));
  vault.write('draft', vault.prepare({ ...settings(), maxConcurrentTasks: 5 }));
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'replace' });
  await edit(controller, { fields: { ...fields, appId: 'cli_new', testChatId: '' } });
  expect(vault.read('active').settings.feishu.appId).toBe(fields.appId);
  expect(vault.read('draft').settings.maxConcurrentTasks).toBe(5);
  expect(readFileSync(join(root, 'feishu-setup.json'), 'utf8')).not.toContain(secret);
  expect(JSON.stringify(publish.mock.calls)).not.toContain(secret);
  const again = new DesktopFeishuSetup(vault, cipher, backend, () => {});
  expect(again.snapshot().draft).toMatchObject({
    step: 1,
    hasSecret: true,
    fields: { appId: 'cli_new', testChatId: '' },
  });
  expect(again.snapshot().connectionExpiresAt).toBeUndefined();
});
it('rejects a stale edit and prevents progressing without credentials or a complete binding', async () => {
  const { controller } = fixture();
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'replace' });
  await expect(controller.action({ kind: 'step', step: 2 })).rejects.toThrow();
  const old = controller.snapshot().draft.revision;
  await edit(controller, { fields: { ...fields, testChatId: '' } });
  await expect(edit(controller, { revision: old })).rejects.toThrow('配置已更新');
  await expect(controller.action({ kind: 'step', step: 4 })).rejects.toThrow();
});
it('applies only Feishu and rebases unrelated drafts, with version and stopped guards', async () => {
  const { controller, vault, backend } = fixture();
  vault.write('active', vault.prepare(settings(), secret));
  vault.write(
    'draft',
    vault.prepare({ ...settings(), maxConcurrentTasks: 7, codexBinary: '/custom/codex' }),
  );
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'credentials' });
  await edit(controller, { fields: { ...fields, testChatId: 'oc_other' } });
  const revision = controller.snapshot().draft.revision;
  expect(() => controller.finish(randomUUID(), defaultSettings())).toThrow('配置已更新');
  backend.status = { ...stoppedStatus(), phase: 'ready' };
  expect(() => controller.finish(revision, defaultSettings())).toThrow('停止');
  backend.status = stoppedStatus();
  await controller.action({ kind: 'flow-skip' });
  controller.finish(revision, defaultSettings());
  expect(vault.read('active').settings).toMatchObject({
    maxConcurrentTasks: 1,
    feishu: { testChatId: 'oc_other' },
  });
  expect(vault.read('draft').settings).toMatchObject({
    maxConcurrentTasks: 7,
    codexBinary: '/custom/codex',
    feishu: { testChatId: 'oc_other' },
  });
  expect(controller.snapshot().check.status).toBe('skipped');
  expect(controller.snapshot().draft).toBeNull();
});
it('first connection uses safe defaults instead of silently applying draft permissions', async () => {
  const { controller, vault } = fixture();
  vault.write(
    'draft',
    vault.prepare(
      {
        ...settings(),
        projects: [
          {
            key: 'test',
            name: '测试',
            root,
            remotePermissions: { mode: 'workspace-write', networkAccess: true },
          },
        ],
        maxConcurrentTasks: 8,
      },
      secret,
    ),
  );
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'resume' });
  controller.finish(controller.snapshot().draft.revision, defaultSettings());
  expect(vault.read('active').settings.projects).toEqual([]);
  expect(vault.read('active').settings.maxConcurrentTasks).toBe(1);
  expect(vault.read('draft').settings.projects).toHaveLength(1);
});
it('recovers the active/draft pair after interruption and never resurrects an old journal later', () => {
  const vault = new DesktopVault(root, cipher);
  const old = vault.prepare(settings(), secret);
  vault.write('active', old);
  const next = vault.prepare(
    { ...settings(), feishu: { ...fields, testChatId: 'oc_next' } },
    secret,
  );
  const draft = vault.prepare({ ...next.settings, maxConcurrentTasks: 6 }, secret);
  writeJson(join(root, 'feishu-commit.json'), { version: 1, active: next, draft });
  writeJson(join(root, 'active.json'), next); // Simulate power loss between file replacements.
  const recovered = new DesktopVault(root, cipher);
  expect(recovered.read('active').settings.feishu.testChatId).toBe('oc_next');
  expect(recovered.read('draft').settings.maxConcurrentTasks).toBe(6);
  expect(existsSync(join(root, 'feishu-commit.json'))).toBe(false);
  expect(new DesktopVault(root, cipher).read('draft').revision).toBe(draft.revision);
});
it('retains a pending v1 application when the new flow is resumed', async () => {
  const { vault, backend } = fixture();
  writeJson(join(root, 'feishu-setup.json'), {
    version: 1,
    pending: { appId: fields.appId, encryptedSecret: cipher.encrypt(secret) },
    tutorial: [0, 1],
    check: null,
  });
  const controller = new DesktopFeishuSetup(vault, cipher, backend, () => {});
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'resume' });
  expect(controller.snapshot().draft).toMatchObject({
    step: 2,
    hasSecret: true,
    fields: { appId: fields.appId },
  });
  expect(backend.invoke.mock.calls.some(([method]) => method === 'setupRun')).toBe(false);
});
it('bind confirmation stays local to the independent draft and suspend preserves its step', async () => {
  const { controller, vault, backend } = fixture();
  vault.write('active', vault.prepare(settings(), secret));
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'binding' });
  backend.invoke.mockImplementation(async (method, input) =>
    method === 'setupConnect'
      ? { expiresAt: Date.now() + 1800000, operationId: input.operationId, connected: true }
      : method === 'setupRun'
        ? { ...fields, testChatId: 'oc_new' }
        : undefined,
  );
  await controller.action({ kind: 'flow-bind' });
  await turn();
  await turn();
  expect(controller.snapshot().phase).toBe('confirming');
  expect(vault.read('active').settings.feishu.testChatId).toBe('oc_chat');
  await controller.action({ kind: 'confirm' });
  expect(controller.snapshot().draft.fields.testChatId).toBe('oc_new');
  await controller.action({ kind: 'suspend' });
  expect(controller.snapshot().connectionExpiresAt).toBeNull();
  expect(controller.snapshot().draft.step).toBe(3);
});
it('successful checks keep their fingerprint after scoped commit and fail after editing credentials', async () => {
  const { controller, backend } = fixture();
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'replace' });
  await edit(controller);
  backend.invoke.mockResolvedValue({ ...unchecked('passed'), checkedAt: Date.now() });
  await controller.action({ kind: 'flow-check' });
  await turn();
  await turn();
  await controller.finishConnection();
  controller.finish(controller.snapshot().draft.revision, defaultSettings());
  expect(controller.snapshot().check.status).toBe('passed');
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'credentials' });
  await edit(controller, { secret: 'NEW_TEST_SECRET' });
  expect(controller.snapshot().check.status).toBe('changed');
});
it('serializes global cache edits made during a scoped commit without restoring old Feishu fields', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const writes = [];
  const api = {
    saveDraft: async (value) => {
      writes.push(value);
      return { settings: value, hasDraft: true };
    },
  };
  const cache = new DesktopDraftCache(
    settings(),
    api,
    () => {},
    () => {},
  );
  const imported = { ...settings(), feishu: { ...fields, testChatId: 'oc_new' } };
  const applying = cache.applyFeishu(async () => {
    await gate;
    return { settings: imported, hasDraft: false };
  });
  await turn();
  cache.update({ ...settings(), maxConcurrentTasks: 4 }, secret);
  release();
  const result = await applying;
  expect(result.snapshot.settings).toMatchObject({
    maxConcurrentTasks: 4,
    feishu: { testChatId: 'oc_new' },
  });
  expect(writes.at(-1)).toEqual(result.snapshot.settings);
  cache.dispose();
});
function socketFixture() {
  let dispatcher;
  const close = vi.fn();
  const progress = vi.fn();
  const socket = vi.fn((_pair, events, emit) => {
    dispatcher = events;
    emit({ kind: 'connected', connected: true });
    return close;
  });
  const fetcher = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () =>
      url.includes('tenant_access_token')
        ? { code: 0, tenant_access_token: 'token', expire: 7200 }
        : { code: 0, data: { items: [] } },
  }));
  const backend = new FeishuSetupBackend(progress, () => false, { socket, fetcher });
  const send = (command, openId = fields.allowedOpenId) =>
    dispatcher.invoke(
      {
        schema: '2.0',
        header: {
          app_id: fields.appId,
          tenant_key: fields.tenantKey,
          event_type: 'im.message.receive_v1',
          event_id: randomUUID(),
        },
        event: {
          sender: { sender_type: 'user', sender_id: { open_id: openId } },
          message: {
            message_type: 'text',
            chat_type: 'p2p',
            chat_id: fields.testChatId,
            content: JSON.stringify({ text: command }),
          },
        },
      },
      { needCheck: false },
    );
  return { backend, close, progress, socket, fetcher, send };
}
it('separates 30-minute configuration connection and 5-minute one-use codes, ignoring old and wrong-user messages', async () => {
  vi.useFakeTimers();
  const { backend, close, progress, socket, send } = socketFixture();
  backend.openSession({ credentials: pair, operationId: randomUUID() });
  await vi.advanceTimersByTimeAsync(360000);
  expect(progress.mock.calls.some(([event]) => event.kind === 'binding')).toBe(false);
  const first = backend
    .run({ kind: 'bind', credentials: pair, operationId: randomUUID(), reuseSetup: true })
    .catch((error) => error.message);
  const old = progress.mock.calls.findLast(([event]) => event.kind === 'binding')[0].text;
  await vi.advanceTimersByTimeAsync(300000);
  expect(await first).toBe('setup:expired_token');
  expect(close).not.toHaveBeenCalled();
  const next = backend.run({
    kind: 'bind',
    credentials: pair,
    operationId: randomUUID(),
    reuseSetup: true,
    scannerOpenId: fields.allowedOpenId,
  });
  const fresh = progress.mock.calls.findLast(([event]) => event.kind === 'binding')[0].text;
  let completed = false;
  next.then(() => {
    completed = true;
  });
  await send(old);
  await send(fresh, 'ou_wrong');
  expect(completed).toBe(false);
  await send(fresh);
  expect(await next).toEqual({
    tenantKey: fields.tenantKey,
    allowedOpenId: fields.allowedOpenId,
    testChatId: fields.testChatId,
  });
  await send(fresh);
  expect(socket).toHaveBeenCalledTimes(1);
  await backend.cancel();
  expect(close).toHaveBeenCalledTimes(1);
});
it('reuses the setup connection for a read-only final check and closes it on suspend', async () => {
  const { backend, socket, close, fetcher } = socketFixture();
  backend.openSession({ credentials: pair, operationId: randomUUID() });
  const result = await backend.run({
    kind: 'check',
    credentials: { ...pair, ...fields },
    operationId: randomUUID(),
  });
  expect(result.status).toBe('passed');
  expect(result.websocket.message).toContain('已复用配置长连接');
  expect(close).not.toHaveBeenCalled();
  expect(socket).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.map(([, opts]) => opts.method)).toEqual(['POST', 'GET']);
  await backend.cancel();
  expect(close).toHaveBeenCalledTimes(1);
});
it('closes a configuration session at its own deadline and aborts any remaining binding', async () => {
  vi.useFakeTimers();
  const { backend, close, progress } = socketFixture();
  backend.openSession({ credentials: pair, operationId: randomUUID() });
  await vi.advanceTimersByTimeAsync(29 * 60000);
  const binding = backend
    .run({ kind: 'bind', credentials: pair, operationId: randomUUID(), reuseSetup: true })
    .catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await binding).toBe('setup:cancelled');
  expect(close).toHaveBeenCalledTimes(1);
  expect(progress.mock.calls.some(([event]) => event.kind === 'session-closed')).toBe(true);
  await backend.cancel();
  expect(close).toHaveBeenCalledTimes(1);
});
it('changing an existing app clears its previous binding and key until explicitly replaced', async () => {
  const { controller, vault } = fixture();
  vault.write('active', vault.prepare(settings(), secret));
  await controller.action({ kind: 'begin', mode: 'existing', intent: 'credentials' });
  await edit(controller, { fields: { ...fields, appId: 'cli_replacement' }, secret: '' });
  expect(controller.snapshot().draft).toMatchObject({
    hasSecret: false,
    platformConfirmed: false,
    fields: { appId: 'cli_replacement', tenantKey: '', allowedOpenId: '', testChatId: '' },
  });
  expect(vault.read('active').settings.feishu).toEqual(fields);
});
