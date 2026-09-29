import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase, backupGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore, ownerKey } from '../src/tasks/store.ts';
import { OutboxStore } from '../src/tasks/outbox.ts';
import { migrate, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
import { ProjectStore, writableProject } from '../src/projects/store.ts';
import { inspectTaskDatabase } from '../src/cli/doctor.ts';

const owner = { tenantKey: 't', appId: 'a', openId: 'u' };
const turn = (status = 'inProgress', id = 'turn-1') => ({ id, status, items: [], error: null });
describe('M2 durable state invariants', () => {
  let directory, db, store, outbox;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cfg-m2-state-'));
    db = openGatewayDatabase(join(directory, 'state.sqlite'));
    store = new TaskStore(db);
    outbox = new OutboxStore(db);
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const submit = (overrides = {}) =>
    store.submit({
      owner,
      requestKey: 'req-1',
      projectKey: 'p',
      cwd: directory,
      prompt: 'Test',
      ...overrides,
    }).task;
  function running() {
    const task = submit();
    const first = store.claim(task.task_id, 'epoch');
    store.beforeWire(first, 'epoch', 1);
    store.settleOperation(first, 'known', { threadId: 'thread-1' });
    const second = store.bindThread(task.task_id, 'thread-1', directory, 'epoch');
    store.beforeWire(second, 'epoch', 2);
    store.bindTurn(task.task_id, turn());
    return store.get(task.task_id);
  }
  function event(status = 'completed') {
    return {
      connectionEpoch: 'epoch',
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn(status) },
    };
  }

  it('migrates once, detects checksum drift and rejects newer schemas', () => {
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    db.prepare('UPDATE schema_migrations SET checksum = ?').run('tampered');
    expect(() => migrate(db)).toThrow(/checksum/);
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(/Unsupported/);
  });
  it('diagnoses existing task data without creating or migrating a database', async () => {
    const missing = join(directory, 'missing');
    expect(inspectTaskDatabase(missing).status).toBe('not-initialized');
    expect(existsSync(missing)).toBe(false);
    const backup = join(directory, 'gateway.sqlite');
    await backupGatewayDatabase(db, backup);
    expect(inspectTaskDatabase(directory).status).toBe('ok');
    const changed = openGatewayDatabase(backup);
    changed.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    changed.close();
    expect(inspectTaskDatabase(directory).status).toBe('incompatible-schema');
    const readonly = openGatewayDatabase(backup);
    expect(readonly.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION + 1);
    readonly.close();
    chmodSync(backup, 0o644);
    expect(inspectTaskDatabase(directory).status).toBe('unsafe-permissions');
  });
  it('enqueues inbox, command, task, and outbox atomically; replay does not create another task', () => {
    const task = submit();
    expect(submit().task_id).toBe(task.task_id);
    expect(() => submit({ prompt: 'changed' })).toThrow(/request-key/);
    for (const table of ['inbox', 'commands', 'tasks', 'outbox'])
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(1);
    db.exec(
      "CREATE TRIGGER reject_queue BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    expect(() => submit({ requestKey: 'req-fail' })).toThrow();
    expect(store.list()).toHaveLength(1);
    expect(db.prepare('SELECT count(*) FROM inbox').pluck().get()).toBe(1);
  });
  it('scopes request keys and contexts to their owner and refuses arbitrary threads', () => {
    const task = running();
    expect(() => submit({ requestKey: 'continue', threadId: 'external' })).toThrow(/Gateway/);
    expect(() =>
      submit({
        requestKey: 'continue',
        threadId: 'thread-1',
        owner: { ...owner, openId: 'other' },
      }),
    ).toThrow(/Gateway/);
    expect(() => store.setContext('foreign', 'p', task.task_id)).toThrow(/归属/);
    store.setContext(ownerKey(owner), 'p', task.task_id);
    expect(db.prepare('SELECT task_id FROM user_context').pluck().get()).toBe(task.task_id);
  });
  it('allows only one active/unknown task and keeps both locks on ambiguous submission', () => {
    const first = running();
    const second = submit({ requestKey: 'req-2', cwd: directory + '/other' });
    store.unknown(first.task_id, 'lost_response');
    expect(store.claim(second.task_id, 'epoch-2')).toBeNull();
    expect(
      db.prepare('SELECT lock_key FROM execution_locks ORDER BY lock_key').pluck().all(),
    ).toEqual([
      `checkout:${directory}`,
      `conversation:${first.conversation_id}`,
      'thread:thread-1',
    ]);
    store.recordEvent(event());
    expect(store.get(first.task_id).status).toBe('completed');
    expect(store.claim(second.task_id, 'epoch-2')).toBeTypeOf('string');
  });
  it('buffers early output and terminal events, then binds without status regression', () => {
    const task = submit();
    store.claim(task.task_id, 'e');
    store.bindThread(task.task_id, 'thread-1', directory, 'e');
    store.recordEvent({
      connectionEpoch: 'e',
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'item-1', text: 'done' },
      },
    });
    store.recordEvent(event());
    expect(store.get(task.task_id).turn_id).toBeNull();
    expect(
      db
        .prepare("SELECT count(*) FROM inbox WHERE source = 'rpc' AND state = 'received'")
        .pluck()
        .get(),
    ).toBe(2);
    store.bindTurn(task.task_id, turn());
    expect(store.get(task.task_id).status).toBe('completed');
    expect(store.result(task.task_id)).toBe('done');
    store.bindTurn(task.task_id, turn());
    store.recordEvent(event());
    expect(store.get(task.task_id).status).toBe('completed');
    expect(db.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBe(0);
  });
  it('retries failed inbox processing even when its event key already exists', () => {
    const task = running();
    db.exec(
      "CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON tasks WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    expect(() => store.recordEvent(event())).toThrow(/处理失败/);
    expect(db.prepare("SELECT state FROM inbox WHERE source = 'rpc'").pluck().get()).toBe('failed');
    db.exec('DROP TRIGGER reject_terminal');
    store.recordEvent(event());
    expect(store.get(task.task_id).status).toBe('completed');
    expect(db.prepare("SELECT attempts FROM inbox WHERE source = 'rpc'").pluck().get()).toBe(2);
  });
  it('restores committed tasks, idempotency, and unknown locks from a live WAL backup', async () => {
    const task = running();
    store.unknown(task.task_id, 'unknown');
    const backup = join(directory, 'backup.sqlite');
    await backupGatewayDatabase(db, backup);
    const restoredDb = openGatewayDatabase(backup);
    try {
      const restored = new TaskStore(restoredDb);
      expect(restored.get(task.task_id).status).toBe('unknown');
      expect(
        restored.submit({
          owner,
          requestKey: 'req-1',
          projectKey: 'p',
          cwd: directory,
          prompt: 'Test',
        }).duplicate,
      ).toBe(true);
      expect(restoredDb.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBe(3);
      expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      restoredDb.close();
    }
  });
  it('preserves numeric approval id 0 separately from string 0', () => {
    running();
    for (const id of [0, '0'])
      store.recordUnsupportedApproval({
        id,
        connectionEpoch: 'e',
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      });
    expect(db.prepare('SELECT rpc_id_json FROM approvals ORDER BY rowid').pluck().all()).toEqual([
      '0',
      '"0"',
    ]);
    expect(
      db.prepare("SELECT count(*) FROM approvals WHERE state = 'unsupported'").pluck().get(),
    ).toBe(2);
  });
  it('does not steal a live worker lease or release another worker token', () => {
    const token = store.acquireWorker();
    const otherDb = openGatewayDatabase(join(directory, 'state.sqlite'));
    try {
      const other = new TaskStore(otherDb);
      expect(() => other.acquireWorker()).toThrow(/worker/);
      other.releaseWorker('wrong');
      expect(() => other.acquireWorker()).toThrow(/worker/);
      store.releaseWorker(token);
      const next = other.acquireWorker();
      other.releaseWorker(next);
    } finally {
      otherDb.close();
    }
  });
  it('coalesces unsent snapshots and serializes updates after a confirmed create', () => {
    const task = submit();
    const first = outbox.claim();
    expect(first.operation).toBe('send');
    outbox.markSending(first.claim_token);
    store.claim(task.task_id, 'e');
    store.bindThread(task.task_id, 'thread-1', directory, 'e');
    store.bindTurn(task.task_id, turn('completed'));
    expect(outbox.claim()).toBeNull();
    outbox.complete(first.claim_token, 'om_test');
    const latest = outbox.claim();
    expect(latest.operation).toBe('update');
    expect(latest.message_id).toBe('om_test');
    expect(JSON.parse(latest.payload).status).toBe('completed');
    expect(latest.card_version).toBe(store.get(task.task_id).version);
    outbox.markSending(latest.claim_token);
    outbox.complete(latest.claim_token, 'om_test');
    expect(outbox.claim()).toBeNull();
  });
  it('does not resend an ambiguous create and blocks later versions until receipt is verified', () => {
    const task = submit();
    const first = outbox.claim();
    outbox.markSending(first.claim_token);
    outbox.fail(first.claim_token, 'unknown');
    store.claim(task.task_id, 'e');
    expect(outbox.claim()).toBeNull();
    outbox.recordVerifiedReceipt(first.outbox_id, 'om_confirmed');
    expect(outbox.claim().operation).toBe('update');
  });
  it('reclaims only unsent expired claims; expired sends become unknown and stale tokens fail', () => {
    submit();
    const first = outbox.claim(100, 10);
    outbox.recoverExpired(111);
    expect(() => outbox.markSending(first.claim_token, 111)).toThrow(/失效/);
    const second = outbox.claim(111, 10);
    outbox.markSending(second.claim_token, 112);
    outbox.recoverExpired(122);
    expect(outbox.claim(10000)).toBeNull();
    expect(() => outbox.complete(second.claim_token, 'om_stale')).toThrow();
  });
  it('schedules backoff for a known unsent failure without marking the task failed', () => {
    const task = submit();
    const first = outbox.claim(100, 10);
    outbox.fail(first.claim_token, 'not-sent', 100);
    expect(outbox.claim(101)).toBeNull();
    expect(outbox.claim(10000)).not.toBeNull();
    expect(store.get(task.task_id).status).toBe('queued');
  });
});

describe('M2 project discovery and write authorization', () => {
  let directory;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cfg-m2-project-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  it('matches the deepest canonical project before applying pagination and keeps separate worktrees', async () => {
    for (const path of ['root', 'root/nested', 'worktree'])
      mkdirSync(join(directory, path), { recursive: true });
    const projects = ['root', 'root/nested', 'worktree'].map((path, index) => ({
      key: String(index),
      name: path,
      root: join(directory, path),
      remoteWrite: index === 0,
    }));
    const thread = (id, cwd) => ({
      id,
      cwd,
      historyMode: 'legacy',
      status: { type: 'idle' },
      turns: [],
    });
    const rpc = {
      request: async (method, params, schema) =>
        schema.parse(
          method === 'project/list'
            ? { data: [], nextCursor: null }
            : params.cursor
              ? {
                  data: [thread('match', projects[0].root), thread('wt', projects[2].root)],
                  nextCursor: null,
                }
              : { data: [thread('nested', projects[1].root)], nextCursor: 'next' },
        ),
    };
    const store = new ProjectStore(projects, rpc);
    expect((await store.sessions('0', 0, 1)).data.map((t) => t.id)).toEqual(['match']);
    expect((await store.sessions('1')).data.map((t) => t.id)).toEqual(['nested']);
    expect((await store.sessions('2')).data.map((t) => t.id)).toEqual(['wt']);
    expect(() => writableProject(projects, '2')).toThrow(/remoteWrite/);
  });
  it('shows missing paths as unavailable, does not grant discovered projects write access, and rejects aliases', async () => {
    const project = { key: 'p', name: 'p', root: directory, remoteWrite: true };
    const rpc = {
      request: async (_method, _params, schema) =>
        schema.parse({
          data: [{ id: 'remote', name: 'remote', roots: [{ path: join(directory, 'missing') }] }],
          nextCursor: null,
        }),
    };
    const store = new ProjectStore([project], rpc);
    expect((await store.catalog())[1]).toMatchObject({ available: false, remoteWrite: false });
    const alias = join(directory, 'alias');
    symlinkSync(directory, alias);
    chmodSync(directory, 0o700);
    expect(() =>
      writableProject([project, { ...project, key: 'alias', root: alias }], 'p'),
    ).toThrow(/歧义/);
    expect(() => writableProject([project], 'p', '/changed')).toThrow(/已改变/);
    await expect(
      new ProjectStore([project, { ...project, key: 'alias', root: alias }], rpc).sessions('p'),
    ).rejects.toThrow(/歧义/);
    expect(await store.sessions('codex:remote:0')).toMatchObject({ available: false, total: null });
  });
  it('fails closed on incompatible project schemas and cursor loops', async () => {
    const project = { key: 'p', name: 'p', root: directory, remoteWrite: true };
    const invalid = new ProjectStore([project], {
      request: async (_m, _p, schema) => schema.parse({ projects: [] }),
    });
    await expect(invalid.catalog()).rejects.toThrow();
    const looping = new ProjectStore([project], {
      request: async (_m, _p, schema) => schema.parse({ data: [], nextCursor: 'same' }),
    });
    await expect(looping.catalog()).rejects.toThrow(/游标/);
  });
});
