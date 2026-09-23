import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openGatewayDatabase, openReadonlyDatabase } from '../src/persistence/database.ts';
import { migrate, migrationSources, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { FeishuSender, receiptMarker, terminalNoticeKey } from '../src/feishu/sender.ts';
import { FeishuApi, FeishuApiError } from '../src/feishu/api.ts';
import { silentLogger } from '../src/feishu/credentials.ts';
import { runTaskCli } from '../src/cli/tasks.ts';

const credentials = {
  appId: 'cli_0000000000000001',
  appSecret: 'fixture-never-log',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_user',
  testChatId: 'oc_chat',
};
describe('M3 real SQLite and installed SDK; simulated Feishu HTTP', () => {
  let dir, db, store, inbox, commands, config, sender, messages, creates, updates, api;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-m3-')));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, credentials);
    config = {
      schemaVersion: 1,
      dataDir: dir,
      maxConcurrentTasks: 1,
      codex: {
        binary: 'fixture',
        endpoint: 'ws://127.0.0.1:9999',
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      },
      feishu: { ...credentials, credentialsFile: join(dir, 'unused.json') },
      projects: [{ key: 'p', name: 'P', root: dir, remoteWrite: true }],
    };
    commands = new FeishuCommands(inbox, config, {
      catalog: async () => [],
      sessions: async () => ({ data: [], total: 0, available: true }),
    });
    messages = [];
    creates = 0;
    updates = 0;
    api = {
      prepare: async () => {},
      create: async (chat, content) => {
        creates++;
        const id = `om_${creates}`;
        messages.push(remote(id, content));
        return id;
      },
      update: async (id, content) => {
        updates++;
        messages.find((m) => m.message_id === id).body.content = content;
        return id;
      },
      history: async () => messages,
      get: async (id) => messages.find((m) => m.message_id === id),
    };
    sender = new FeishuSender(store, credentials, api);
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function remote(id, content) {
    return {
      message_id: id,
      chat_id: credentials.testChatId,
      msg_type: 'interactive',
      sender: { id: credentials.appId, id_type: 'app_id', sender_type: 'app' },
      body: { content },
    };
  }
  function message(text = '/新建 p say hi', id = 'om_incoming', replyTo) {
    return {
      event_id: randomUUID(),
      app_id: credentials.appId,
      tenant_key: credentials.tenantKey,
      sender: { sender_type: 'user', sender_id: { open_id: credentials.allowedOpenId } },
      message: {
        message_id: id,
        chat_id: credentials.testChatId,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
        ...(replyTo ? { parent_id: replyTo } : {}),
      },
    };
  }
  const receive = async (text, id, replyTo) => {
    const result = inbox.receive('message', message(text, id, replyTo));
    await commands.processNext();
    return result;
  };
  function action(nonce, messageId = 'om_1') {
    return {
      event_id: randomUUID(),
      app_id: credentials.appId,
      tenant_key: credentials.tenantKey,
      operator: { open_id: credentials.allowedOpenId },
      context: { open_chat_id: credentials.testChatId, open_message_id: messageId },
      action: { value: { gatewayNonce: nonce } },
    };
  }
  function complete(task, id = 'thread-1') {
    store.claim(task.task_id, 'epoch');
    store.bindThread(task.task_id, id, dir, 'epoch');
    store.bindTurn(task.task_id, {
      id: `turn-${id}`,
      status: 'completed',
      items: [{ type: 'agentMessage', id: 'answer', text: 'done' }],
    });
  }
  async function clickUi(kind, matches = {}) {
    const row = db
      .prepare('SELECT * FROM feishu_actions WHERE action=? ORDER BY rowid DESC')
      .all(kind)
      .find((row) => Object.entries(matches).every(([key, value]) => row[key] === value));
    expect(row?.message_id).toBeTruthy();
    const result = inbox.receive('action', action(row.nonce, row.message_id));
    await commands.processNext();
    return { row, result };
  }
  it('saves a first natural-language request, renders projects, and submits it exactly once after a click', async () => {
    await receive('检查登录页面', 'om_natural');
    expect(store.list()).toHaveLength(0);
    expect(db.prepare('SELECT prompt FROM feishu_drafts').pluck().get()).toBe('检查登录页面');
    await sender.flushOne();
    expect(messages[0].body.content).toContain('无需重发');
    const { row, result } = await clickUi('project');
    expect(result.outcome).toBe('accepted');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].prompt).toBe('检查登录页面');
    expect(store.list()[0].project_key).toBe('p');
    expect(db.prepare('SELECT state FROM feishu_drafts').pluck().get()).toBe('submitted');
    expect(inbox.receive('action', action(row.nonce, row.message_id)).outcome).toBe('duplicate');
    await commands.processNext();
    expect(store.list()).toHaveLength(1);
  });
  it('keeps the saved request and project buttons usable across a database reopen', async () => {
    await receive('保留这条需求', 'om_draft');
    await sender.flushOne();
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, credentials);
    commands = new FeishuCommands(inbox, config, {
      catalog: async () => [],
      sessions: async () => ({ data: [], total: 0, available: true }),
    });
    await clickUi('project');
    expect(store.list()[0].prompt).toBe('保留这条需求');
  });
  it('rolls back draft consumption and task creation together when destination persistence fails', async () => {
    await receive('原子提交', 'om_draft');
    await sender.flushOne();
    db.exec(
      "CREATE TRIGGER reject_destination BEFORE INSERT ON task_destinations BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await clickUi('project');
    expect(store.list()).toHaveLength(0);
    expect(db.prepare('SELECT state FROM feishu_drafts').pluck().get()).toBe('pending');
    db.exec('DROP TRIGGER reject_destination');
    await commands.processNext(Date.now() + 3000);
    expect(store.list()).toHaveLength(1);
    expect(db.prepare('SELECT state FROM feishu_drafts').pluck().get()).toBe('submitted');
  });
  it('does not submit a draft twice when two different project buttons arrive', async () => {
    mkdirSync(join(dir, 'other'));
    config.projects.push({
      key: 'other',
      name: '其他项目',
      root: join(dir, 'other'),
      remoteWrite: true,
    });
    await receive('只执行一次', 'om_draft');
    await sender.flushOne();
    await clickUi('project', { project_key: 'p' });
    await clickUi('project', { project_key: 'other' });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].project_key).toBe('p');
    expect(db.prepare('SELECT project_key FROM user_context').pluck().get()).toBe('p');
  });
  it('keeps separate unselected messages separate instead of replacing the earlier draft', async () => {
    await receive('第一条需求', 'om_draft1');
    await receive('第二条需求', 'om_draft2');
    await sender.flushOne();
    await sender.flushOne();
    const drafts = db.prepare('SELECT draft_id FROM feishu_drafts ORDER BY rowid').all();
    await clickUi('project', { draft_id: drafts[0].draft_id });
    await clickUi('project', { draft_id: drafts[1].draft_id });
    expect(store.list().map((t) => t.prompt)).toEqual(['第一条需求', '第二条需求']);
  });
  it.each(['cancel', 'expired', 'revoked'])('does not execute a %s draft', async (reason) => {
    await receive('不能执行', 'om_draft');
    await sender.flushOne();
    if (reason === 'cancel') await clickUi('cancel_draft');
    if (reason === 'expired') db.prepare('UPDATE feishu_drafts SET expires_at=0').run();
    if (reason === 'revoked') config.projects[0].remoteWrite = false;
    await clickUi('project');
    expect(store.list()).toHaveLength(0);
    expect(db.prepare('SELECT count(*) FROM user_context').pluck().get()).toBe(0);
  });
  it('binds project controls to the exact message, chat and user', async () => {
    await receive('/项目', 'om_projects');
    await sender.flushOne();
    const row = db.prepare("SELECT * FROM feishu_actions WHERE action='project'").get();
    expect(inbox.receive('action', action(row.nonce, 'copied-message')).outcome).toBe(
      'expired-or-invalid',
    );
    const other = action(row.nonce, row.message_id);
    other.operator.open_id = 'ou_other';
    expect(inbox.receive('action', other).outcome).toBe('denied');
    other.operator.open_id = credentials.allowedOpenId;
    other.context.open_chat_id = 'oc_other';
    expect(inbox.receive('action', other).outcome).toBe('denied');
    await clickUi('project');
    expect(store.list()).toHaveLength(0);
    await receive('选好项目后直接聊', 'om_plain');
    expect(store.list()[0].prompt).toBe('选好项目后直接聊');
  });
  it('shows read-only and unavailable projects without granting execution and paginates usable choices', async () => {
    config.projects[0].remoteWrite = false;
    config.projects.push({
      key: 'missing',
      name: '不可用项目',
      root: join(dir, 'absent'),
      remoteWrite: true,
    });
    for (let i = 0; i < 6; i++) {
      mkdirSync(join(dir, `project-${i}`));
      config.projects.push({
        key: `p${i}`,
        name: `项目${i}`,
        root: join(dir, `project-${i}`),
        remoteWrite: true,
      });
    }
    await receive('翻页后执行', 'om_draft');
    await sender.flushOne();
    expect(messages[0].body.content).toContain('只读');
    expect(messages[0].body.content).toContain('路径失效');
    expect(
      db
        .prepare(
          "SELECT count(*) FROM feishu_actions WHERE action='project' AND project_key IN ('p','missing')",
        )
        .pluck()
        .get(),
    ).toBe(0);
    await clickUi('projects', { page: 1 });
    await sender.flushOne();
    await clickUi('project', { project_key: 'p5' });
    expect(store.list()[0].project_key).toBe('p5');
    expect(store.list()[0].prompt).toBe('翻页后执行');
  });
  it('offers configured projects when desktop project discovery is unavailable', async () => {
    commands = new FeishuCommands(inbox, config, {
      catalog: async () => {
        throw new Error('offline');
      },
      sessions: async () => ({ data: [], total: 0, available: true }),
    });
    await receive('离线时保存', 'om_offline');
    await sender.flushOne();
    expect(messages[0].body.content).toContain('暂时无法发现');
    await clickUi('project');
    expect(store.list()[0].status).toBe('queued');
  });
  it('keeps task cards concise, retains the reconciliation marker, and exposes details through a button', async () => {
    await receive('/新建 p 检查登录页面', 'om_task');
    const task = store.list()[0];
    complete(task);
    await sender.flushOne();
    const card = JSON.parse(messages[0].body.content);
    expect(card.header.title.content).toContain('GW-');
    expect(card.body.elements[1].content).toBe('**检查登录页面**');
    expect(messages[0].body.content).not.toContain('thread：');
    expect(messages[0].body.content).not.toContain('目录：');
    expect(messages[0].body.content).toContain(task.task_id);
    expect(messages[0].body.content).not.toContain('新话题');
    await clickUi('details');
    await sender.flushOne();
    expect(messages[1].body.content).toContain('会话 ID（thread）');
    expect(messages[1].body.content).toContain(task.task_id);
    expect(store.list()).toHaveLength(1);
    await receive('回复详情卡', 'om_reply_details', messages[1].message_id);
    expect(store.list().find((t) => t.status === 'queued').thread_id).toBe('thread-1');
  });
  it('switches to an explicitly selected topic and clears its thread for a new topic', async () => {
    await receive('/新建 p 旧话题', 'om_old');
    const first = store.list()[0];
    complete(first, 'thread-old');
    await sender.flushOne();
    await receive('/新建 p 其他话题', 'om_other');
    complete(
      store.list().find((t) => t.task_id !== first.task_id),
      'thread-other',
    );
    await sender.flushOne();
    await receive('/会话 p', 'om_sessions');
    await sender.flushOne();
    await clickUi('select', { task_id: first.task_id });
    await receive('接着聊原来的', 'om_continue');
    expect(store.list().find((t) => t.prompt === '接着聊原来的').thread_id).toBe('thread-old');
    await receive('/新话题', 'om_new_topic');
    expect(db.prepare('SELECT task_id FROM user_context').pluck().get()).toBeNull();
    await receive('独立话题', 'om_new');
    expect(store.list().find((t) => t.prompt === '独立话题').thread_id).toBeNull();
  });
  it('retains an early follow-up until thread binding and never routes it to a later project selection', async () => {
    mkdirSync(join(dir, 'other'));
    config.projects.push({
      key: 'other',
      name: '其他',
      root: join(dir, 'other'),
      remoteWrite: true,
    });
    await receive('/新建 p 第一个话题', 'om_first');
    const first = store.list()[0];
    await receive('第二条消息', 'om_early');
    expect(store.list()).toHaveLength(1);
    const queued = db
      .prepare('SELECT * FROM feishu_commands WHERE target_task_id=?')
      .get(first.task_id);
    expect(queued.state).toBe('received');
    await receive('/选择 other', 'om_switch');
    complete(first, 'thread-first');
    await commands.processNext(Date.now() + 2000);
    const second = store.list().find((t) => t.prompt === '第二条消息');
    expect(second.thread_id).toBe('thread-first');
    expect(second.project_key).toBe('p');
    expect(db.prepare('SELECT project_key FROM user_context').pluck().get()).toBe('other');
    expect(store.diagnostics().locks).toBe(0);
  });
  it('freezes a plain-message route before a persistence retry instead of following a later selection', async () => {
    mkdirSync(join(dir, 'other'));
    config.projects.push({
      key: 'other',
      name: '其他',
      root: join(dir, 'other'),
      remoteWrite: true,
    });
    await receive('/选择 p', 'om_pick');
    db.exec(
      "CREATE TRIGGER reject_destination BEFORE INSERT ON task_destinations BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await receive('不能发错项目', 'om_request');
    db.exec('DROP TRIGGER reject_destination');
    await receive('/选择 other', 'om_switch');
    await commands.processNext(Date.now() + 2000);
    expect(store.list()[0].project_key).toBe('p');
    expect(db.prepare('SELECT project_key FROM user_context').pluck().get()).toBe('other');
  });
  it('does not turn a saved draft into implicit work if its first confirmation is interrupted', async () => {
    db.exec(
      "CREATE TRIGGER fail_picker BEFORE INSERT ON outbox WHEN json_extract(NEW.payload,'$.title')='这项任务在哪个项目进行？' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await receive('保持等待选择', 'om_pending');
    expect(db.prepare('SELECT state FROM feishu_drafts').pluck().get()).toBe('pending');
    db.exec('DROP TRIGGER fail_picker');
    await receive('/选择 p', 'om_switch');
    await commands.processNext(Date.now() + 2000);
    expect(store.list()).toHaveLength(0);
    expect(db.prepare('SELECT state FROM feishu_drafts').pluck().get()).toBe('pending');
  });
  it('binds recovered taskless-card receipts before accepting project clicks, without resending the card', async () => {
    await receive('不要重复', 'om_draft');
    const create = api.create;
    api.create = async (...args) => {
      await create(...args);
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    const row = db.prepare("SELECT * FROM feishu_actions WHERE action='project'").get();
    expect(row.message_id).toBeNull();
    expect(inbox.receive('action', action(row.nonce, 'om_1')).outcome).toBe('expired-or-invalid');
    await sender.reconcileOne();
    expect(creates).toBe(1);
    await clickUi('project');
    expect(store.list()).toHaveLength(1);
  });
  it('migrates a populated v3 database without losing task buttons or ownership', async () => {
    await receive();
    const task = store.list()[0];
    const old = openGatewayDatabase(join(dir, 'v3.sqlite'));
    try {
      for (const m of migrationSources().slice(0, 3)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
        old.pragma(`user_version=${m.version}`);
      }
      old
        .prepare(
          `INSERT INTO tasks (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          task.task_id,
          task.request_key,
          task.fingerprint,
          task.owner_key,
          task.owner_json,
          task.project_key,
          task.cwd,
          task.prompt,
          task.status,
          task.created_at,
          task.updated_at,
        );
      old
        .prepare(
          "INSERT INTO outbox (outbox_id,logical_key,task_id,card_version,payload,state,created_at) VALUES ('old-out','old-key',?,1,'{}','delivered',1)",
        )
        .run(task.task_id);
      old
        .prepare(
          "INSERT INTO feishu_actions VALUES ('old-nonce','old-out',?,?,?,'old-message','select',9999999999999,NULL,NULL)",
        )
        .run(task.task_id, inbox.owner, credentials.testChatId);
      old.prepare('INSERT INTO feishu_runtime_lease VALUES (1,?,?)').run(process.pid, 'old');
      expect(() => migrate(old)).toThrow(/Gateway/);
      expect(old.pragma('user_version', { simple: true })).toBe(3);
      old.exec('DELETE FROM feishu_runtime_lease');
      migrate(old);
      expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(
        old.prepare("SELECT * FROM feishu_actions WHERE nonce='old-nonce'").get(),
      ).toMatchObject({
        task_id: task.task_id,
        owner_key: inbox.owner,
        message_id: 'old-message',
        action: 'select',
        draft_id: null,
        project_key: null,
        page: null,
      });
      expect(old.pragma('foreign_key_check')).toEqual([]);
    } finally {
      old.close();
    }
  });
  it('commits production inbox/command before SDK ACK; SQLite failure produces 500 and redelivery remains possible', async () => {
    const ws = new WSClient({ ...credentials, logger: silentLogger });
    const frames = [],
      counts = [];
    ws.eventDispatcher = inbox.dispatcher();
    ws.sendMessage = (frame) => {
      frames.push(JSON.parse(new TextDecoder().decode(frame.payload)));
      const observer = openReadonlyDatabase(join(dir, 'gateway.sqlite'));
      counts.push(observer.prepare('SELECT count(*) FROM feishu_commands').pluck().get());
      observer.close();
    };
    const data = message();
    const { event_id, app_id, tenant_key, ...event } = data;
    const envelope = {
      schema: '2.0',
      header: { event_id, app_id, tenant_key, event_type: 'im.message.receive_v1' },
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
      db.pragma('query_only = ON');
      await deliver();
      expect(frames[0].code).toBe(500);
      expect(counts).toEqual([0]);
      db.pragma('query_only = OFF');
      await deliver();
      await deliver();
      expect(frames.slice(1).map((f) => f.code)).toEqual([200, 200]);
      expect(counts).toEqual([0, 1, 1]);
      await commands.processNext();
      expect(store.list()).toHaveLength(1);
    } finally {
      db.pragma('query_only = OFF');
      ws.close({ force: true });
    }
  });
  it.each(['app_id', 'tenant_key', 'actor', 'chat', 'group'])(
    'rejects unauthorized %s without storing work',
    (field) => {
      const data = message();
      if (field === 'actor') data.sender.sender_id.open_id = 'ou_other';
      else if (field === 'chat') data.message.chat_id = 'oc_other';
      else if (field === 'group') data.message.chat_type = 'group';
      else data[field] = 'wrong';
      expect(inbox.receive('message', data).outcome).toBe('denied');
      expect(db.prepare('SELECT count(*) FROM feishu_commands').pluck().get()).toBe(0);
    },
  );
  it('deduplicates by event and message identity across reopened stores, with no second task', async () => {
    const data = message();
    inbox.receive('message', data);
    inbox.receive('message', data);
    inbox.receive('message', { ...data, event_id: randomUUID() });
    await commands.processNext();
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, credentials);
    expect(inbox.receive('message', { ...data, event_id: randomUUID() }).outcome).toBe('duplicate');
    expect(store.list()).toHaveLength(1);
  });
  it('rolls back task/command/outbox attachment together and retries the stored command after failure', async () => {
    inbox.receive('message', message());
    db.exec(
      "CREATE TRIGGER reject_destination BEFORE INSERT ON task_destinations BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await commands.processNext();
    expect(store.list()).toHaveLength(0);
    expect(db.prepare('SELECT state FROM feishu_commands').pluck().get()).toBe('failed');
    db.exec('DROP TRIGGER reject_destination');
    await commands.processNext(Date.now() + 2000);
    expect(store.list()).toHaveLength(1);
  });
  it('queues two submissions in the same checkout without taking a second execution slot', async () => {
    await receive('/新建 p first', 'om_a');
    await receive('/新建 p second', 'om_b');
    const tasks = store.list();
    expect(tasks).toHaveLength(2);
    expect(store.claim(tasks[0].task_id, 'e')).toBeTypeOf('string');
    expect(store.claim(tasks[1].task_id, 'e')).toBeNull();
  });
  it('binds old-card replies to that task despite a more recent selection, and rejects ambiguous context', async () => {
    await receive('/新建 p first', 'om_a');
    const first = store.list()[0];
    complete(first, 'thread-a');
    await sender.flushOne();
    await receive('/新建 p second', 'om_b');
    const second = store.list().find((t) => t.task_id !== first.task_id);
    complete(second, 'thread-b');
    await sender.flushOne();
    await receive('continue old card', 'om_reply', 'om_1');
    const third = store.list().find((t) => t.status === 'queued');
    expect(third.thread_id).toBe('thread-a');
    await receive(`/继续 ${second.task_id} mismatch`, 'om_conflict', 'om_1');
    expect(store.list()).toHaveLength(3);
    await receive('unrelated reply', 'om_unknown', 'om_unmapped');
    expect(store.list()).toHaveLength(3);
  });
  it('deduplicates refresh clicks and refuses copied/expired nonces without executing tasks', async () => {
    await receive();
    await sender.flushOne();
    const nonce = db
      .prepare("SELECT nonce FROM feishu_actions WHERE action='refresh'")
      .pluck()
      .get();
    expect(inbox.receive('action', action(nonce, 'om_other')).outcome).toBe('expired-or-invalid');
    expect(inbox.receive('action', action(nonce)).outcome).toBe('accepted');
    expect(inbox.receive('action', action(nonce)).outcome).toBe('duplicate');
    await commands.processNext();
    await sender.flushOne();
    expect(store.list()).toHaveLength(1);
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    db.prepare('UPDATE feishu_actions SET expires_at=0 WHERE nonce=?').run(nonce);
    expect(inbox.receive('action', action(nonce)).outcome).toBe('expired-or-invalid');
  });
  it('rejects colliding short IDs and removed project authorization', async () => {
    await receive();
    const task = store.list()[0];
    expect(() => commands.resolveTask(task.task_id.slice(0, 7))).toThrow(/8/);
    // Prefix collision is exercised with a cloned task, keeping identity constraints distinct.
    db.prepare(
      `INSERT INTO tasks (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,status,created_at,updated_at)
      SELECT ?,?,fingerprint,owner_key,owner_json,project_key,cwd,prompt,status,created_at,updated_at FROM tasks WHERE task_id=?`,
    ).run(task.task_id.slice(0, 8) + '-other', 'distinct', task.task_id);
    expect(() => commands.resolveTask(task.task_id.slice(0, 8))).toThrow(/冲突/);
    config.projects[0].remoteWrite = false;
    await receive('/新建 p forbidden', 'om_denied');
    expect(store.list()).toHaveLength(2);
  });
  it('reconciles a successfully sent card whose response is lost without another POST', async () => {
    await receive();
    const realCreate = api.create;
    api.create = async (...args) => {
      await realCreate(...args);
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    expect(db.prepare('SELECT state FROM outbox').pluck().get()).toBe('unknown');
    complete(store.list()[0]);
    expect(await sender.flushOne()).toBe(false);
    await sender.reconcileOne();
    expect(store.list()[0].notification_message_id).toBe('om_1');
    await sender.flushOne();
    expect(creates).toBe(1);
    expect(updates).toBe(1);
    expect(messages[0].body.content).toContain('执行完成');
  });
  it('keeps unknown when remote receipt is absent, foreign, or ambiguous', async () => {
    await receive();
    api.create = async () => {
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    const row = db.prepare('SELECT * FROM outbox').get();
    messages.push({
      ...remote('om_fake', receiptMarker(row.outbox_id)),
      sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app' },
    });
    await sender.reconcileOne();
    expect(db.prepare('SELECT state FROM outbox').pluck().get()).toBe('unknown');
    messages = [
      remote('om_one', receiptMarker(row.outbox_id)),
      remote('om_two', receiptMarker(row.outbox_id)),
    ];
    await sender.reconcileOne(Date.now() + 31000);
    expect(db.prepare('SELECT state FROM outbox').pluck().get()).toBe('unknown');
    expect(await sender.flushOne()).toBe(false);
  });
  it('reconciles JSON 2.0 preview-only receipts from IM history and message GET', async () => {
    await receive();
    const preview = (content) => {
      const card = JSON.parse(content);
      return JSON.stringify({
        title: card.header.title.content,
        elements: [[{ tag: 'text', text: '请使用飞书客户端查看卡片' }]],
      });
    };
    api.create = async (chat, content) => {
      creates++;
      messages.push(remote('om_preview', preview(content)));
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    await sender.reconcileOne();
    expect(store.list()[0].notification_message_id).toBe('om_preview');
    const task = store.list()[0];
    store.refresh(task.task_id);
    api.update = async (id, content) => {
      updates++;
      messages[0].body.content = preview(content);
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    complete(task);
    expect(await sender.flushOne()).toBe(false);
    await sender.reconcileOne();
    expect(db.prepare("SELECT count(*) FROM outbox WHERE state='unknown'").pluck().get()).toBe(0);
    expect(creates).toBe(1);
    expect(updates).toBe(1);
  });
  it('does not retry a stale PATCH over a terminal update; reconciles its exact receipt first', async () => {
    await receive();
    await sender.flushOne();
    const task = store.list()[0];
    store.refresh(task.task_id);
    const realUpdate = api.update;
    api.update = async (...args) => {
      await realUpdate(...args);
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    complete(task);
    expect(await sender.flushOne()).toBe(false);
    await sender.reconcileOne();
    api.update = realUpdate;
    await sender.flushOne();
    expect(creates).toBe(1);
    expect(updates).toBe(2);
    expect(messages[0].body.content).toContain('执行完成');
  });
  async function losePatch() {
    await receive();
    await sender.flushOne();
    const task = store.list()[0];
    store.refresh(task.task_id);
    let lateContent;
    api.update = async (_id, content) => {
      updates++;
      lateContent = content;
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    const blocked = db.prepare("SELECT * FROM outbox WHERE state='unknown'").get();
    return { task, blocked, lateContent, now: blocked.sent_at + 60_001 };
  }
  function terminalNotice(task) {
    return db
      .prepare('SELECT * FROM outbox WHERE logical_key=?')
      .get(terminalNoticeKey(task.task_id));
  }
  it('delivers one independent terminal notice after an unresolved PATCH, retaining the unknown request and original binding', async () => {
    const { task, blocked, now } = await losePatch();
    complete(task);
    await sender.reconcileOne(blocked.sent_at + 59_999);
    expect(terminalNotice(task)).toBeUndefined();
    await sender.reconcileOne(now);
    const notice = terminalNotice(task);
    expect(notice.task_id).toBeNull();
    expect(JSON.parse(notice.payload)).toMatchObject({
      sourceTaskId: task.task_id,
      sourceOutboxId: blocked.outbox_id,
      sourceMessageId: 'om_1',
    });
    await sender.flushOne();
    expect(creates).toBe(2);
    expect(updates).toBe(1);
    expect(messages[1].body.content).toContain('补充通知 · 执行完成');
    expect(messages[1].body.content).toContain('done');
    expect(messages[1].body.content).toContain('旧卡可能显示过时状态');
    expect(
      db.prepare('SELECT state FROM outbox WHERE outbox_id=?').pluck().get(blocked.outbox_id),
    ).toBe('unknown');
    expect(store.get(task.task_id).notification_message_id).toBe('om_1');
    expect(
      db
        .prepare('SELECT count(*) FROM feishu_actions WHERE outbox_id=?')
        .pluck()
        .get(notice.outbox_id),
    ).toBe(0);
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    sender = new FeishuSender(store, credentials, api);
    store.refresh(task.task_id);
    await sender.reconcileOne(now + 60_000);
    expect(await sender.flushOne()).toBe(false);
    expect(terminalNotice(task).outbox_id).toBe(notice.outbox_id);
    expect(creates).toBe(2);
    expect(store.diagnostics().locks).toBe(0);
  });
  it('keeps the fallback POST unknown after a lost response and reconciles without sending a third card', async () => {
    const { task, now } = await losePatch();
    complete(task);
    await sender.reconcileOne(now);
    const realCreate = api.create;
    api.create = async (...args) => {
      await realCreate(...args);
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    expect(terminalNotice(task).state).toBe('unknown');
    await sender.reconcileOne(now);
    expect(terminalNotice(task).state).toBe('delivered');
    await sender.reconcileOne(now + 60_000);
    expect(await sender.flushOne()).toBe(false);
    expect(creates).toBe(2);
    expect(store.get(task.task_id).notification_message_id).toBe('om_1');
  });
  it('isolates a delayed old PATCH from the fallback and still reconciles the original card normally', async () => {
    const { task, now, lateContent } = await losePatch();
    complete(task);
    await sender.reconcileOne(now);
    await sender.flushOne();
    const deliveredNotice = messages[1].body.content;
    messages[0].body.content = lateContent;
    await sender.reconcileOne(now + 31_000);
    api.update = async (id, content) => {
      updates++;
      messages.find((m) => m.message_id === id).body.content = content;
      return id;
    };
    await sender.flushOne();
    expect(messages[0].body.content).toContain('执行完成');
    expect(messages[1].body.content).toBe(deliveredNotice);
    expect(creates).toBe(2);
    expect(updates).toBe(2);
    expect(db.prepare("SELECT count(*) FROM outbox WHERE state='unknown'").pluck().get()).toBe(0);
  });
  it('can deliver terminal evidence even while GET fails, without treating the old PATCH as failed', async () => {
    const { task, blocked, now } = await losePatch();
    complete(task);
    api.get = async () => {
      throw new FeishuApiError('not-sent');
    };
    await sender.reconcileOne(now);
    await sender.flushOne();
    expect(terminalNotice(task).state).toBe('delivered');
    expect(
      db.prepare('SELECT state FROM outbox WHERE outbox_id=?').pluck().get(blocked.outbox_id),
    ).toBe('unknown');
    expect(updates).toBe(1);
  });
  it.each(['active-task', 'foreign-owner', 'foreign-chat', 'unbound-card'])(
    'does not create terminal fallback for %s',
    async (reason) => {
      const { task, now } = await losePatch();
      if (reason !== 'active-task') complete(task);
      if (reason === 'foreign-owner')
        db.prepare("UPDATE outbox SET owner_key='another' WHERE state='unknown'").run();
      if (reason === 'foreign-chat')
        db.prepare("UPDATE task_destinations SET chat_id='oc_another'").run();
      if (reason === 'unbound-card')
        db.prepare("UPDATE tasks SET notification_message_id='om_another'").run();
      await sender.reconcileOne(now);
      expect(terminalNotice(task)).toBeUndefined();
      expect(creates).toBe(1);
    },
  );
  it('does not turn an unresolved initial POST into a second card even after the task ends', async () => {
    await receive();
    api.create = async () => {
      creates++;
      throw new FeishuApiError('unknown');
    };
    await sender.flushOne();
    const task = store.list()[0];
    complete(task);
    await sender.reconcileOne(Date.now() + 120_000);
    expect(terminalNotice(task)).toBeUndefined();
    expect(await sender.flushOne()).toBe(false);
    expect(creates).toBe(1);
  });
  it('honors Retry-After and keeps a permanent notification failure separate from execution status', async () => {
    await receive();
    api.create = async () => {
      throw new FeishuApiError('retryable-rejection', 429, 99991400, 90_000);
    };
    await sender.flushOne();
    expect(db.prepare('SELECT next_retry_at FROM outbox').pluck().get()).toBeGreaterThan(
      Date.now() + 89_000,
    );
    expect(store.list()[0].status).toBe('queued');
    db.prepare('UPDATE outbox SET next_retry_at=0').run();
    api.create = async () => {
      throw new FeishuApiError('permanent', 403, 99991672);
    };
    await sender.flushOne();
    expect(db.prepare('SELECT state FROM outbox').pluck().get()).toBe('failed');
    expect(store.list()[0].status).toBe('queued');
  });
  it('explains a writer conflict in both the task card and status response without suggesting a model failure', async () => {
    await receive();
    const task = store.list()[0];
    store.fail(task.task_id, 'thread_start', 'thread_writer_conflict');
    await sender.flushOne();
    expect(messages[0].body.content).toContain('模型任务尚未启动');
    expect(messages[0].body.content).toContain('系统不会自动重试');
    await receive(`/状态 ${task.task_id}`, 'om_status');
    await sender.flushOne();
    expect(messages[1].body.content).toContain('会话被另一个 Codex 进程占用');
  });
  it('recovers a verified user message via history using the original business key', async () => {
    await receive();
    const actual = {
      message_id: 'om_incoming',
      chat_id: credentials.testChatId,
      msg_type: 'text',
      sender: {
        id: credentials.allowedOpenId,
        id_type: 'open_id',
        sender_type: 'user',
        tenant_key: credentials.tenantKey,
      },
      body: { content: JSON.stringify({ text: '/新建 p say hi' }) },
    };
    expect(inbox.recoverMessage(actual).outcome).toBe('duplicate');
    expect(store.list()).toHaveLength(1);
    expect(() =>
      inbox.recoverMessage({ ...actual, sender: { ...actual.sender, id: 'ou_other' } }),
    ).toThrow();
  });
  it('migrates an actual v1 database without losing tasks/outbox and refuses a live old worker', () => {
    const old = openGatewayDatabase(join(dir, 'old.sqlite'));
    const v1 = migrationSources()[0];
    old.exec(v1.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (1,?)').run(v1.checksum);
    old.pragma('user_version=1');
    old
      .prepare(
        "INSERT INTO tasks (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,status,created_at,updated_at) VALUES ('t','r','f','o','{}','p',?,'keep','queued',1,1)",
      )
      .run(dir);
    old.exec(
      "INSERT INTO outbox (outbox_id,logical_key,task_id,card_version,payload,state,created_at) VALUES ('o','l','t',1,'{}','pending',1)",
    );
    old.prepare('INSERT INTO worker_lease VALUES (1,?,?)').run('token', process.pid);
    expect(() => migrate(old)).toThrow(/worker/);
    expect(old.pragma('user_version', { simple: true })).toBe(1);
    old.exec('DELETE FROM worker_lease');
    migrate(old);
    expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(old.prepare('SELECT prompt FROM tasks').pluck().get()).toBe('keep');
    expect(old.prepare('SELECT task_id FROM outbox').pluck().get()).toBe('t');
    old.close();
  });
  it('CLI backup preserves v1 BEFORE any automatic schema upgrade', async () => {
    const legacyDir = join(dir, 'legacy');
    mkdirSync(legacyDir, { mode: 0o700 });
    const old = openGatewayDatabase(join(legacyDir, 'gateway.sqlite'));
    const v1 = migrationSources()[0];
    old.exec(v1.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (1,?)').run(v1.checksum);
    old.pragma('user_version=1');
    old.close();
    const destination = join(dir, 'pre-m3.sqlite');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(
        await runTaskCli(
          'db-backup',
          ['db-backup'],
          { destination },
          { ...config, dataDir: legacyDir },
        ),
      ).toBe(0);
    } finally {
      output.mockRestore();
    }
    for (const file of [destination, join(legacyDir, 'gateway.sqlite')]) {
      const check = openReadonlyDatabase(file);
      expect(check.pragma('user_version', { simple: true })).toBe(1);
      expect(
        check.prepare("SELECT 1 FROM sqlite_schema WHERE name='feishu_commands'").get(),
      ).toBeUndefined();
      check.close();
    }
  });
});

describe('Feishu HTTP outcome classification without network retries', () => {
  const response = (body, status = 200, headers = {}) =>
    new globalThis.Response(JSON.stringify(body), { status, headers });
  it.each([
    [429, 99991400, 'retryable-rejection'],
    [400, 99991400, 'retryable-rejection'],
    [400, 230020, 'retryable-rejection'],
    [403, 99991672, 'permanent'],
    [503, 999, 'unknown'],
  ])('classifies HTTP %s / code %s', async (status, code, outcome) => {
    let calls = 0;
    const api = new FeishuApi(credentials, async () => {
      calls++;
      return calls === 1
        ? response({ code: 0, tenant_access_token: 'secret', expire: 7200 })
        : response({ code }, status, { 'x-ogw-ratelimit-reset': '60' });
    });
    await api.prepare();
    await expect(api.create('oc_chat', '{}', 'uuid')).rejects.toMatchObject({ outcome });
    expect(calls).toBe(2);
  });
  it('treats network loss and a malformed success receipt as unknown, never automatic retry', async () => {
    for (const transport of [
      async () => {
        throw new Error('sensitive-network-detail');
      },
      async () => response({ code: 0, data: {} }),
    ]) {
      let calls = 0;
      const api = new FeishuApi(credentials, async () =>
        ++calls === 1
          ? response({ code: 0, tenant_access_token: 'secret', expire: 7200 })
          : transport(),
      );
      await api.prepare();
      await expect(api.create('oc_chat', '{}', 'uuid')).rejects.toMatchObject({
        outcome: 'unknown',
      });
      expect(calls).toBe(2);
    }
  });
});
