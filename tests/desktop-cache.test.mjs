import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopDraftCache } from '../src/desktop/draft-cache.ts';
import { DesktopVault, defaultSettings } from '../src/desktop/vault.ts';
import { flushDraftBeforeClose } from '../apps/desktop/src/draft-close.ts';

let root, cache;
const cipher = {
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString(),
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-cache-'));
  vi.useFakeTimers();
});
afterEach(() => {
  cache?.dispose();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const vault = new DesktopVault(root, cipher);
  const snapshot = () => ({
    settings: (vault.read('draft') ?? vault.read('active'))?.settings,
    hasDraft: Boolean(vault.read('draft')),
  });
  const api = {
    saveDraft: vi.fn(async (settings, secret) => {
      vault.write('draft', vault.prepare(settings, secret));
      return snapshot();
    }),
    apply: vi.fn(async (settings, secret) => {
      vault.write('active', vault.prepare(settings, secret));
      return snapshot();
    }),
  };
  const status = vi.fn(),
    saved = vi.fn();
  cache = new DesktopDraftCache(defaultSettings(), api, status, saved);
  return { vault, api, status, saved };
}
it('debounces typing and restores incomplete configuration from an encrypted local draft', async () => {
  const { api, saved } = setup();
  const first = { ...defaultSettings(), feishu: { ...defaultSettings().feishu, appId: 'cli_par' } };
  cache.update(first, 'CACHE_SECRET');
  await vi.advanceTimersByTimeAsync(400);
  const last = {
    ...first,
    feishu: { ...first.feishu, appId: 'cli_partial' },
    maxConcurrentTasks: 3,
    hiddenProjectRoots: ['/removed'],
  };
  cache.update(last, 'CACHE_SECRET');
  await vi.advanceTimersByTimeAsync(599);
  expect(api.saveDraft).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.saveDraft).toHaveBeenCalledTimes(1);
  const reopened = new DesktopVault(root, cipher).read('draft');
  expect(reopened.settings).toEqual(last);
  expect(cipher.decrypt(reopened.encryptedSecret)).toBe('CACHE_SECRET');
  expect(readFileSync(join(root, 'draft.json'), 'utf8')).not.toContain('CACHE_SECRET');
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({ hasDraft: true }), 2, false);
  expect(api.apply).not.toHaveBeenCalled();
  cache.update({ ...last, maxConcurrentTasks: 4 }, 'CACHE_SECRET');
  await cache.flush();
  expect(api.saveDraft).toHaveBeenLastCalledWith(
    expect.objectContaining({ maxConcurrentTasks: 4 }),
    '',
  );
  expect(cipher.decrypt(new DesktopVault(root, cipher).read('draft').encryptedSecret)).toBe(
    'CACHE_SECRET',
  );
});
it('flushes on close before the debounce deadline and waits for the actual write acknowledgement', async () => {
  const { api, status } = setup();
  const gate = deferred();
  api.saveDraft.mockReturnValueOnce(gate.promise);
  cache.update(defaultSettings(), 'secret');
  let complete = false;
  const closing = cache.flush().then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(api.saveDraft).toHaveBeenCalledTimes(1);
  expect(complete).toBe(false);
  gate.resolve({ hasDraft: true });
  await closing;
  expect(status).toHaveBeenLastCalledWith('saved');
});
it('serializes in-flight writes and flushes the newest edits instead of losing them', async () => {
  const { api, vault } = setup();
  const gate = deferred();
  const save = api.saveDraft.getMockImplementation();
  api.saveDraft.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return save(...args);
  });
  cache.update(defaultSettings(), 'first');
  const flushing = cache.flush();
  await vi.advanceTimersByTimeAsync(1);
  cache.update({ ...defaultSettings(), maxConcurrentTasks: 4 }, 'latest');
  await vi.advanceTimersByTimeAsync(600);
  expect(api.saveDraft).toHaveBeenCalledTimes(1);
  gate.resolve();
  await flushing;
  await cache.flush();
  expect(api.saveDraft).toHaveBeenCalledTimes(2);
  expect(vault.read('draft').settings.maxConcurrentTasks).toBe(4);
  expect(cipher.decrypt(vault.read('draft').encryptedSecret)).toBe('latest');
});
it('does not recreate a stale draft after applying while an automatic save is pending', async () => {
  const { api, vault } = setup();
  const gate = deferred();
  const save = api.saveDraft.getMockImplementation();
  api.saveDraft.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return save(...args);
  });
  cache.update(defaultSettings(), 'secret');
  const flushing = cache.flush();
  await vi.advanceTimersByTimeAsync(1);
  const applying = cache.apply();
  gate.resolve();
  await flushing;
  await applying;
  await vi.advanceTimersByTimeAsync(1000);
  await cache.flush();
  expect(api.saveDraft).toHaveBeenCalledTimes(1);
  expect(api.apply).toHaveBeenCalledTimes(1);
  expect(vault.read('draft')).toBeNull();
  expect(vault.read('active')).not.toBeNull();
});
it('keeps newer edits made during apply as a separate draft', async () => {
  const { api, vault } = setup();
  const gate = deferred();
  const apply = api.apply.getMockImplementation();
  api.apply.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return apply(...args);
  });
  cache.update(defaultSettings(), 'secret');
  const applying = cache.apply();
  await vi.advanceTimersByTimeAsync(1);
  cache.update({ ...defaultSettings(), maxConcurrentTasks: 5 }, 'secret');
  const flushing = cache.flush();
  gate.resolve();
  await applying;
  await flushing;
  expect(vault.read('active').settings.maxConcurrentTasks).toBe(1);
  expect(vault.read('draft').settings.maxConcurrentTasks).toBe(5);
});
it('retains the previous cache on failure, surfaces failure and allows retry', async () => {
  const { api, vault, status } = setup();
  cache.update(defaultSettings(), 'secret');
  await cache.flush();
  api.saveDraft.mockRejectedValueOnce(new Error('disk unavailable'));
  cache.update({ ...defaultSettings(), maxConcurrentTasks: 6 }, 'secret');
  await expect(cache.flush()).rejects.toThrow('disk unavailable');
  expect(status).toHaveBeenLastCalledWith('error');
  expect(vault.read('draft').settings.maxConcurrentTasks).toBe(1);
  await cache.flush();
  expect(vault.read('draft').settings.maxConcurrentTasks).toBe(6);
});
it('keeps the cached input after apply validation fails', async () => {
  const { api, vault } = setup();
  api.apply.mockRejectedValue(new Error('invalid credentials'));
  cache.update(defaultSettings(), 'secret');
  await expect(cache.apply()).rejects.toThrow('invalid credentials');
  expect(vault.read('draft')).not.toBeNull();
  expect(vault.read('active')).toBeNull();
});
it('does not write repeatedly when unchanged and cancels the timer on disposal', async () => {
  const { api } = setup();
  await cache.flush();
  expect(api.saveDraft).not.toHaveBeenCalled();
  cache.update(defaultSettings(), 'secret');
  await cache.flush();
  await cache.flush();
  expect(api.saveDraft).toHaveBeenCalledTimes(1);
  cache.update(defaultSettings(), 'next');
  cache.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.saveDraft).toHaveBeenCalledTimes(1);
});
it('reuses ciphertext for ordinary edits without decrypting or prompting Keychain again', () => {
  const vault = new DesktopVault(root, cipher),
    settings = defaultSettings();
  vault.write('draft', vault.prepare(settings, 'secret'));
  const locked = new DesktopVault(root, {
    encrypt: () => {
      throw new Error('locked');
    },
    decrypt: () => {
      throw new Error('locked');
    },
  });
  locked.write('draft', locked.prepare({ ...settings, maxConcurrentTasks: 4 }));
  expect(locked.read('draft').encryptedSecret).toBe(vault.read('draft').encryptedSecret);
  expect(locked.read('draft').settings.maxConcurrentTasks).toBe(4);
  expect(() => locked.prepare(settings, 'new-secret')).toThrow('locked');
  expect(
    locked.prepare({ ...settings, feishu: { ...settings.feishu, appId: 'cli_different' } })
      .encryptedSecret,
  ).toBe('');
});

