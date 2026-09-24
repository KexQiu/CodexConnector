import { mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopVault, profileId } from '../src/desktop/vault.ts';
import { gatewayConfigSchema } from '../src/config/schema.ts';
import { gatewayCredentials } from '../src/feishu/credentials.ts';
import { uiRequestSchema } from '../src/desktop/contracts.ts';
import { validateSettings } from '../src/desktop/runtime.ts';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskWorker } from '../src/tasks/worker.ts';
import { FeishuRuntime } from '../src/feishu/runtime.ts';

let dir;
const identity = {
  appId: 'cli_fixture',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_fixture',
  testChatId: 'oc_fixture',
};
const owner = {
  appId: identity.appId,
  tenantKey: identity.tenantKey,
  openId: identity.allowedOpenId,
};
const secret = 'DESKTOP_PRIVATE_SECRET';
const cipher = {
  encrypt: (text) => Buffer.from(text).toString('base64'),
  decrypt: (text) => Buffer.from(text, 'base64').toString(),
};
const settings = () => ({
  codexBinary: '/Applications/Codex.app/Contents/Resources/codex',
  feishu: identity,
  projects: [{ key: 'p', name: 'Project', root: dir, remoteWrite: true }],
});
const config = () => ({
  ...validateSettings(settings(), { ...identity, appSecret: secret }),
  dataDir: dir,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-desktop-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('desktop configuration and credential boundary', () => {
  it('preserves existing extensions only within their original conversation identity', () => {
    const vault = new DesktopVault(dir, cipher);
    const legacy = {
      profileId: profileId(settings()),
      service: { logMaxBytes: 100000 },
      notify: {
        port: 45321,
        tokenFile: join(dir, 'token'),
        spoolDir: join(dir, 'spool'),
        projectKeys: ['p'],
        verifiedEvents: ['agent-turn-complete'],
      },
    };
    vault.write('active', vault.prepare(settings(), secret, legacy));
    const saved = vault.prepare({ ...settings(), projects: [] });
    expect(saved.legacy.notify).toEqual(legacy.notify);
    expect(
      validateSettings(saved.settings, { ...identity, appSecret: secret }, saved.legacy).service
        .logMaxBytes,
    ).toBe(100000);
    const next = vault.prepare({ ...settings(), feishu: { ...identity, testChatId: 'oc_new' } });
    expect(next.legacy).toBeUndefined();
    expect(() =>
      validateSettings(next.settings, { ...next.settings.feishu, appSecret: secret }, saved.legacy),
    ).toThrow('原飞书身份');
    expect(vault.read('active').legacy.notify).toEqual(legacy.notify);
  });
  it('persists an atomic encrypted snapshot without returning a plaintext secret', () => {
    const vault = new DesktopVault(dir, cipher);
    vault.write('active', vault.prepare(settings(), secret));
    expect(readFileSync(join(dir, 'active.json'), 'utf8')).not.toContain(secret);
    expect(vault.read('active').settings).toEqual({
      ...settings(),
      maxConcurrentTasks: 1,
      hiddenProjectRoots: [],
    });
    expect(vault.credentials(settings()).appSecret).toBe(secret);
  });
  it('retains active configuration when encrypting a replacement fails', () => {
    const vault = new DesktopVault(dir, cipher);
    vault.write('active', vault.prepare(settings(), secret));
    const before = readFileSync(join(dir, 'active.json'), 'utf8');
    const locked = new DesktopVault(dir, {
      ...cipher,
      encrypt() {
        throw new Error('Keychain locked');
      },
    });
    expect(() => locked.write('active', locked.prepare(settings(), 'replacement'))).toThrow(
      'Keychain locked',
    );
    expect(readFileSync(join(dir, 'active.json'), 'utf8')).toBe(before);
  });
  it('does not fall back to plaintext when decryption is unavailable', () => {
    const vault = new DesktopVault(dir, cipher);
    vault.write('active', vault.prepare(settings(), secret));
    expect(() =>
      new DesktopVault(dir, {
        ...cipher,
        decrypt() {
          throw new Error('locked');
        },
      }).credentials(settings()),
    ).toThrow('locked');
  });
  it('isolates every Feishu identity/chat change while retaining the original data directory', () => {
    const vault = new DesktopVault(dir, cipher),
      old = vault.prepare(settings(), secret);
    vault.write('active', old);
    for (const field of Object.keys(identity))
      expect(
        profileId({ ...settings(), feishu: { ...identity, [field]: `${identity[field]}_new` } }),
      ).not.toBe(old.profileId);
    expect(profileId({ ...settings(), projects: [] })).toBe(old.profileId);
    const next = vault.prepare({ ...settings(), feishu: { ...identity, testChatId: 'oc_new' } });
    vault.write('active', next);
    expect(existsSync(vault.dataDir(old))).toBe(true);
  });
  it('does not reuse another application secret', () => {
    const vault = new DesktopVault(dir, cipher);
    vault.write('active', vault.prepare(settings(), secret));
    expect(() =>
      vault.credentials({ ...settings(), feishu: { ...identity, appId: 'cli_other' } }),
    ).toThrow();
  });
  it('keeps offline draft separate until applied and clears draft only after success', () => {
    const vault = new DesktopVault(dir, cipher);
    vault.write('active', vault.prepare(settings(), secret));
    const draft = vault.prepare({ ...settings(), codexBinary: '' });
    vault.write('draft', draft);
    expect(vault.read('active').settings.codexBinary).not.toBe('');
    expect(vault.read('draft').settings.codexBinary).toBe('');
    vault.write('active', vault.prepare(settings(), secret));
    expect(vault.read('draft')).toBeNull();
  });
  it('refuses a symlink in place of the active snapshot', () => {
    const vault = new DesktopVault(dir, cipher);
    const draft = vault.prepare(settings(), secret);
    vault.write('draft', draft);
    symlinkSync(join(dir, 'draft.json'), join(dir, 'active.json'));
    expect(() => vault.write('active', draft)).toThrow();
  });
  it('retains CLI file compatibility and rejects ambiguous or missing sources', () => {
    const cfg = config();
    expect(gatewayCredentials(cfg, { ...identity, appSecret: secret }).appSecret).toBe(secret);
    expect(() => gatewayCredentials(cfg)).toThrow('桌面凭据');
    expect(
      gatewayConfigSchema.safeParse({
        ...cfg,
        feishu: { ...cfg.feishu, credentialsFile: '/tmp/private.json' },
      }).success,
    ).toBe(false);
    const { credentialsSource, ...fields } = cfg.feishu;
    expect(credentialsSource).toBe('desktop');
    expect(
      gatewayConfigSchema.safeParse({
        ...cfg,
        feishu: { ...fields, credentialsFile: '/tmp/private.json' },
      }).success,
    ).toBe(true);
  });
  it('checks canonical duplicate roots and unsafe IPC methods', () => {
    expect(() =>
      validateSettings(
        {
          ...settings(),
          projects: [...settings().projects, { ...settings().projects[0], key: 'p2' }],
        },
        { ...identity, appSecret: secret },
      ),
    ).toThrow('同一目录');
    expect(uiRequestSchema.safeParse({ method: 'exec', command: 'pwd' }).success).toBe(false);
    for (const method of ['previewImport', 'commitImport', 'importPreview', 'importCommit'])
      expect(uiRequestSchema.safeParse({ method, token: 'fixture' }).success).toBe(false);
    expect(
      uiRequestSchema.safeParse({ method: 'discoverProjects', knownRoots: [dir] }).success,
    ).toBe(true);
    expect(
      uiRequestSchema.safeParse({ method: 'discoverProjects', knownRoots: [], home: '/other' })
        .success,
    ).toBe(false);
    expect(uiRequestSchema.safeParse({ method: 'openData', path: '/elsewhere' }).success).toBe(
      false,
    );
  });
});
describe('desktop stop preserves task ownership and uncertainty', () => {
  let db, store, worker;
  beforeEach(() => {
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    worker = new TaskWorker(store, config());
  });
  afterEach(() => {
    worker.close();
    db.close();
  });
  function submit(key = 'one', taskOwner = owner) {
    return store.submit({
      owner: taskOwner,
      requestKey: key,
      projectKey: 'p',
      cwd: dir,
      prompt: 'fixture',
    }).task;
  }
  function running() {
    const task = submit();
    store.claim(task.task_id, 'epoch');
    store.bindThread(task.task_id, 'thread', dir, 'epoch');
    store.bindTurn(task.task_id, { id: 'turn', status: 'inProgress', items: [] });
    return task;
  }
  it('cancels only queued tasks belonging to this gateway identity', async () => {
    const mine = submit(),
      other = submit('other', { ...owner, openId: 'ou_other' });
    await worker.interruptOwnedTasks(1);
    expect(store.get(mine.task_id).status).toBe('interrupted');
    expect(store.get(other.task_id).status).toBe('queued');
    expect(await worker.dispatchNext()).toBeNull();
  });
  it('does not turn an interrupt acknowledgement into a terminal result', async () => {
    const task = running();
    vi.spyOn(worker.rpc, 'isReady', 'get').mockReturnValue(true);
    vi.spyOn(worker.controls, 'next').mockResolvedValue(true);
    await worker.interruptOwnedTasks(1);
    expect(store.get(task.task_id).status).toBe('unknown');
    expect(db.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBeGreaterThan(0);
  });
  it('accepts a matching terminal event and releases execution locks', async () => {
    const task = running();
    vi.spyOn(worker.rpc, 'isReady', 'get').mockReturnValue(true);
    vi.spyOn(worker.controls, 'next').mockImplementation(async () => {
      store.bindTurn(task.task_id, { id: 'turn', status: 'interrupted', items: [] });
      return true;
    });
    await worker.interruptOwnedTasks(100);
    expect(store.get(task.task_id).status).toBe('interrupted');
    expect(db.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBe(0);
  });
  it('preserves disconnected running work as unknown rather than replaying', async () => {
    const task = running();
    await worker.interruptOwnedTasks(1);
    expect(store.get(task.task_id).status).toBe('unknown');
    expect(store.get(task.task_id).turn_id).toBe('turn');
  });
  it('stops incoming messages and dispatch before closing the RPC connection', () => {
    const runtime = new FeishuRuntime(store, config(), { ...identity, appSecret: secret });
    const stop = vi.spyOn(runtime.worker, 'stopDispatch'),
      close = vi.spyOn(runtime.worker, 'close');
    runtime.beginShutdown();
    expect(stop).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(runtime.status().ready).toBe(false);
    runtime.close();
  });
});
