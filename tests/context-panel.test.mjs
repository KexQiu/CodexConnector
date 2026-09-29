import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { migrate, migrationSources, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { FeishuSender } from '../src/feishu/sender.ts';
import { FeishuApiError } from '../src/feishu/api.ts';
import { silentLogger } from '../src/feishu/credentials.ts';
import { PANEL_REFRESH_MS, PANEL_ROTATE_MS } from '../src/feishu/context-panel.ts';

const credentials = {
  appId: 'cli_fixture',
  appSecret: 'fixture',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_user',
  testChatId: 'oc_chat',
};
describe('durable context panel and bot menu (real SQLite, simulated Feishu)', () => {
  let dir, db, store, inbox, commands, panel, sender, config, api, messages, creates, updates;
  const owner = {
    tenantKey: credentials.tenantKey,
    appId: credentials.appId,
    openId: credentials.allowedOpenId,
  };
  function wire() {
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, credentials);
    commands = new FeishuCommands(inbox, config, {
      catalog: async () => [],
      sessions: async () => ({ data: [], total: 0, available: true }),
    });
    panel = commands.panel;
    sender = new FeishuSender(store, credentials, api, config.projects);
  }
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-panel-')));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    config = {
      projects: [
        { key: 'p', name: '测试项目', root: dir, remoteWrite: true },
        { key: 'readonly', name: '只读项目', root: dir + '/missing', remoteWrite: false },
      ],
    };
    messages = [];
    creates = 0;
    updates = 0;
    api = {
      prepare: async () => {},
      create: async (chat, content) => {
        const id = `om_${++creates}`;
        messages.push({
          message_id: id,
          chat_id: chat,
          msg_type: 'interactive',
          sender: { id: credentials.appId, id_type: 'app_id', sender_type: 'app' },
          body: { content },
        });
        return id;
      },
      update: async (id, content) => {
        updates++;
        messages.find((m) => m.message_id === id).body.content = content;
        return id;
      },
      get: async (id) => messages.find((m) => m.message_id === id),
      history: async () => messages,
    };
    wire();
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const panelRow = () => db.prepare('SELECT * FROM feishu_panels').get();
  const rows = () =>
    db.prepare('SELECT * FROM outbox WHERE panel_id IS NOT NULL ORDER BY card_version').all();
  const menu = (key = 'codex_current_context') => ({
    event_id: randomUUID(),
    app_id: credentials.appId,
    tenant_key: credentials.tenantKey,
    operator: { operator_id: { open_id: credentials.allowedOpenId } },
    event_key: key,
  });
  const action = (row) => ({
    event_id: randomUUID(),
    app_id: credentials.appId,
    tenant_key: credentials.tenantKey,
    operator: { open_id: credentials.allowedOpenId },
    context: { open_chat_id: credentials.testChatId, open_message_id: row.message_id },
    action: { value: { gatewayNonce: row.nonce } },
  });
  const button = (choice) =>
    db
      .prepare('SELECT * FROM feishu_actions WHERE choice=? ORDER BY rowid DESC LIMIT 1')
      .get(choice);
  async function initial() {
    store.setContext(inbox.owner, 'p', null, credentials.testChatId);
    panel.sync();
    await sender.flushOne();
  }
  const task = () =>
    store.submit({
      chatId: credentials.testChatId,
      owner,
      requestKey: randomUUID(),
      projectKey: 'p',
      cwd: dir,
      prompt: '检查登录页面',
    }).task;
  it('projects one selected context, updates the same card, and survives reopening without resending', async () => {
    await initial();
    const id = panelRow().message_id;
    expect(panelRow().version).toBe(1);
    expect(store.list()).toHaveLength(0);
    expect(messages[0].body.content).toContain('测试项目');
    expect(JSON.parse(messages[0].body.content).config.update_multi).toBe(true);
    expect(panel.sync()).toBe(false);
    store.setContext(inbox.owner, 'readonly', null, credentials.testChatId);
    expect(panel.sync()).toBe(true);
    await sender.flushOne();
    expect(panelRow().message_id).toBe(id);
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    expect(messages[0].body.content).toContain('未开放执行权限');
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    wire();
    expect(panel.sync()).toBe(false);
    expect(panelRow().message_id).toBe(id);
  });
  it('shows the running turn, subsequent queue, and pending input instead of calling the selected queued turn running', () => {
    const first = task();
    store.claim(first.task_id, 'e');
    store.bindThread(first.task_id, 'thread', dir, 'e');
    store.bindTurn(first.task_id, { id: 'turn', status: 'inProgress', items: [] });
    const next = store.submit({
      chatId: credentials.testChatId,
      owner,
      requestKey: 'next',
      projectKey: 'p',
      cwd: dir,
      prompt: '后续',
      threadId: 'thread',
    }).task;
    store.setContext(inbox.owner, 'p', next.task_id, credentials.testChatId);
    db.prepare('UPDATE tasks SET waiting_input=1 WHERE task_id=?').run(first.task_id);
    const view = panel.snapshot();
    expect(view.text).toContain('执行中');
    expect(view.text).toContain('排队消息：1 条');
    expect(view.text).toContain('等待补充输入');
    expect(view.text).toContain('检查登录页面');
  });
  it('coalesces unsent projections and does not send a stale selection', async () => {
    store.setContext(inbox.owner, 'p', null, credentials.testChatId);
    panel.sync();
    store.setContext(inbox.owner, 'readonly', null, credentials.testChatId);
    panel.sync();
    expect(rows().map((r) => r.state)).toEqual(['superseded', 'pending']);
    await sender.flushOne();
    expect(creates).toBe(1);
    expect(messages[0].body.content).toContain('只读项目');
  });
  it('does not duplicate a send whose response was lost and resumes after verifying its receipt', async () => {
    const create = api.create;
    api.create = async (...args) => {
      await create(...args);
      throw new FeishuApiError('unknown');
    };
    await initial();
    expect(rows()[0].state).toBe('unknown');
    expect(panelRow().message_id).toBeNull();
    store.setContext(inbox.owner, 'readonly', null, credentials.testChatId);
    expect(panel.sync()).toBe(false);
    expect(creates).toBe(1);
    await sender.reconcileOne();
    expect(panelRow().message_id).toBe('om_1');
    panel.sync();
    await sender.flushOne();
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    expect(messages[0].body.content).toContain('只读项目');
  });
  it('serializes unknown PATCH outcomes while task delivery remains independent', async () => {
    await initial();
    const update = api.update;
    api.update = async () => {
      throw new FeishuApiError('unknown');
    };
    store.setContext(inbox.owner, 'readonly', null, credentials.testChatId);
    panel.sync();
    await sender.flushOne();
    const blocked = rows().at(-1);
    store.setContext(inbox.owner, 'p', null, credentials.testChatId);
    expect(panel.sync()).toBe(false);
    const t = task();
    db.prepare('UPDATE outbox SET owner_key=?,chat_id=? WHERE task_id=?').run(
      inbox.owner,
      credentials.testChatId,
      t.task_id,
    );
    await sender.flushOne();
    expect(creates).toBe(2);
    await update(blocked.message_id, blocked.wire_content);
    await sender.reconcileOne();
    api.update = update;
    expect(panel.sync()).toBe(true);
    await sender.flushOne();
    expect(creates).toBe(2);
    expect(messages[0].body.content).toContain('测试项目');
  });
  it('rotates before 14 days and invalidates the replaced panel buttons', async () => {
    await initial();
    const old = button('refresh');
    const created = panelRow().message_created_at;
    expect(panel.sync(created + PANEL_ROTATE_MS + 1)).toBe(true);
    await sender.flushOne(created + PANEL_ROTATE_MS + 1);
    expect(creates).toBe(2);
    expect(updates).toBe(0);
    expect(panelRow().message_id).toBe('om_2');
    expect(inbox.receive('action', action(old)).outcome).toBe('expired-or-invalid');
  });
  it('renews panel buttons without waiting for a context change', async () => {
    await initial();
    const expires = button('refresh').expires_at;
    const now = panelRow().next_refresh_at + 1;
    panel.sync(now);
    await sender.flushOne(now);
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    expect(button('refresh').expires_at).toBeGreaterThan(expires);
    expect(panelRow().next_refresh_at).toBe(now + PANEL_REFRESH_MS);
  });
  it('preserves retry-after when coalescing and does not repeatedly replace an unsent rotation', async () => {
    await initial();
    const rotateAt = panelRow().message_created_at + PANEL_ROTATE_MS + 1;
    panel.sync(rotateAt);
    const id = rows().at(-1).outbox_id;
    expect(panel.sync(rotateAt + 100)).toBe(false);
    expect(rows().at(-1).outbox_id).toBe(id);
    const claim = sender.outbox.claim(rotateAt);
    sender.outbox.fail(claim.claim_token, 'retryable-rejection', rotateAt, 60_000);
    store.setContext(inbox.owner, 'readonly', null, credentials.testChatId);
    panel.sync(rotateAt + 200);
    expect(rows().at(-1).next_retry_at).toBe(rotateAt + 60_000);
    expect(sender.outbox.claim(rotateAt + 300)).toBeNull();
  });
  it('commits a real SDK-shaped menu event before ACK and permits redelivery after SQLite failure', async () => {
    const ws = new WSClient({ ...credentials, logger: silentLogger }),
      frames = [];
    ws.eventDispatcher = inbox.dispatcher();
    ws.sendMessage = (frame) => frames.push(JSON.parse(new TextDecoder().decode(frame.payload)));
    const { event_id, app_id, tenant_key, ...event } = menu();
    const envelope = {
      schema: '2.0',
      header: { event_id, app_id, tenant_key, event_type: 'application.bot.menu_v6' },
      event,
    };
    const deliver = () =>
      ws.handleEventData({
        headers: Object.entries({
          message_id: randomUUID(),
          sum: '1',
          seq: '0',
          type: 'event',
          trace_id: 'fixture',
        }).map(([key, value]) => ({ key, value })),
        payload: new TextEncoder().encode(JSON.stringify(envelope)),
      });
    try {
      db.pragma('query_only=ON');
      await deliver();
      expect(frames[0].code).toBe(500);
      db.pragma('query_only=OFF');
      await deliver();
      await deliver();
      expect(frames.slice(1).map((f) => f.code)).toEqual([200, 200]);
      expect(db.prepare('SELECT count(*) FROM feishu_commands').pluck().get()).toBe(1);
      await commands.processNext();
      expect(panelRow()).toBeDefined();
      expect(store.list()).toHaveLength(0);
    } finally {
      db.pragma('query_only=OFF');
      ws.close({ force: true });
    }
  });
  it.each([230011, 230031, 230110])(
    'replaces a definitively unavailable card after platform rejection %s',
    async (code) => {
      await initial();
      api.update = async () => {
        throw new FeishuApiError('permanent', 400, code);
      };
      panel.request();
      panel.sync();
      await sender.flushOne();
      expect(rows().at(-1).state).toBe('failed');
      panel.sync();
      await sender.flushOne();
      expect(creates).toBe(2);
      expect(panelRow().message_id).toBe('om_2');
    },
  );
  it('does not create repeated replacements for a permission rejection', async () => {
    await initial();
    api.update = async () => {
      throw new FeishuApiError('permanent', 400, 99991672);
    };
    panel.request();
    panel.sync();
    await sender.flushOne();
    panel.request();
    expect(panel.sync()).toBe(false);
    expect(creates).toBe(1);
  });
  it('accepts only configured menu keys and the authorized tenant/app/user, with event-level deduplication', async () => {
    const event = menu();
    expect(inbox.receive('menu', event).outcome).toBe('accepted');
    expect(inbox.receive('menu', event).outcome).toBe('duplicate');
    await commands.processNext();
    expect(store.list()).toHaveLength(0);
    expect(panelRow()).toBeDefined();
    expect(inbox.receive('menu', menu()).outcome).toBe('accepted');
    for (const field of ['app_id', 'tenant_key'])
      expect(inbox.receive('menu', { ...menu(), [field]: 'foreign' }).outcome).toBe('denied');
    expect(
      inbox.receive('menu', { ...menu(), operator: { operator_id: { open_id: 'ou_other' } } })
        .outcome,
    ).toBe('denied');
    for (const key of ['unknown', '__proto__', 'constructor'])
      expect(inbox.receive('menu', menu(key)).outcome).toBe('ignored');
  });
  it('routes menu actions without submitting tasks or turning the menu key into model input', async () => {
    const t = task();
    store.setContext(inbox.owner, 'p', t.task_id, credentials.testChatId);
    inbox.receive('menu', menu('codex_new_topic'));
    await commands.processNext();
    expect(panel.context().task_id).toBeNull();
    inbox.receive('menu', menu('codex_switch_project'));
    await commands.processNext();
    expect(store.list()).toHaveLength(1);
    const notices = db
      .prepare('SELECT payload FROM outbox WHERE task_id IS NULL')
      .all()
      .map((r) => JSON.parse(r.payload));
    expect(notices.some((n) => n.title === '选择项目')).toBe(true);
  });
  it('refreshes the canonical panel without creating an extra snapshot or navigation view', async () => {
    await initial();
    const id = panelRow().message_id;
    inbox.receive('action', action(button('refresh')));
    await commands.processNext();
    panel.sync();
    while (await sender.flushOne());
    expect(creates).toBe(1);
    expect(panelRow().message_id).toBe(id);
    expect(db.prepare('SELECT count(*) FROM outbox WHERE panel_id IS NULL').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM outbox WHERE view_id IS NOT NULL').pluck().get()).toBe(
      0,
    );
  });
  it('allows repeated panel navigation clicks but does not replay a redelivered event', async () => {
    await initial();
    const row = button('refresh');
    const event = action(row);
    expect(inbox.receive('action', event).outcome).toBe('accepted');
    expect(inbox.receive('action', event).outcome).toBe('duplicate');
    await commands.processNext();
    expect(inbox.receive('action', action(row)).outcome).toBe('accepted');
    await commands.processNext();
    expect(store.list()).toHaveLength(0);
  });
  it('rejects a stale new-topic button without clearing the subsequently selected conversation', async () => {
    await initial();
    const old = button('new_topic');
    const t = task();
    store.setContext(inbox.owner, 'p', t.task_id, credentials.testChatId);
    inbox.receive('action', action(old));
    await commands.processNext();
    expect(panel.context().task_id).toBe(t.task_id);
    expect(
      db
        .prepare(
          "SELECT count(*) FROM outbox WHERE json_extract(payload,'$.title')='当前会话已变化'",
        )
        .pluck()
        .get(),
    ).toBe(0);
    expect(db.prepare('SELECT refresh_requested FROM feishu_panels').pluck().get()).toBe(1);
  });
  it('rolls back a new-topic selection when the acknowledgement cannot be saved', async () => {
    const t = task();
    store.setContext(inbox.owner, 'p', t.task_id, credentials.testChatId);
    panel.sync();
    await sender.flushOne();
    const row = button('new_topic');
    db.exec(
      "CREATE TRIGGER fail_panel_reply BEFORE UPDATE ON feishu_commands WHEN NEW.state='processed' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    inbox.receive('action', action(row));
    await commands.processNext();
    expect(panel.context().task_id).toBe(t.task_id);
  });
  it('migrates populated v4 navigation records and refuses migration with a live lease', () => {
    const old = openGatewayDatabase(join(dir, 'v4.sqlite'));
    try {
      for (const m of migrationSources().slice(0, 4)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
        old.pragma(`user_version=${m.version}`);
      }
      old.exec(
        "INSERT INTO outbox (outbox_id,logical_key,card_version,payload,state,created_at) VALUES ('o','k',1,'{}','delivered',1); INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,message_id,action,expires_at,project_key) VALUES ('n','o','owner','chat','message','project',9999999999999,'p')",
      );
      const before = old.prepare('SELECT * FROM feishu_actions').all();
      old.prepare('INSERT INTO feishu_runtime_lease VALUES (1,?,?)').run(process.pid, 'lease');
      expect(() => migrate(old)).toThrow(/Gateway/);
      expect(old.pragma('user_version', { simple: true })).toBe(4);
      old.exec('DELETE FROM feishu_runtime_lease');
      migrate(old);
      expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(old.prepare('SELECT * FROM feishu_actions').all()).toEqual(before);
      expect(old.pragma('foreign_key_check')).toEqual([]);
    } finally {
      old.close();
    }
  });
});