function closeBridge() {
  const ipc = new EventEmitter(),
    contents = { send: vi.fn() },
    url = 'file:///app/ui/index.html';
  const event = { sender: contents, senderFrame: { url } };
  const closing = flushDraftBeforeClose(contents, ipc, url, 1000);
  const token = contents.send.mock.calls[0][1];
  return { ipc, contents, event, token, closing };
}
it('only accepts a flush acknowledgement from the expected window, frame and request', async () => {
  const { ipc, event, token, closing } = closeBridge();
  let finished = false;
  closing.then(() => {
    finished = true;
  });
  ipc.emit('desktop:draft-flushed', { ...event, sender: {} }, { token, ok: true });
  ipc.emit(
    'desktop:draft-flushed',
    { ...event, senderFrame: { url: 'file:///other' } },
    { token, ok: true },
  );
  ipc.emit('desktop:draft-flushed', event, { token: 'old', ok: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).toBe(false);
  ipc.emit('desktop:draft-flushed', event, { token, ok: true });
  await closing;
  expect(ipc.listenerCount('desktop:draft-flushed')).toBe(0);
});
it('rejects quit when saving failed and permits a subsequent flush request', async () => {
  const { ipc, contents, event, token, closing } = closeBridge();
  const failed = expect(closing).rejects.toThrow('尚未保存');
  ipc.emit('desktop:draft-flushed', event, { token, ok: false });
  await failed;
  const retry = flushDraftBeforeClose(contents, ipc, event.senderFrame.url);
  ipc.emit('desktop:draft-flushed', event, { token: contents.send.mock.calls[1][1], ok: true });
  await retry;
});
it('does not pretend a renderer timeout saved the draft', async () => {
  const { ipc, closing } = closeBridge();
  const failed = expect(closing).rejects.toThrow('未能确认');
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
  expect(ipc.listenerCount('desktop:draft-flushed')).toBe(0);
});
