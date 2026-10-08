import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCipher } from '../src/desktop/native-cipher.js';
import { NativeController, type NativeBackend } from '../src/desktop/native-controller.js';
import { defaultSettings } from '../src/desktop/vault.js';
import { stoppedStatus, type DesktopStatus } from '../src/desktop/contracts.js';
import { desktopError } from '../src/desktop/ui-error.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-controller-'));
  roots.push(root);
  const calls: { method: string; args: unknown }[] = [];
  const backend: NativeBackend = {
    status: stoppedStatus(),
    connected: true,
    onSetup: undefined,
    invoke<T>(method: string, args?: unknown): Promise<T> {
      calls.push({ method, args });
      return Promise.resolve(
        (method === 'status' ? backend.status : method === 'stop' ? stoppedStatus() : {}) as T,
      );
    },
    close() {
      calls.push({ method: 'close', args: null });
      return Promise.resolve();
    },
  };
  const controller = new NativeController(
    root,
    nativeCipher(Buffer.alloc(32, 9)),
    backend,
    () => {},
  );
  const settings = {
    ...defaultSettings(),
    codexBinary: '/fixture/custom-codex',
    feishu: {
      appId: 'cli_test',
      tenantKey: 'tenant',
      allowedOpenId: 'ou_test',
      testChatId: 'oc_test',
    },
  };
  return { root, backend, calls, controller, settings };
}
describe('Rust host transition', () => {
  it('preserves native rejection messages for existing React feedback without dumping unknown data', () => {
    const message = '核心协议不兼容：turn/status';
    const converted = desktopError(message);
    expect(converted).toBeInstanceOf(Error);
    expect(converted.message).toBe(message);
    const original = new Error('后台进程已退出');
    expect(desktopError(original)).toBe(original);
    expect(desktopError({ appSecret: 'never-display-secret' }).message).not.toContain(
      'never-display-secret',
    );
    expect(desktopError('').message).toContain('后台操作失败');
  });
  it('authenticates ciphertext, rejects tampering and cannot read Electron ciphertext', () => {
    const cipher = nativeCipher(Buffer.alloc(32, 8));
    const first = cipher.encrypt('secret-value');
    expect(first).not.toContain('secret-value');
    expect(cipher.encrypt('secret-value')).not.toBe(first);
    expect(cipher.decrypt(first)).toBe('secret-value');
    expect(() => nativeCipher(Buffer.alloc(32, 7)).decrypt(first)).toThrow('无法解密');
    const bytes = Buffer.from(first.slice('native:v1:'.length), 'base64');
    bytes[28] = bytes[28]! ^ 1;
    expect(() => cipher.decrypt('native:v1:' + bytes.toString('base64'))).toThrow('无法解密');
    expect(() => cipher.decrypt('electron-base64')).toThrow('无法解密');
    expect(() => nativeCipher(Buffer.alloc(16))).toThrow('密钥不可用');
  });
  it('preserves offline drafts across reopen without exposing the secret in snapshots', async () => {
    const { root, controller, backend, settings } = fixture();
    const snapshot = await controller.handle({
      method: 'saveDraft',
      settings,
      secret: 'fixture-secret',
    });
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
    expect(readFileSync(join(root, 'draft.json'), 'utf8')).not.toContain('fixture-secret');
    const reopened = new NativeController(
      root,
      nativeCipher(Buffer.alloc(32, 9)),
      backend,
      () => {},
    );
    expect(reopened.snapshot().settings).toEqual(settings);
    expect(reopened.vault.credentials(settings).appSecret).toBe('fixture-secret');
    await expect(reopened.handle({ method: 'start' })).rejects.toThrow('先应用');
  });
  it('blocks active edits and starts only the validated active identity', async () => {
    const { controller, backend, settings, calls } = fixture();
    backend.status = { ...stoppedStatus(), phase: 'ready' };
    await expect(
      controller.handle({ method: 'apply', settings, secret: 'fixture-secret' }),
    ).rejects.toThrow('先停止');
    backend.status = stoppedStatus();
    await controller.handle({ method: 'apply', settings, secret: 'fixture-secret' });
    await controller.handle({ method: 'start' });
    const input = calls.find((c) => c.method === 'start')!.args as {
      credentials: { appSecret: string };
      settings: unknown;
    };
    expect(input.credentials.appSecret).toBe('fixture-secret');
    expect(input.settings).toEqual(settings);
    await controller.handle({
      method: 'saveDraft',
      settings: { ...settings, maxConcurrentTasks: 2 },
      secret: '',
    });
    await expect(controller.handle({ method: 'start' })).rejects.toThrow('未应用草稿');
  });
  it('does not let the renderer choose arbitrary URLs, executables or binding codes', () => {
    const { controller } = fixture();
    expect(() => controller.effect({ method: 'openFeishu', entry: 'https://evil.test' })).toThrow();
    expect(() => controller.effect({ method: 'openFeishu', entry: 'authorization' })).toThrow(
      '二维码已过期',
    );
    expect(() => controller.effect({ method: 'copyFeishu', item: 'binding' })).toThrow(
      '绑定指令已过期',
    );
    expect(controller.effect({ method: 'copyFeishu', item: 'events' }).value).toContain(
      'card.action.trigger',
    );
    expect(() => controller.effect({ method: 'start', executable: '/bin/sh' })).toThrow();
  });
  it('cancels setup before closing the backend and retains unresolved status semantics', async () => {
    const { controller, backend, calls } = fixture();
    const unknown: DesktopStatus = {
      ...stoppedStatus(),
      pending: 1,
      tasks: [{ status: 'unknown', count: 1 }],
    };
    backend.status = unknown;
    expect(controller.snapshot().status).toEqual(unknown);
    await controller.close();
    expect(calls.map((c) => c.method)).toEqual(['setupCancel', 'close']);
  });
});
