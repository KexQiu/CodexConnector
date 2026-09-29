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
import { queueNotice } from '../src/feishu/conversation-ui.ts';
import { gatewaySessionCard, copyIdCard, resultCard } from '../src/feishu/session-cards.ts';
import { resultPages, resultMarkdown } from '../src/feishu/result-pages.ts';
import { buttonStyle } from '../src/feishu/card-layout.ts';
import { migrate, migrationSources, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
const creds = {
  appId: 'cli_fixture',
  appSecret: 'fixture',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_user',
  testChatId: 'oc_fixture',
};
const owner = { appId: creds.appId, tenantKey: creds.tenantKey, openId: creds.allowedOpenId };
const walk = (x) => (x && typeof x === 'object' ? [x, ...Object.values(x).flatMap(walk)] : []);
describe('session navigation, complete replies and ID copy entry', () => {
  let dir, db, store, inbox, commands, sender, messages, projects, config;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-navigation-')));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    inbox = new FeishuInbox(store, creds);
    config = {
      feishu: creds,
      projects: [{ key: 'p', name: '测试项目', root: dir, remoteWrite: true }],
    };
    messages = [];
    projects = {
      catalog: async () => [],
      sessions: async () => ({
        available: true,
        total: 1,
        data: [
          {
            id: 'desktop-id',
            name: '桌面标题',
            preview: '桌面摘要',
            updatedAt: 1700000000,
            status: { type: 'idle' },
          },
        ],
      }),
    };
    commands = new FeishuCommands(inbox, config, projects);
    sender = new FeishuSender(store, creds, {
      prepare: async () => {},
      create: async (chat, wire) => {
        const id = 'om_' + messages.length;
        messages.push({ id, card: JSON.parse(wire) });
        return id;
      },
      update: async (id, wire) => {
        messages.find((m) => m.id === id).card = JSON.parse(wire);
        return id;
      },
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function receive(text, replyTo) {
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
        ...(replyTo ? { parent_id: replyTo } : {}),
      },
    });
    await commands.processNext();
  }
  async function flush() {
    for (let i = 0; i < 40 && (await sender.flushOne()); i++);
  }
  async function task(prompt, thread = 'thread-' + randomUUID(), output = '结果') {
    await receive('/新建 p ' + prompt);
    const task = store.list(inbox.owner).find((t) => t.prompt === prompt);
    store.claim(task.task_id, 'e');
    store.bindThread(task.task_id, thread, dir, 'e');
    store.bindTurn(task.task_id, {
      id: 'turn-' + randomUUID(),
      status: 'completed',
      items: [{ id: 'answer', type: 'agentMessage', text: output }],
    });
    await flush();
    return store.get(task.task_id);
  }
  function action(row, eventId = randomUUID()) {
    return {
      event_id: eventId,
      app_id: creds.appId,
      tenant_key: creds.tenantKey,
      operator: { open_id: creds.allowedOpenId },
      context: { open_chat_id: creds.testChatId, open_message_id: row.message_id },
      action: { value: { gatewayNonce: row.nonce } },
    };
  }
  async function click(kind, filter = {}) {
    const row = db
      .prepare('SELECT * FROM feishu_actions WHERE action=? ORDER BY rowid DESC')
      .all(kind)
      .find((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
    expect(row).toBeTruthy();
    const event = action(row);
    const result = inbox.receive('action', event);
    await commands.processNext();
    await flush();
    return { row, event, result };
  }
  it('all user-facing action styles retain a border, including refresh/project switches', () => {
    for (const [kind, choice] of [
      ['refresh'],
      ['projects'],
      ['panel', 'refresh'],
      ['select'],
      ['details'],
      ['copy_id'],
      ['sessions'],
      ['result'],
      ['approval'],
      ['interrupt'],
    ])
      expect(['default', 'primary', 'danger']).toContain(buttonStyle(kind, choice));
  });
  it('groups turns by thread, marks current selection and excludes other owners/projects', async () => {
    const first = await task('第一轮', 'shared');
    await receive('/继续 ' + first.task_id + ' 第二轮');
    const next = store.list().find((t) => t.prompt === '第二轮');
    db.prepare(
      "UPDATE tasks SET status='completed',created_at=created_at+1000 WHERE task_id=?",
    ).run(next.task_id);
    const other = await task('另一会话');
    store.submit({
      owner: { ...owner, openId: 'other' },
      requestKey: 'foreign',
      projectKey: 'p',
      cwd: dir,
      prompt: 'SECRET_OTHER_OWNER',
    });
    const card = gatewaySessionCard(store, inbox.owner, 'p', '项目', other, 0);
    expect(card.layout.status).toContain('2 个会话');
    expect(card.layout.sections.some((s) => s.notes?.some((n) => n.includes('2 轮')))).toBe(true);
    expect(card.layout.sections.filter((s) => s.title.startsWith('当前'))).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain('SECRET_OTHER_OWNER');
  });
  it('switches in place without creating a task, retires old buttons, and deduplicates redelivery', async () => {
    const a = await task('话题 A');
    await task('话题 B');
    await receive('/会话 p');
    await flush();
    const before = store.list().length;
    const { row, event } = await click('select', { task_id: a.task_id });
    expect(db.prepare('SELECT task_id FROM user_context').pluck().get()).toBe(a.task_id);
    expect(inbox.receive('action', event).outcome).toBe('duplicate');
    expect(inbox.receive('action', action(row)).outcome).toBe('expired-or-invalid');
    await click('details', { task_id: a.task_id });
    expect(store.list()).toHaveLength(before);
  });
  it('keeps task cards in their task update lane when selecting or opening a browsing view', async () => {
    const a = await task('A');
    await task('B');
    store.refresh(a.task_id);
    await flush();
    const original = store.get(a.task_id).notification_message_id;
    const count = messages.length;
    await click('select', { task_id: a.task_id, message_id: original });
    expect(messages).toHaveLength(count);
    expect(store.get(a.task_id).notification_message_id).toBe(original);
    await click('details', { task_id: a.task_id, message_id: original });
    expect(messages).toHaveLength(count + 1);
    expect(messages.at(-1).id).not.toBe(original);
    expect(store.get(a.task_id).notification_message_id).toBe(original);
    expect(
      db
        .prepare('SELECT count(*) FROM outbox WHERE task_id IS NOT NULL AND view_id IS NOT NULL')
        .pluck()
        .get(),
    ).toBe(0);
  });
  it('does not infer a target when replying to a multi-session list', async () => {
    await task('A');
    await task('B');
    await receive('/会话 p');
    await flush();
    const message = messages.at(-1).id;
    const count = store.list().length;
    await receive('继续处理', message);
    await flush();
    expect(store.list()).toHaveLength(count);
    expect(JSON.stringify(messages.at(-1))).toContain('没有唯一会话');
  });
  it('places each list action beside its row and keeps all rows to two bordered buttons', async () => {
    await task('A');
    await task('B');
    await receive('/会话 p');
    await flush();
    const card = messages.at(-1).card;
    const nodes = walk(card);
    const buttons = nodes.filter((n) => n.tag === 'button');
    expect(buttons.filter((b) => b.text.content === '复制 ID')).toHaveLength(0);
    expect(nodes.filter((n) => n.tag === 'markdown' && /^```\n/.test(n.content))).toHaveLength(2);
    expect(buttons.every((b) => ['primary', 'default', 'danger'].includes(b.type))).toBe(true);
    expect(nodes.filter((n) => n.tag === 'column_set').every((n) => n.columns.length <= 2)).toBe(
      true,
    );
  });
  it('renders IDs directly on the original cards without a copy callback or extra ID card', async () => {
    const a = await task('可复制任务');
    const count = store.list().length;
    const before = db.prepare('SELECT * FROM user_context').all();
    expect(
      walk(messages.at(-1).card).some(
        (n) => n.tag === 'markdown' && n.content === '```\n' + a.task_id + '\n```',
      ),
    ).toBe(true);
    expect(
      db.prepare("SELECT count(*) FROM feishu_actions WHERE action='copy_id'").pluck().get(),
    ).toBe(0);
    const { event } = await click('details', { task_id: a.task_id });
    const texts = walk(messages.at(-1).card)
      .filter((n) => n.tag === 'markdown')
      .map((n) => n.content);
    expect(texts).toContain('```\n' + a.task_id + '\n```');
    expect(texts).toContain('```\n' + a.thread_id + '\n```');
    expect(JSON.stringify(messages.at(-1))).not.toContain('已复制');
    expect(store.list()).toHaveLength(count);
    expect(db.prepare('SELECT * FROM user_context').all()).toEqual(before);
    expect(inbox.receive('action', event).outcome).toBe('duplicate');
  });
  it('does not invent a thread ID for an unstarted task', () => {
    const { task } = store.submit({
      owner,
      requestKey: 'new',
      projectKey: 'p',
      cwd: dir,
      prompt: 'new',
    });
    const copy = copyIdCard(task);
    expect(copy.sections).toHaveLength(1);
    expect(copy.notes.join()).toContain('尚未建立');
  });
  it('keeps every long-output character and supports navigation to the last page', async () => {
    const output = '# 结论\n第一行结论\n' + '内容😀\n'.repeat(850) + '最终结论';
    const pages = resultPages(output);
    expect(pages.join('')).toBe(output);
    const a = await task('长回答', 'thread-long', output);
    expect(JSON.stringify(messages.at(-1))).toContain('第一行结论');
    await click('result', { task_id: a.task_id, page: 0 });
    for (let p = 1; p < pages.length; p++) await click('result', { task_id: a.task_id, page: p });
    expect(JSON.stringify(messages.at(-1))).toContain('最终结论');
    expect(store.list()).toHaveLength(1);
    expect(() => resultCard(store, a, 999)).toThrow('页码');
  });
  it('preserves allowed heading/list/code formatting without turning raw model HTML into card markup', () => {
    const text =
      '# Heading\n- **bold**\n<at id=all></at>\n[x](https://example.test)\n```js\n' +
      'const x = `<value>`;\n'.repeat(200) +
      '```\nEnd';
    const pages = resultPages(text);
    expect(pages.join('')).toBe(text);
    const rendered = pages.map((_, i) => resultMarkdown(pages, i)).join('\n');
    expect(rendered).toContain('**Heading**');
    expect(rendered).toContain('- **bold**');
    expect(rendered).toContain('    const x = `<value>`;');
    expect(rendered).not.toContain('<at id=all></at>');
    expect(rendered).not.toContain('[x](https://example.test)');
  });
  it('keeps GUI threads read-only and displays names, time and copyable ID', async () => {
    store.setContext(inbox.owner, 'p', null);
    await receive('/会话 p');
    await flush();
    await click('sessions', { choice: 'desktop' });
    const card = messages.at(-1).card;
    expect(JSON.stringify(card)).toContain('桌面标题');
    expect(JSON.stringify(card)).toContain('desktop-id');
    expect(
      walk(card)
        .filter((n) => n.tag === 'button')
        .some((n) => n.text.content.includes('接着聊')),
    ).toBe(false);
    expect(store.list()).toHaveLength(0);
  });
  it('rejects expired and foreign copy controls', async () => {
    const a = await task('安全复制');
    queueNotice(store, inbox.owner, creds.testChatId, 'legacy-copy', '旧卡', '兼容旧按钮', [
      { label: '复制 ID', action: 'copy_id', taskId: a.task_id, expiresAt: Date.now() + 60000 },
    ]);
    await flush();
    const row = db
      .prepare("SELECT * FROM feishu_actions WHERE action='copy_id' AND task_id=?")
      .get(a.task_id);
    const event = action(row);
    event.operator.open_id = 'ou_other';
    expect(inbox.receive('action', event).outcome).toBe('denied');
    db.prepare('UPDATE feishu_actions SET expires_at=0 WHERE nonce=?').run(row.nonce);
    expect(inbox.receive('action', action(row)).outcome).toBe('expired-or-invalid');
  });
  it('paginates four threads per card with valid inline indexes and rejects stale page numbers', async () => {
    for (let i = 0; i < 5; i++) await task('话题 ' + i);
    const first = gatewaySessionCard(store, inbox.owner, 'p', '项目', null, 0);
    const second = gatewaySessionCard(store, inbox.owner, 'p', '项目', null, 1);
    expect(first.layout.sections).toHaveLength(4);
    expect(second.layout.sections).toHaveLength(1);
    expect(first.buttons.length).toBeLessThanOrEqual(12);
    expect(first.layout.sections.flatMap((s) => s.actions).every((i) => first.buttons[i])).toBe(
      true,
    );
    expect(() => gatewaySessionCard(store, inbox.owner, 'p', '项目', null, 2)).toThrow(
      '列表已变化',
    );
  });
  it('migrates v7 actions without changing old rows or relaxing task ownership references', () => {
    const old = openGatewayDatabase(join(dir, 'v7.sqlite'));
    for (const m of migrationSources().slice(0, 7)) {
      old.exec(m.sql);
      old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
      old.pragma('user_version = ' + m.version);
    }
    old
      .prepare(
        "INSERT INTO outbox (outbox_id,logical_key,card_version,payload,state,created_at) VALUES ('o','k',1,'{}','pending',1)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,action,expires_at,choice) VALUES ('n','o','owner','chat','panel',1,'refresh')",
      )
      .run();
    const before = old.prepare('SELECT * FROM feishu_actions').all();
    migrate(old);
    expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(old.prepare('SELECT * FROM feishu_actions').all()).toEqual(before);
    expect(() =>
      old
        .prepare(
          "INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,action,expires_at) VALUES ('bad','o','owner','chat','copy_id',1)",
        )
        .run(),
    ).toThrow();
    expect(old.pragma('foreign_key_check')).toEqual([]);
    old.close();
  });
});
