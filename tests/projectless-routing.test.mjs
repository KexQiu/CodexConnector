import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { FeishuSender } from '../src/feishu/sender.ts';
import { executionTarget } from '../src/conversations/execution.ts';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/conversations/directories.ts', async (original) => {
  const module = await original();
  return {
    ...module,
    ConversationDirectories: class extends module.ConversationDirectories {
      constructor(dataDir) {
        super(dataDir, join(fixture.root, 'Conversations'));
      }
    },
  };
});
const credentials = {
  appId: 'cli_np',
  appSecret: 'fixture',
  tenantKey: 't',
  allowedOpenId: 'u',
  testChatId: 'oc_np',
};
let db, store, inbox, commands, config, sender, cards, capability;
function wire() {
  store = new TaskStore(db);
  inbox = new FeishuInbox(store, credentials);
  commands = new FeishuCommands(
    inbox,
    config,
    { catalog: async () => [], sessions: async () => ({ data: [], total: 0, available: true }) },
    { projectlessAvailable: () => capability, projectlessReason: () => '能力检查未通过' },
  );
  sender = new FeishuSender(
    store,
    credentials,
    {
      prepare: async () => {},
      create: async (_, content) => {
        const id = `om_${cards.length}`;
        cards.push({ id, content });
        return id;
      },
      update: async (id, content) => {
        cards.find((card) => card.id === id).content = content;
        return id;
      },
    },
    config.projects,
  );
}
beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-np-routing-')));
  const dataDir = join(fixture.root, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(fixture.root, 'project'));
  config = {
    dataDir,
    projectless: { enabled: true },
    maxConcurrentTasks: 2,
    feishu: credentials,
    projects: [{ key: 'p', name: 'P', root: join(fixture.root, 'project'), remoteWrite: true }],
  };
  db = openGatewayDatabase(join(dataDir, 'gateway.sqlite'));
  cards = [];
  capability = true;
  wire();
});
afterEach(() => {
  db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});
async function receive(text, id = randomUUID(), replyTo) {
  const result = inbox.receive('message', {
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
  });
  await commands.processNext();
  return result;
}
async function flush() {
  for (let i = 0; i < 30 && (await sender.flushOne()); i++);
}
async function click(action, match = {}) {
  const row = db
    .prepare('SELECT * FROM feishu_actions WHERE action=? ORDER BY rowid DESC')
    .all(action)
    .find((row) => Object.entries(match).every(([k, v]) => row[k] === v));
  expect(row?.message_id).toBeTruthy();
  inbox.receive('action', {
    event_id: randomUUID(),
    app_id: credentials.appId,
    tenant_key: credentials.tenantKey,
    operator: { open_id: credentials.allowedOpenId },
    context: { open_chat_id: credentials.testChatId, open_message_id: row.message_id },
    action: { value: { gatewayNonce: row.nonce } },
  });
  await commands.processNext();
}
const context = () => store.conversations.context(inbox.owner, credentials.testChatId);
const notices = () =>
  db.prepare('SELECT payload FROM outbox WHERE task_id IS NULL').pluck().all().join('\n');
