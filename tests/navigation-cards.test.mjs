import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { FeishuSender } from '../src/feishu/sender.ts';
import { migrate, migrationSources, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
import { projectPickerCard, taskListCard } from '../src/feishu/navigation-cards.ts';
const creds = {
  appId: 'cli_fixture',
  appSecret: 'fixture',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_user',
  testChatId: 'oc_fixture',
};
const owner = { appId: creds.appId, tenantKey: creds.tenantKey, openId: creds.allowedOpenId };
const walk = (x) => (x && typeof x === 'object' ? [x, ...Object.values(x).flatMap(walk)] : []);
describe('project, help, feedback and task navigation', () => {
  let dir, db, store, inbox, commands, sender, messages, config;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-nav-cards-')));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, creds);
    config = {
      feishu: creds,
      projects: [{ key: 'p', name: '测试项目', root: dir, remoteWrite: true }],
    };
    commands = new FeishuCommands(inbox, config, {
      catalog: async () => [],
      sessions: async () => ({ available: true, total: 0, data: [] }),
    });
    messages = [];
    sender = new FeishuSender(store, creds, {
      prepare: async () => {},
      create: async (_, wire) => {
        const id = 'om_' + messages.length;
        messages.push({ id, card: JSON.parse(wire) });
        return id;
      },
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function flush() {
    for (let i = 0; i < 30 && (await sender.flushOne()); i++);
  }
  async function receive(text) {
    inbox.receive('message', {
      event_id: randomUUID(),
      app_id: creds.appId,
      tenant_key: creds.tenantKey,
      sender: { sender_type: 'user', sender_id: { open_id: creds.allowedOpenId } },
      message: {
        message_id: randomUUID(),
        chat_id: creds.testChatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    await commands.processNext();
    await flush();
  }
  function actionRow(kind, fields = {}) {
    return db
      .prepare('SELECT * FROM feishu_actions WHERE action=? ORDER BY rowid DESC')
      .all(kind)
      .find((r) => Object.entries(fields).every(([k, v]) => r[k] === v));
  }
  function event(row) {
    return {
      event_id: randomUUID(),
      app_id: creds.appId,
      tenant_key: creds.tenantKey,
      operator: { open_id: creds.allowedOpenId },
      context: { open_chat_id: creds.testChatId, open_message_id: row.message_id },
      action: { value: { gatewayNonce: row.nonce } },
    };
  }
  async function click(row) {
    const e = event(row);
    const r = inbox.receive('action', e);
    await commands.processNext();
    await flush();
    return { e, r };
  }
  function seed(count = 6) {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      const t = store.submit({
        owner,
        requestKey: 'seed-' + i,
        projectKey: 'p',
        cwd: dir,
        prompt: '本轮任务' + i,
      }).task;
      db.prepare("UPDATE tasks SET status='completed',updated_at=? WHERE task_id=?").run(
        1000 + i,
        t.task_id,
      );
      tasks.push(store.get(t.task_id));
    }
    return tasks;
  }
  const text = () => JSON.stringify(messages.at(-1).card);
  it('pairs same-name project rows with their own actions and excludes read-only and invalid paths', async () => {
    config.projects.push(
      { key: 'readonly', name: '测试项目', root: dir, remoteWrite: false },
      { key: 'missing', name: '失效项目', root: join(dir, 'missing'), remoteWrite: true },
    );
    store.setContext(inbox.owner, 'p', null);
    await receive('/项目');
    expect(text()).toContain('当前 · 测试项目');
    expect(text()).toContain('只读');
    expect(text()).toContain('路径失效');
    const rows = db.prepare("SELECT * FROM feishu_actions WHERE action='project'").all();
    expect(rows.map((r) => r.project_key)).toEqual(['p']);
    const elements = messages.at(-1).card.body.elements;
    const buttonIndex = elements.findIndex((e) => JSON.stringify(e).includes(rows[0].nonce));
    const readonlyIndex = elements.findIndex(
      (e) => e.tag === 'markdown' && e.content === 'readonly',
    );
    expect(buttonIndex).toBeLessThan(readonlyIndex);
    expect(store.list()).toHaveLength(0);
    expect(
      walk(messages.at(-1).card)
        .filter((n) => n.tag === 'button')
        .every((b) => ['default', 'primary', 'danger'].includes(b.type)),
    ).toBe(true);
  });
  it('keeps draft pagination reusable but never submits while navigating or cancelling', async () => {
    for (let i = 0; i < 6; i++)
      config.projects.push({ key: 'r' + i, name: '只读' + i, root: dir, remoteWrite: false });
    await receive('尚未执行的需求');
    expect(text()).toContain('尚未执行');
    expect(text()).toContain('在此执行需求');
    const row = actionRow('projects', { page: 1 });
    const { e } = await click(row);
    expect(text()).toContain('第 2/2 页');
    expect(inbox.receive('action', e).outcome).toBe('duplicate');
    expect((await click(row)).r.outcome).toBe('accepted');
    expect(store.list()).toHaveLength(0);
    await click(actionRow('cancel_draft'));
    expect(text()).toContain('处理结果');
    expect(text()).toContain('这条需求没有执行');
    expect(messages.at(-1).card.header.template).toBe('grey');
    expect(store.list()).toHaveLength(0);
    await click(row);
    expect(text()).toContain('命令未执行');
    expect(store.list()).toHaveLength(0);
  });
  it('help and task-list navigation preserve selection and never create tasks', async () => {
    const tasks = seed();
    store.setContext(inbox.owner, 'p', tasks[0].task_id);
    const before = db.prepare('SELECT * FROM user_context').all();
    await receive('/帮助');
    for (const section of ['日常对话', '查看与切换', '任务控制', '更多用法'])
      expect(text()).toContain(section);
    expect(text()).toContain('/额度');
    await click(actionRow('tasks'));
    expect(text()).toContain('第 1/2 页');
    expect(store.list()).toHaveLength(6);
    expect(db.prepare('SELECT * FROM user_context').all()).toEqual(before);
  });
  it('paginates only owned tasks, renders Chinese states and opens the exact task without switching', async () => {
    const tasks = seed();
    store.submit({
      owner: { ...owner, openId: 'other' },
      requestKey: 'foreign',
      projectKey: 'p',
      cwd: dir,
      prompt: 'SECRET_OTHER_OWNER',
    });
    db.prepare('UPDATE tasks SET waiting_approval=1 WHERE task_id=?').run(tasks[5].task_id);
    store.setContext(inbox.owner, 'p', tasks[0].task_id);
    const before = db.prepare('SELECT * FROM user_context').all();
    await receive('/任务');
    expect(text()).not.toContain('SECRET_OTHER_OWNER');
    expect(text()).toContain('等待审批');
    expect(text()).toContain('执行完成');
    expect(
      walk(messages.at(-1).card).filter((n) => n.tag === 'markdown' && /^```\n/.test(n.content)),
    ).toHaveLength(4);
    const row = actionRow('tasks', { page: 1 });
    const { e } = await click(row);
    expect(text()).toContain('第 2/2 页');
    expect(text()).toContain('当前 · 本轮任务0');
    expect(inbox.receive('action', e).outcome).toBe('duplicate');
    expect((await click(row)).r.outcome).toBe('accepted');
    await click(actionRow('details', { task_id: tasks[0].task_id }));
    expect(text()).toContain(tasks[0].task_id);
    expect(db.prepare('SELECT * FROM user_context').all()).toEqual(before);
    expect(store.list()).toHaveLength(7);
    expect(() => taskListCard(store, inbox.owner, config.projects, null, 2)).toThrow('列表已变化');
  });
  it('rejects foreign, mismatched-message and expired task-list callbacks', async () => {
    seed();
    await receive('/任务');
    const row = actionRow('tasks');
    const foreign = event(row);
    foreign.operator.open_id = 'other';
    expect(inbox.receive('action', foreign).outcome).toBe('denied');
    const wrong = event(row);
    wrong.context.open_message_id = 'om_wrong';
    expect(inbox.receive('action', wrong).outcome).toBe('expired-or-invalid');
    db.prepare('UPDATE feishu_actions SET expires_at=0 WHERE nonce=?').run(row.nonce);
    expect(inbox.receive('action', event(row)).outcome).toBe('expired-or-invalid');
  });
  it('shows a structured empty state, preserves selected /状态 semantics and explains invalid commands', async () => {
    await receive('/状态');
    expect(text()).toContain('暂无任务');
    expect(text()).toContain('选择项目');
    const [task] = seed(1);
    store.setContext(inbox.owner, 'p', task.task_id);
    await receive('/状态');
    expect(text()).toContain('任务状态');
    expect(text()).toContain(task.task_id);
    await receive('/任务 abc');
    expect(text()).toContain('命令未执行');
    expect(text()).toContain('1–500');
    expect(messages.at(-1).card.header.template).toBe('orange');
    expect(store.list()).toHaveLength(1);
  });
  it('keeps draft limits and list actions bounded and rejects stale project pages', () => {
    const projects = Array.from({ length: 13 }, (_, i) => ({
      key: 'p' + i,
      name: '项目' + i,
      available: true,
      remoteWrite: true,
    }));
    const card = projectPickerCard(
      projects,
      1,
      'p7',
      { id: 'draft', prompt: '内容', expiresAt: 1234 },
      true,
    );
    expect(card.layout.sections).toHaveLength(7);
    expect(card.buttons).toHaveLength(9);
    expect(card.buttons.every((b) => b.expiresAt === 1234)).toBe(true);
    expect(
      card.layout.sections.flatMap((s) => s.actions ?? []).map((i) => card.buttons[i].projectKey),
    ).toEqual(['p6', 'p7', 'p8', 'p9', 'p10', 'p11']);
    expect(() => projectPickerCard(projects, 3, undefined, null, false)).toThrow('列表已变化');
  });
  it('migrates v8 actions exactly while constraining new task navigation to read-only pagination', () => {
    const old = openGatewayDatabase(join(dir, 'v8.sqlite'));
    try {
      for (const m of migrationSources().slice(0, 8)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
        old.pragma('user_version=' + m.version);
      }
      old.exec(
        "INSERT INTO outbox (outbox_id,logical_key,card_version,payload,state,created_at) VALUES ('o','k',1,'{}','pending',1)",
      );
      old.exec(
        "INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,action,expires_at,choice) VALUES ('n','o','owner','chat','panel',1,'refresh')",
      );
      const before = old.prepare('SELECT * FROM feishu_actions').all();
      migrate(old);
      expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(old.prepare('SELECT * FROM feishu_actions').all()).toEqual(before);
      const add = old.prepare(
        "INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,action,expires_at,page,choice) VALUES (?,'o','owner','chat',?,1,?,?)",
      );
      expect(() => add.run('no-page', 'tasks', null, null)).toThrow();
      expect(() => add.run('bad-choice', 'tasks', 0, 'execute')).toThrow();
      expect(() => add.run('bad-page', 'tasks', 500, null)).toThrow();
      expect(() => add.run('no-task', 'details', null, null)).toThrow();
      add.run('valid', 'tasks', 0, null);
      expect(old.pragma('foreign_key_check')).toEqual([]);
    } finally {
      old.close();
    }
  });
});
