import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import { migrate, migrationSources } from '../../src/persistence/migrate.ts';
import { TaskStore, ownerKey } from '../../src/tasks/store.ts';

const root = dirname(dirname(import.meta.dirname));
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cc-rust-persistence-')));
const executable = join(root, '.artifacts/native-core-target/debug/compatibility');
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const owner = { tenantKey: '测试租户', appId: 'cli_fixture', openId: 'ou_fixture' };
const connectionPaths = [];
const hashCases = ['', '中文 空格', '\n\t"\\', '😀🚀\u2028\u2029', '/a/../b'].map(
  (suffix, index) => {
    const identity = { ...owner, openId: owner.openId + suffix };
    const request = 'fixture-' + suffix;
    const project = index % 2 ? null : '项目' + suffix;
    const cwd = directory + '/' + suffix;
    const prompt = '测试内容 ' + suffix;
    const thread = index % 2 ? null : 'thread-' + suffix;
    const conversation = 'conversation-' + suffix;
    const key = ownerKey(identity);
    return {
      owner: identity,
      request,
      project,
      cwd,
      prompt,
      thread,
      conversation,
      ownerKey: key,
      requestKey: hash([key, 'local', request]),
      legacyFingerprint: hash([project, cwd, prompt, thread]),
      conversationFingerprint: hash(['conversation-v2', conversation, project, cwd, prompt]),
    };
  },
);

function snapshot(database) {
  const tables = {};
  for (const [table, columns] of Object.entries({
    tasks: ['task_id', 'request_key', 'fingerprint', 'status', 'thread_id', 'turn_id', 'version'],
    threads: ['thread_id', 'owner_key', 'cwd'],
    inbox: ['inbox_id', 'event_key', 'payload', 'state', 'attempts'],
    rpc_operations: ['operation_id', 'rpc_id_json', 'intent', 'state', 'connection_epoch'],
    outbox: ['outbox_id', 'logical_key', 'payload', 'state', 'card_version', 'message_id'],
    execution_locks: ['lock_key', 'task_id'],
    task_destinations: ['task_id', 'owner_key', 'chat_id'],
  })) {
    const fields = columns.join(',');
    tables[table] = {
      columns,
      rows: database.prepare(`SELECT ${fields} FROM ${table} ORDER BY ${fields}`).all(),
    };
  }
  return { hashCases, tables };
}

function runProbe(path, expected) {
  const fixture = path + '.json';
  writeFileSync(fixture, JSON.stringify(expected), { mode: 0o600 });
  const result = JSON.parse(execFileSync(executable, [path, fixture], { encoding: 'utf8' }));
  assert.equal(result.compatible, true);
  assert.equal(result.schemaVersion, 12);
}

try {
  const currentPath = join(directory, 'v12 中文 空格.sqlite');
  const database = openGatewayDatabase(currentPath);
  connectionPaths.push(database);
  const store = new TaskStore(database);
  const task = store.submit({
    owner,
    requestKey: 'duplicate',
    projectKey: 'fixture',
    cwd: directory,
    prompt: 'fixture only',
    chatId: 'oc_fixture',
  }).task;
  const operation = store.claim(task.task_id, 'old-epoch');
  store.beforeWire(operation, 'old-epoch', 'string-rpc-id');
  store.settleOperation(operation, 'known', { threadId: 'thread-fixture' });
  const second = store.bindThread(task.task_id, 'thread-fixture', directory, 'old-epoch');
  store.beforeWire(second, 'old-epoch', 42);
  store.bindTurn(task.task_id, {
    id: 'turn-fixture',
    status: 'inProgress',
    items: [],
    error: null,
  });
  store.unknown(task.task_id, 'lost_response');
  const expected = snapshot(database);
  database.close();
  runProbe(currentPath, expected);
  const reopened = openGatewayDatabase(currentPath);
  connectionPaths.push(reopened);
  const recovered = new TaskStore(reopened);
  assert.equal(recovered.get(task.task_id).status, 'unknown');
  const duplicate = recovered.submit({
    owner,
    requestKey: 'duplicate',
    projectKey: 'fixture',
    cwd: directory,
    prompt: 'fixture only',
    conversationId: task.conversation_id,
    chatId: 'oc_fixture',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.task.task_id, task.task_id);
  reopened.close();

  const legacyPath = join(directory, 'v10.sqlite');
  const legacy = openGatewayDatabase(legacyPath);
  connectionPaths.push(legacy);
  for (const migration of migrationSources().slice(0, 10)) {
    legacy.exec(migration.sql);
    legacy
      .prepare('INSERT INTO schema_migrations VALUES (?,?)')
      .run(migration.version, migration.checksum);
    legacy.pragma(`user_version = ${migration.version}`);
  }
  const key = ownerKey(owner);
  legacy
    .prepare(
      "INSERT INTO tasks (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'unknown',1,2)",
    )
    .run(
      'legacy-task',
      hash([key, 'local', 'legacy']),
      hash(['fixture', directory, 'legacy only', null]),
      key,
      JSON.stringify(owner),
      'fixture',
      directory,
      'legacy only',
    );
  legacy
    .prepare('INSERT INTO execution_locks VALUES (?,?,1)')
    .run('checkout:' + directory, 'legacy-task');
  legacy
    .prepare('INSERT INTO task_destinations VALUES (?,?,?)')
    .run('legacy-task', key, 'oc_fixture');
  const legacyExpected = snapshot(legacy);
  legacy.close();
  runProbe(legacyPath, legacyExpected);
  const upgraded = openGatewayDatabase(legacyPath);
  connectionPaths.push(upgraded);
  migrate(upgraded);
  const upgradedStore = new TaskStore(upgraded);
  const retained = upgradedStore.get('legacy-task');
  assert.equal(retained.status, 'unknown');
  assert.equal(retained.fingerprint_version, 1);
  assert.equal(upgradedStore.conversations.get(retained.conversation_id).chat_id, 'oc_fixture');
  assert.equal(
    upgradedStore.submit({
      owner,
      requestKey: 'legacy',
      projectKey: 'fixture',
      cwd: directory,
      prompt: 'legacy only',
      conversationId: retained.conversation_id,
      chatId: 'oc_fixture',
    }).duplicate,
    true,
  );
  upgraded.close();

  const createdPath = join(directory, 'rust-created.sqlite');
  runProbe(createdPath, { hashCases, tables: {} });
  const created = openGatewayDatabase(createdPath);
  connectionPaths.push(created);
  const createdStore = new TaskStore(created);
  assert.equal(
    createdStore.submit({
      owner,
      requestKey: 'new',
      projectKey: 'fixture',
      cwd: directory,
      prompt: 'new only',
    }).duplicate,
    false,
  );
  created.close();
  console.log(
    'Rust 数据层兼容门禁通过：v10→v12、v12 双向读取、旧幂等重试、unknown/锁/回执和 Unicode 请求键；未触碰真实数据。',
  );
} finally {
  for (const connection of connectionPaths) if (connection.open) connection.close();
  rmSync(directory, { recursive: true, force: true });
}