it('lazily creates one conversation for consecutive first messages, persists the route, and deduplicates redelivery', async () => {
  config.projects = [];
  await receive('记住代号 ALPHA', 'first');
  await receive('代号是什么', 'second');
  await receive('代号是什么', 'second');
  const tasks = store.list();
  expect(tasks).toHaveLength(2);
  expect(new Set(tasks.map((task) => task.conversation_id)).size).toBe(1);
  expect(tasks.every((task) => task.project_key === null && task.thread_id === null)).toBe(true);
  expect(context().scope_kind).toBe('projectless');
  expect(
    db
      .prepare(
        'SELECT target_resolved,target_scope_kind,target_conversation_id FROM feishu_commands',
      )
      .all(),
  ).toEqual(
    [1, 2].map(() => ({
      target_resolved: 1,
      target_scope_kind: 'projectless',
      target_conversation_id: tasks[0].conversation_id,
    })),
  );
  const target = executionTarget(store, config, tasks[0]);
  expect(target.policy.thread).toMatchObject({
    environments: [],
    dynamicTools: [],
    selectedCapabilityRoots: [],
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  expect(target.policy.turn).toMatchObject({
    environments: [],
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
  expect(readdirSync(tasks[0].cwd)).toEqual([]);
});
it('freezes conversation and scope before a failed submit; a later project choice does not retarget retry', async () => {
  db.exec(
    "CREATE TRIGGER reject_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await receive('原消息');
  const target = db.prepare('SELECT target_conversation_id FROM feishu_commands').pluck().get();
  expect(target).toBeTruthy();
  db.exec('DROP TRIGGER reject_task');
  await receive('/选择 p');
  await commands.processNext(Date.now() + 3000);
  expect(store.list()).toHaveLength(1);
  expect(store.list()[0].conversation_id).toBe(target);
  expect(context().project_key).toBe('p');
});
it('lists history without changing selection, lazily starts a second conversation, and switches back without executing', async () => {
  await receive('第一会话');
  const first = store.list()[0];
  await receive('/选择 p');
  const selected = context();
  await receive('/会话 无项目');
  await flush();
  expect(context()).toEqual(selected);
  await click('projectless_new');
  expect(context()).toMatchObject({
    scope_kind: 'projectless',
    conversation_id: null,
    task_id: null,
  });
  expect(db.prepare('SELECT count(*) FROM conversations').pluck().get()).toBe(1);
  await receive('第二会话');
  expect(new Set(store.list().map((t) => t.conversation_id)).size).toBe(2);
  await receive('/会话 无项目');
  await flush();
  await click('select', { task_id: first.task_id });
  expect(store.list()).toHaveLength(2);
  expect(context().conversation_id).toBe(first.conversation_id);
  await receive('继续第一会话');
  expect(store.list().find((t) => t.prompt === '继续第一会话').conversation_id).toBe(
    first.conversation_id,
  );
});
it('prefers an owned quoted task over current project selection and rejects an unknown reply without fallback', async () => {
  await receive('无项目任务');
  await flush();
  const first = store.list()[0];
  await receive('/选择 p');
  await receive('引用无项目', randomUUID(), store.get(first.task_id).notification_message_id);
  expect(store.list().find((t) => t.prompt === '引用无项目').conversation_id).toBe(
    first.conversation_id,
  );
  await receive('无效引用', randomUUID(), 'om_foreign');
  expect(store.list()).toHaveLength(2);
});
it('rejects disabled/unverified execution but keeps history and project work available', async () => {
  await receive('既有会话');
  const first = store.list()[0];
  config.projectless.enabled = false;
  await receive('禁止续聊');
  await receive('/继续 ' + first.task_id + ' 禁止显式续聊');
  await receive('/新建 无项目 禁止新建');
  expect(store.list()).toHaveLength(1);
  await receive('/会话 无项目');
  expect(notices()).toContain('既有会话');
  config.projectless.enabled = true;
  capability = false;
  await receive('能力失败');
  expect(store.list()).toHaveLength(1);
  await receive('/新建 p 项目不受影响');
  expect(store.list()).toHaveLength(2);
  expect(notices()).toContain('能力检查未通过');
});
it('rejects an invalid project and unattributed legacy selection instead of falling back to ordinary chat', async () => {
  store.setContext(inbox.owner, 'missing', null, credentials.testChatId);
  await receive('不能回退');
  expect(store.list()).toHaveLength(0);
  db.prepare('DELETE FROM user_context').run();
  store.setContext(inbox.owner, 'missing', null);
  await receive('缺少归属');
  expect(notices()).toContain('旧选中态');
  expect(store.list()).toHaveLength(0);
});
it('preserves the exact conversation after database reopen and rejects a lost or replaced directory', async () => {
  await receive('跨重启');
  const first = store.list()[0];
  db.close();
  db = openGatewayDatabase(join(config.dataDir, 'gateway.sqlite'));
  wire();
  await receive('重启续聊');
  expect(store.list()[1].conversation_id).toBe(first.conversation_id);
  rmSync(first.cwd, { recursive: true });
  await receive('目录已丢失');
  expect(store.list()).toHaveLength(2);
  expect(notices()).toContain('丢失或被替换');
});
it('does not accept a task from another chat, even if the owner and task id are known', async () => {
  const task = store.submit({
    owner: { tenantKey: 't', appId: 'cli_np', openId: 'u' },
    chatId: 'oc_foreign',
    requestKey: 'foreign',
    projectKey: 'p',
    cwd: config.projects[0].root,
    prompt: 'private',
  }).task;
  await receive('/继续 ' + task.task_id + ' 不可执行');
  expect(store.list()).toHaveLength(1);
  expect(notices()).toContain('归属不匹配');
});
it('keeps projectless first on every project page without reducing the six real project slots', async () => {
  config.projects = Array.from({ length: 14 }, (_, i) => ({ ...config.projects[0], key: 'p' + i }));
  await receive('/项目');
  await flush();
  let card = JSON.parse(
    db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').pluck().get(),
  );
  expect(card.layout.sections[0].title).toBe('无项目');
  expect(card.buttons.filter((b) => b.action === 'project')).toHaveLength(6);
  await click('projects', { page: 1 });
  await flush();
  card = JSON.parse(
    db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').pluck().get(),
  );
  expect(card.layout.sections[0].title).toBe('无项目');
  expect(card.buttons.filter((b) => b.action === 'project')).toHaveLength(6);
});

it('does not let a later message overtake an earlier submission awaiting persistence retry', async () => {
  db.exec(
    "CREATE TRIGGER reject_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await receive('第一条');
  const firstConversation = context().conversation_id;
  db.exec('DROP TRIGGER reject_task');
  await receive('第二条');
  const second = store.list()[0];
  expect(second.conversation_id).toBe(firstConversation);
  expect(store.claim(second.task_id, 'epoch')).toBeNull();
  await commands.processNext(Date.now() + 3000);
  const first = store.list().find((task) => task.prompt === '第一条');
  expect(first.conversation_id).toBe(firstConversation);
  expect(store.queued(inbox.owner).map((task) => task.task_id)).toEqual([
    first.task_id,
    second.task_id,
  ]);
  expect(store.claim(second.task_id, 'epoch')).toBeNull();
  expect(store.claim(first.task_id, 'epoch')).toBeTypeOf('string');
});
