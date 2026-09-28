import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { FeishuSender } from '../src/feishu/sender.ts';
import {
  RemoteProjects,
  registeredProjects,
  validateCreationRoot,
} from '../src/projects/remote.ts';
import { executableProject } from '../src/projects/store.ts';
import { defaultSettings } from '../src/desktop/vault.ts';
import { desktopSettingsSchema } from '../src/desktop/contracts.ts';
import { mergeDiscoveredProjects } from '../src/desktop/project-selection.ts';
import { discoverProfileProjects } from '../src/desktop/projects.ts';
import { migrationSources, migrate, SCHEMA_VERSION } from '../src/persistence/migrate.ts';

const creds = {
  appId: 'cli_test',
  appSecret: 'fixture',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_me',
  testChatId: 'oc_test',
};
describe('remote project creation through authenticated Feishu commands', () => {
  let dir, root, dataDir, db, store, inbox, config, commands, registry, sender, cards;
  const catalog = {
    catalog: async () => [],
    sessions: async () => ({ data: [], total: 0, available: true }),
  };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-remote-')));
    root = join(dir, '项目目录');
    dataDir = join(dir, 'data');
    mkdirSync(root, { mode: 0o700 });
    mkdirSync(dataDir, { mode: 0o700 });
    db = openGatewayDatabase(join(dataDir, 'gateway.sqlite'));
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, creds);
    config = {
      dataDir,
      feishu: creds,
      projects: [],
      remoteProjectCreation: {
        enabled: true,
        root,
        permissions: { mode: 'workspace-write', networkAccess: false },
      },
    };
    commands = new FeishuCommands(inbox, config, catalog);
    registry = new RemoteProjects(db, config, inbox.owner, creds.testChatId);
    cards = [];
    sender = new FeishuSender(
      store,
      creds,
      {
        prepare: async () => {},
        create: async (_chat, wire) => {
          const id = `om_${cards.length}`;
          cards.push({ id, wire: JSON.parse(wire) });
          return id;
        },
        update: async (id) => id,
      },
      config.projects,
    );
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function event(text, id = randomUUID()) {
    return {
      event_id: randomUUID(),
      app_id: creds.appId,
      tenant_key: creds.tenantKey,
      sender: { sender_type: 'user', sender_id: { open_id: creds.allowedOpenId } },
      message: {
        message_id: id,
        chat_id: creds.testChatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    };
  }
  async function receive(text) {
    inbox.receive('message', event(text));
    await commands.processNext();
  }
  async function flush() {
    for (let i = 0; i < 20 && (await sender.flushOne()); i++);
  }
  const rows = () => registeredProjects(db, inbox.owner, creds.testChatId);
  const lastNotice = () =>
    JSON.parse(db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').pluck().get());
  function click(action, overrides = {}) {
    return inbox.receive('action', {
      event_id: randomUUID(),
      app_id: creds.appId,
      tenant_key: creds.tenantKey,
      operator: { open_id: creds.allowedOpenId },
      context: { open_chat_id: creds.testChatId, open_message_id: action.message_id },
      action: { value: { gatewayNonce: action.nonce } },
      ...overrides,
    });
  }

  it('creates a Chinese-named empty directory, selects it, and routes the next message into it', async () => {
    await receive('/新建项目 旅行网站');
    expect(readdirSync(root)).toEqual(['旅行网站']);
    expect(readdirSync(join(root, '旅行网站'))).toEqual([]);
    expect(store.list(inbox.owner)).toHaveLength(0);
    expect(lastNotice().title).toBe('项目已创建');
    expect(config.projects[0].remotePermissions).toEqual({
      mode: 'workspace-write',
      networkAccess: false,
    });
    await receive('写一个介绍页');
    const [task] = store.list(inbox.owner);
    expect(task.cwd).toBe(join(root, '旅行网站'));
    expect(task.project_key).toBe(rows()[0].key);
  });
  it('deduplicates redelivery and refuses a second create with the same name', async () => {
    const e = event('/新建项目 hello');
    inbox.receive('message', e);
    await commands.processNext();
    expect(inbox.receive('message', { ...e, event_id: randomUUID() }).outcome).toBe('duplicate');
    await receive('/新建项目 hello');
    expect(rows()).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['hello']);
    expect(lastNotice().text).toMatch(/已经存在/);
  });
  it('accepts a 64-character Chinese name within the filesystem byte limit', () => {
    const name = '项'.repeat(64);
    expect(registry.create('long-name', name).name).toBe(name);
    expect(readdirSync(root)).toEqual([name]);
  });
  it.each([
    '../escape',
    '/tmp/escape',
    '.hidden',
    'a/b',
    'a\\b',
    'a\nname',
    'hello.',
    'a'.repeat(65),
  ])('rejects path-like or invalid name %s', async (name) => {
    await receive('/新建项目 ' + name);
    expect(readdirSync(root)).toEqual([]);
    expect(rows()).toHaveLength(0);
  });
  it('does not overwrite or adopt an existing directory or symlink', async () => {
    mkdirSync(join(root, 'existing'));
    writeFileSync(join(root, 'existing', 'keep'), 'untouched');
    await receive('/新建项目 existing');
    expect(readFileSync(join(root, 'existing', 'keep'), 'utf8')).toBe('untouched');
    symlinkSync(dir, join(root, 'link'));
    await receive('/新建项目 link');
    expect(rows()).toHaveLength(0);
    expect(db.prepare('SELECT count(*) FROM remote_projects').pluck().get()).toBe(0);
  });
  it('requires a local grant and denies unknown senders and chats', async () => {
    const e = event('/新建项目 denied');
    e.sender.sender_id.open_id = 'ou_stranger';
    expect(inbox.receive('message', e).outcome).toBe('denied');
    e.sender.sender_id.open_id = creds.allowedOpenId;
    e.message.chat_id = 'oc_other';
    expect(inbox.receive('message', e).outcome).toBe('denied');
    config.remoteProjectCreation.enabled = false;
    await receive('/新建项目 denied');
    expect(lastNotice().text).toMatch(/尚未开启/);
    expect(readdirSync(root)).toEqual([]);
  });
  it('restores projects after restart even if creation is now disabled, honoring local overrides and removals', () => {
    const created = registry.create('request', 'persist');
    const next = {
      ...config,
      projects: [],
      remoteProjectCreation: { ...config.remoteProjectCreation, enabled: false },
    };
    new RemoteProjects(db, next, inbox.owner, creds.testChatId).restore();
    expect(executableProject(next.projects, created.key).cwd).toBe(created.root);
    next.projects = [{ ...created, remotePermissions: { mode: 'disabled', networkAccess: false } }];
    new RemoteProjects(db, next, inbox.owner, creds.testChatId).restore();
    expect(() => executableProject(next.projects, created.key)).toThrow(/未开放/);
    next.projects = [];
    next.hiddenProjectRoots = [created.root];
    new RemoteProjects(db, next, inbox.owner, creds.testChatId).restore();
    expect(next.projects).toEqual([]);
    expect(registeredProjects(db, inbox.owner, 'other-chat')).toEqual([]);
  });
  it('pins a directory identity to reject replacements and symlinks after creation', () => {
    const created = registry.create('request', 'pin');
    renameSync(created.root, join(root, 'original'));
    mkdirSync(created.root);
    expect(() => executableProject(config.projects, created.key)).toThrow(/替换/);
    rmSync(created.root, { recursive: true });
    symlinkSync(join(root, 'original'), created.root);
    expect(() => executableProject(config.projects, created.key)).toThrow(/替换/);
  });
  it('a retried completed creation reports the current local permission and honors removal', () => {
    const created = registry.create('request', 'retry');
    config.projects[0].remotePermissions = { mode: 'disabled', networkAccess: false };
    expect(registry.create('request', 'retry').remotePermissions.mode).toBe('disabled');
    config.hiddenProjectRoots = [created.root];
    expect(() => registry.create('request', 'retry')).toThrow(/移除/);
  });
  it('enforces the project cap before creating any directory', () => {
    config.projects = Array.from({ length: 100 }, (_, i) => ({
      key: `p-${i}`,
      name: 'fixture',
      root: join(dir, `missing-${i}`),
      remoteWrite: false,
    }));
    expect(() => registry.create('request', 'capped')).toThrow(/上限/);
    expect(readdirSync(root)).toEqual([]);
  });
  it('applies the local permission preset only to future projects', async () => {
    config.remoteProjectCreation.permissions = { mode: 'disabled', networkAccess: false };
    await receive('/新建项目 disabled');
    await receive('不能运行');
    expect(store.list(inbox.owner)).toEqual([]);
    config.remoteProjectCreation.permissions = { mode: 'read-only', networkAccess: true };
    await receive('/新建项目 readonly');
    await receive('分析');
    expect(store.list(inbox.owner)).toHaveLength(1);
    expect(rows().map((p) => p.remotePermissions.mode)).toEqual(['disabled', 'read-only']);
  });
  it('supports the project card button, persisted name input and cancellation without creating a model task', async () => {
    await receive('/项目');
    await flush();
    const button = db.prepare("SELECT * FROM feishu_actions WHERE action='create_project'").get();
    expect(button).toBeTruthy();
    expect(click(button).outcome).toBe('accepted');
    await commands.processNext();
    await flush();
    commands = new FeishuCommands(inbox, config, catalog);
    await receive('名称回复');
    expect(rows()[0].name).toBe('名称回复');
    expect(store.list(inbox.owner)).toHaveLength(0);
    await receive('/新建项目');
    await flush();
    const cancel = db
      .prepare(
        "SELECT * FROM feishu_actions WHERE action='cancel_project' ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    click(cancel);
    await commands.processNext();
    expect(db.prepare('SELECT count(*) FROM remote_project_prompts').pluck().get()).toBe(0);
    expect(rows()).toHaveLength(1);
  });
  it('an old cancellation button cannot cancel a newer name prompt', async () => {
    await receive('/新建项目');
    await flush();
    const old = db.prepare("SELECT * FROM feishu_actions WHERE action='cancel_project'").get();
    await receive('/新建项目');
    const token = db.prepare('SELECT token FROM remote_project_prompts').pluck().get();
    click(old);
    await commands.processNext();
    expect(db.prepare('SELECT token FROM remote_project_prompts').pluck().get()).toBe(token);
  });
  it('consumes an expired name reply without accidentally running it in the selected project', async () => {
    await receive('/新建项目 first');
    await receive('/新建项目');
    db.prepare('UPDATE remote_project_prompts SET expires_at=0').run();
    await receive('过期后的名称');
    expect(rows()).toHaveLength(1);
    expect(store.list(inbox.owner)).toHaveLength(0);
    expect(lastNotice().text).toMatch(/过期/);
  });
  it('recovers a committed project when the reply transaction fails; does not recreate or reinterpret the name', async () => {
    await receive('/新建项目');
    db.exec(
      "CREATE TRIGGER fail_reply BEFORE UPDATE OF state ON feishu_commands WHEN NEW.state='processed' BEGIN SELECT RAISE(FAIL, 'fixture'); END",
    );
    await receive('once');
    expect(rows()).toHaveLength(1);
    db.exec('DROP TRIGGER fail_reply; DELETE FROM remote_project_prompts');
    commands = new FeishuCommands(inbox, config, catalog);
    await commands.processNext(Date.now() + 60_000);
    expect(rows()).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['once']);
    expect(store.list(inbox.owner)).toHaveLength(0);
    expect(lastNotice().title).toBe('项目已创建');
  });
  it('retains an unconfirmed directory after a failure between mkdir and registry commit', () => {
    db.exec(
      "CREATE TRIGGER fail_ready BEFORE UPDATE ON remote_projects BEGIN SELECT RAISE(FAIL, 'fixture'); END",
    );
    expect(() => registry.create('request', 'uncertain')).toThrow('fixture');
    db.exec('DROP TRIGGER fail_ready');
    expect(() => registry.create('request', 'uncertain')).toThrow(/尚未确认/);
    expect(rows()).toHaveLength(0);
    expect(readdirSync(root)).toEqual(['uncertain']);
  });
  it('rejects unsafe local roots and a save root inside an existing project', () => {
    expect(() => validateCreationRoot(config, [root])).toThrow(/重叠/);
    config.projects.push({ key: 'parent', root: dir, name: 'parent', remoteWrite: false });
    expect(() => validateCreationRoot(config, [])).toThrow(/已有项目/);
    config.projects = [];
    chmodSync(root, 0o777);
    expect(() => validateCreationRoot(config, [])).toThrow(/其他用户/);
  });
  it('exposes remote projects to desktop refresh with stable keys and permissions, preserving edits and hidden roots', () => {
    const created = registry.create('request', 'discover');
    const settings = {
      ...defaultSettings(),
      feishu: {
        appId: creds.appId,
        tenantKey: creds.tenantKey,
        allowedOpenId: creds.allowedOpenId,
        testChatId: creds.testChatId,
      },
    };
    const discovery = discoverProfileProjects(
      { knownRoots: [], dataDir, feishu: settings.feishu },
      join(dir, 'no-codex'),
    );
    let merged = mergeDiscoveredProjects(settings, discovery);
    expect(merged.projects[0].key).toBe(created.key);
    expect(merged.projects[0].remotePermissions).toEqual(created.remotePermissions);
    merged.projects[0].name = '本机名称';
    merged.projects[0].remotePermissions.mode = 'disabled';
    expect(mergeDiscoveredProjects(merged, discovery).projects[0].name).toBe('本机名称');
    expect(
      mergeDiscoveredProjects({ ...settings, hiddenProjectRoots: [created.root] }, discovery)
        .projects,
    ).toEqual([]);
  });
  it('defaults existing desktop settings to disabled remote creation', () => {
    const old = defaultSettings();
    delete old.remoteProjectCreation;
    expect(desktopSettingsSchema.parse(old).remoteProjectCreation.enabled).toBe(false);
  });
  it('migrates a v9 database and retains existing callback records', async () => {
    const path = join(dataDir, 'old.sqlite');
    const old = openGatewayDatabase(path);
    try {
      for (const m of migrationSources().slice(0, 9)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
        old.pragma(`user_version=${m.version}`);
      }
      old
        .prepare(
          "INSERT INTO outbox (outbox_id,logical_key,card_version,payload,state,created_at,owner_key,chat_id) VALUES ('o','l',1,'{}','pending',0,'owner','chat')",
        )
        .run();
      old
        .prepare(
          "INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,action,expires_at,page) VALUES ('n','o','owner','chat','tasks',999,0)",
        )
        .run();
      migrate(old);
      expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(old.prepare('SELECT action FROM feishu_actions').pluck().get()).toBe('tasks');
      expect(old.pragma('foreign_key_check')).toEqual([]);
    } finally {
      old.close();
    }
  });
});
