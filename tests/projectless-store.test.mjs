import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationSources, migrate } from '../src/persistence/migrate.ts';
import { ConversationDirectories } from '../src/conversations/directories.ts';
import { TaskStore, ownerKey } from '../src/tasks/store.ts';

const owner = { tenantKey: 't', appId: 'a', openId: 'u' };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let directory, db;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cc-np1-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function v10() {
  for (const m of migrationSources().filter((m) => m.version <= 10)) {
    db.exec(m.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
    db.pragma(`user_version=${m.version}`);
  }
}
function legacyTask(id, threadId, chat = 'chat', who = owner) {
  const identity = ownerKey(who);
  if (threadId)
    db.prepare("INSERT OR IGNORE INTO threads VALUES (?,?,?,?,?,'gateway',1)").run(
      threadId,
      identity,
      JSON.stringify(who),
      'p',
      directory,
    );
  db.prepare(
    "INSERT INTO tasks (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,thread_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'p',?,'fixture',?,'unknown',1,2)",
  ).run(
    id,
    hash([identity, 'local', id]),
    hash(['p', directory, 'fixture', threadId]),
    identity,
    JSON.stringify(who),
    directory,
    threadId,
  );
  if (chat) db.prepare('INSERT INTO task_destinations VALUES (?,?,?)').run(id, identity, chat);
}

describe('v11 projectless migration', () => {
  it('preserves requests, fingerprints, unknown states, receipts and ownership evidence', () => {
    v10();
    legacyTask('first', 'thread');
    legacyTask('pending', null);
    db.prepare("INSERT INTO execution_locks VALUES ('thread:thread','first',1)").run();
    db.prepare(
      "INSERT INTO rpc_operations (operation_id,task_id,method,connection_epoch,intent,state,created_at,updated_at) VALUES ('op','first','turn/start','e','{}','unknown',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO outbox (outbox_id,logical_key,task_id,card_version,payload,state,created_at,owner_key,chat_id,message_id) VALUES ('out','first:1','first',1,'{}','unknown',1,?,'chat','message')",
    ).run(ownerKey(owner));
    db.prepare('INSERT INTO user_context VALUES (?,?,?,1)').run(ownerKey(owner), 'p', 'first');
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY task_id').all();
    const operations = db.prepare('SELECT * FROM rpc_operations').all(),
      outbox = db.prepare('SELECT * FROM outbox').all();
    migrate(db);
    for (const prior of tasks)
      expect(db.prepare('SELECT * FROM tasks WHERE task_id=?').get(prior.task_id)).toMatchObject(
        prior,
      );
    expect(db.prepare('SELECT * FROM rpc_operations').all()).toEqual(operations);
    expect(db.prepare('SELECT * FROM outbox').all()).toEqual(
      outbox.map((row) => ({ ...row, view_id: null, view_parent_id: null })),
    );
    expect(db.prepare('SELECT * FROM user_context').get()).toMatchObject({
      chat_id: 'chat',
      scope_kind: 'project',
      project_key: 'p',
    });
    expect(db.prepare('SELECT chat_id FROM conversations').pluck().all()).toEqual(['chat', 'chat']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const store = new TaskStore(db);
    expect(
      store.submit({
        owner,
        requestKey: 'first',
        projectKey: 'p',
        cwd: directory,
        prompt: 'fixture',
        threadId: 'thread',
      }).duplicate,
    ).toBe(true);
  });
  it('deduplicates a migrated first request after its thread becomes bound without relaxing its identity', () => {
    v10();
    legacyTask('pending', null);
    migrate(db);
    const store = new TaskStore(db);
    db.prepare("UPDATE tasks SET status='queued' WHERE task_id='pending'").run();
    store.claim('pending', 'epoch');
    store.bindThread('pending', 'new-thread', directory, 'epoch');
    const input = {
      owner,
      chatId: 'chat',
      requestKey: 'pending',
      projectKey: 'p',
      cwd: directory,
      prompt: 'fixture',
      conversationId: store.get('pending').conversation_id,
      threadId: 'new-thread',
    };
    expect(store.submit(input).duplicate).toBe(true);
    expect(store.submit({ ...input, threadId: undefined }).duplicate).toBe(true);
    expect(() => store.submit({ ...input, prompt: 'changed' })).toThrow();
    expect(() => store.submit({ ...input, chatId: 'foreign' })).toThrow();
    expect(store.list()).toHaveLength(1);
  });
  it('never assigns ambiguous or unproven history to the current chat', () => {
    v10();
    legacyTask('a', 'shared', 'chat-a');
    legacyTask('b', 'shared', 'chat-b');
    legacyTask('local', null, null);
    db.prepare('INSERT INTO user_context VALUES (?,?,?,1)').run(ownerKey(owner), 'p', 'a');
    migrate(db);
    expect(db.prepare('SELECT chat_id FROM conversations').pluck().all()).toEqual([null, null]);
    expect(db.prepare('SELECT chat_id FROM user_context').pluck().get()).toBe('');
  });
  it('keeps saved project targets resolved while leaving old drafts untouched', () => {
    v10();
    legacyTask('parent', 'thread');
    db.prepare(
      "INSERT INTO inbox (inbox_id,event_key,source,method,payload,state,created_at,updated_at) VALUES ('in','event','feishu','message','{}','received',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO feishu_commands (command_id,business_key,inbox_id,owner_key,chat_id,payload,state,created_at,target_task_id,target_project_key) VALUES ('cmd','biz','in',?,'chat','{}','received',1,'parent','p')",
    ).run(ownerKey(owner));
    db.prepare(
      "INSERT INTO feishu_drafts (draft_id,owner_key,chat_id,prompt,state,created_at,expires_at) VALUES ('draft',?,'chat','old','pending',1,999)",
    ).run(ownerKey(owner));
    migrate(db);
    expect(db.prepare('SELECT * FROM feishu_commands').get()).toMatchObject({
      target_resolved: 1,
      target_scope_kind: 'project',
      target_project_key: 'p',
      state: 'received',
    });
    expect(
      db.prepare('SELECT target_conversation_id FROM feishu_commands').pluck().get(),
    ).toBeTypeOf('string');
    expect(db.prepare('SELECT state FROM feishu_drafts').pluck().get()).toBe('pending');
  });
  it('rolls the whole rebuild back and restores foreign keys on a late migration failure', () => {
    v10();
    legacyTask('a', 'thread');
    db.exec('ALTER TABLE feishu_commands ADD COLUMN target_resolved INTEGER');
    const before = db.prepare('SELECT * FROM tasks').all();
    expect(() => migrate(db)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(10);
    expect(db.prepare('SELECT * FROM tasks').all()).toEqual(before);
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='conversations'").get(),
    ).toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db.prepare("INSERT INTO execution_locks VALUES ('invalid','missing',1)").run(),
    ).toThrow();
  });
});

describe('conversation directories and scheduling', () => {
  const allocate = (store, manager) => {
    const id = randomUUID();
    const path = manager.create(id);
    return store.conversations.create({
      id,
      owner: ownerKey(owner),
      chat: 'chat',
      scope: { kind: 'projectless' },
      ...path,
    });
  };
  const submit = (store, conversation, requestKey, prompt = 'fixture') =>
    store.submit({
      owner,
      chatId: 'chat',
      conversationId: conversation.conversation_id,
      projectKey: null,
      cwd: conversation.cwd,
      requestKey,
      prompt,
    }).task;
  it('isolates profiles by canonical data directory and verifies directory identity', () => {
    const root = join(directory, 'conversations'),
      data = join(directory, 'data');
    mkdirSync(data);
    symlinkSync(data, join(directory, 'alias'));
    const manager = new ConversationDirectories(data, root),
      same = new ConversationDirectories(join(directory, 'alias'), root);
    expect(manager.profile).toBe(same.profile);
    const store = new TaskStore(db),
      conversation = allocate(store, manager);
    expect(manager.assert(conversation)).toBe(conversation.cwd);
    renameSync(conversation.cwd, conversation.cwd + '.old');
    mkdirSync(conversation.cwd, { mode: 0o700 });
    expect(() => manager.assert(conversation)).toThrow(/替换/);
  });
  it('does not recreate missing directories or allow symlinks and loose permissions', () => {
    const store = new TaskStore(db),
      manager = new ConversationDirectories(directory, join(directory, 'conversations')),
      conversation = allocate(store, manager);
    renameSync(conversation.cwd, conversation.cwd + '.old');
    expect(() => manager.assert(conversation)).toThrow(/丢失/);
    symlinkSync(conversation.cwd + '.old', conversation.cwd);
    expect(() => manager.assert(conversation)).toThrow();
    rmSync(conversation.cwd);
    renameSync(conversation.cwd + '.old', conversation.cwd);
    chmodSync(conversation.cwd, 0o755);
    expect(() => manager.assert(conversation)).toThrow();
  });
  it('rejects another profile and traversal IDs', () => {
    const store = new TaskStore(db),
      manager = new ConversationDirectories(directory, join(directory, 'conversations')),
      conversation = allocate(store, manager);
    mkdirSync(join(directory, 'other'));
    const other = new ConversationDirectories(
      join(directory, 'other'),
      join(directory, 'conversations'),
    );
    expect(() => other.assert(conversation)).toThrow();
    expect(() => manager.create('../unsafe')).toThrow(/ID/);
  });
  it('serializes the first two submissions before a thread exists and resumes the bound thread', () => {
    const store = new TaskStore(db),
      manager = new ConversationDirectories(directory, join(directory, 'conversations')),
      conversation = allocate(store, manager);
    const first = submit(store, conversation, 'a'),
      second = submit(store, conversation, 'b');
    expect(store.claim(first.task_id, 'e', { maxConcurrentTasks: 3 })).toBeTypeOf('string');
    expect(store.claim(second.task_id, 'e', { maxConcurrentTasks: 3 })).toBeNull();
    store.bindThread(first.task_id, 'thread', first.cwd, 'e');
    store.bindTurn(first.task_id, { id: 'turn', status: 'completed', items: [] });
    const operation = store.claim(second.task_id, 'e', { maxConcurrentTasks: 3 });
    expect(store.get(second.task_id).thread_id).toBe('thread');
    expect(
      db.prepare('SELECT method FROM rpc_operations WHERE operation_id=?').pluck().get(operation),
    ).toBe('thread/resume');
  });
  it('preserves unknown first-round locks and never creates a second thread', () => {
    const store = new TaskStore(db),
      manager = new ConversationDirectories(directory, join(directory, 'conversations')),
      conversation = allocate(store, manager);
    const first = submit(store, conversation, 'a'),
      second = submit(store, conversation, 'b');
    store.claim(first.task_id, 'e');
    store.unknown(first.task_id, 'lost-thread-reply');
    const restarted = new TaskStore(db);
    expect(restarted.claim(second.task_id, 'e2', { maxConcurrentTasks: 4 })).toBeNull();
    expect(restarted.conversations.get(conversation.conversation_id).thread_id).toBeNull();
  });
  it('shares one global concurrency limit with projects while independent conversations may run', () => {
    const store = new TaskStore(db),
      manager = new ConversationDirectories(directory, join(directory, 'conversations'));
    const a = submit(store, allocate(store, manager), 'a'),
      b = submit(store, allocate(store, manager), 'b');
    const project = store.submit({
      owner,
      projectKey: 'p',
      cwd: join(directory, 'project'),
      requestKey: 'p',
      prompt: 'project',
    }).task;
    expect(store.claim(a.task_id, 'e', { maxConcurrentTasks: 2 })).toBeTypeOf('string');
    expect(store.claim(project.task_id, 'e', { maxConcurrentTasks: 2 })).toBeTypeOf('string');
    expect(store.claim(b.task_id, 'e', { maxConcurrentTasks: 2 })).toBeNull();
    store.fail(project.task_id, 'thread_start', 'fixture');
    expect(store.claim(b.task_id, 'e', { maxConcurrentTasks: 2 })).toBeTypeOf('string');
  });
  it('pins v2 idempotency to a conversation and rejects cross-owner and cross-chat selection', () => {
    const store = new TaskStore(db),
      manager = new ConversationDirectories(directory, join(directory, 'conversations')),
      a = allocate(store, manager),
      b = allocate(store, manager);
    const task = submit(store, a, 'a');
    expect(submit(store, a, 'a').task_id).toBe(task.task_id);
    expect(() => submit(store, b, 'a')).toThrow(/request-key/);
    expect(() => store.conversations.owned(a.conversation_id, 'other', 'chat')).toThrow(/归属/);
    expect(() =>
      store.conversations.select(
        ownerKey(owner),
        'other',
        { kind: 'projectless' },
        a.conversation_id,
      ),
    ).toThrow(/归属/);
    store.conversations.select(
      ownerKey(owner),
      'chat',
      { kind: 'projectless' },
      a.conversation_id,
      task.task_id,
    );
    expect(store.conversations.context(ownerKey(owner), 'chat').conversation_id).toBe(
      a.conversation_id,
    );
    expect(store.conversations.context(ownerKey(owner), 'other')).toBeNull();
  });
});
