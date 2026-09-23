import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  backupGatewayDatabase,
  openGatewayDatabase,
  openReadonlyDatabase,
} from '../../src/persistence/database.ts';
import { TaskStore, ownerKey } from '../../src/tasks/store.ts';
import { FeishuApi } from '../../src/feishu/api.ts';
import { readCredentials } from '../../src/feishu/credentials.ts';
import { FeishuSender, receiptMarker, terminalNoticeKey } from '../../src/feishu/sender.ts';

const { values } = parseArgs({
  options: { live: { type: 'boolean' }, source: { type: 'string' }, help: { type: 'boolean' } },
});
if (!values.live || !values.source || values.help) {
  console.log(
    'node --import tsx scripts/gates/recover-terminal-notice.mjs --live --source .artifacts/m4/PHONE_CONTROLS_RUN\n仅对已退出且任务已结束的手机控制探针，在数据库副本上核对/补充终态通知；不启动 App Server、不重放 PATCH。每个源目录仅允许建立一个恢复副本，重复启动会拒绝，避免从旧快照再次发送。',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const source = await realpath(resolve(values.source));
const root = await realpath(resolve('.artifacts/m4'));
assert.equal(resolve(source, '..'), root);
const prior = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'));
assert.equal(basename(source), prior.runId);
assert.equal(prior.suite, 'phone-controls');
assert.equal(prior.status, 'BLOCKED');
assert(prior.cleanup.some((entry) => entry.ownedProcessExited));
assert(prior.cleanup.some((entry) => entry.temporaryDirectoryRemoved));
const artifacts = join(root, `${prior.runId}-terminal-notice`);
// Exclusive directory creation is the probe's durable guard against replaying a stale copy.
await mkdir(artifacts, { mode: 0o700 });
const report = {
  sourceRun: prior.runId,
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  checks: {},
  limitations: ['Independent terminal notice only; the old PATCH remains unresolved.'],
};
let db;
const sourceDb = join(source, 'gateway.sqlite');
const digest = async () =>
  createHash('sha256')
    .update(await readFile(sourceDb))
    .digest('hex');
const sourceHash = await digest();
try {
  const credentials = readCredentials(resolve('config/feishu.local.json'));
  const owner = ownerKey({
    appId: credentials.appId,
    tenantKey: credentials.tenantKey,
    openId: credentials.allowedOpenId,
  });
  const original = openReadonlyDatabase(sourceDb);
  let task, blocked;
  try {
    const tasks = original.prepare('SELECT * FROM tasks').all();
    assert.equal(tasks.length, 1);
    task = tasks[0];
    assert(['completed', 'failed', 'interrupted'].includes(task.status));
    assert.equal(task.owner_key, owner);
    for (const table of ['worker_lease', 'feishu_runtime_lease', 'execution_locks'])
      assert.equal(original.prepare(`SELECT count(*) FROM ${table}`).pluck().get(), 0);
    const unknown = original.prepare("SELECT * FROM outbox WHERE state='unknown'").all();
    assert.equal(unknown.length, 1);
    blocked = unknown[0];
    assert.equal(blocked.task_id, task.task_id);
    assert.equal(blocked.operation, 'update');
    assert.equal(blocked.owner_key, owner);
    assert.equal(blocked.chat_id, credentials.testChatId);
    assert.equal(blocked.message_id, task.notification_message_id);
    assert(blocked.sent_at <= Date.now() - 60_000);
    await backupGatewayDatabase(original, join(artifacts, 'gateway.sqlite'));
  } finally {
    original.close();
  }
  db = openGatewayDatabase(join(artifacts, 'gateway.sqlite'));
  const store = new TaskStore(db);
  const api = new FeishuApi(credentials);
  const assertRemote = (remote, messageId) => {
    assert.equal(remote.message_id, messageId);
    assert.equal(remote.chat_id, credentials.testChatId);
    assert.equal(remote.msg_type, 'interactive');
    assert.equal(remote.sender.id, credentials.appId);
    assert.equal(remote.sender.sender_type, 'app');
    assert.equal(remote.sender.id_type, 'app_id');
    assert(!remote.sender.tenant_key || remote.sender.tenant_key === credentials.tenantKey);
    assert(!remote.deleted);
  };
  const originalRemote = await api.get(blocked.message_id);
  assertRemote(originalRemote, blocked.message_id);
  assert(!originalRemote.body.content.includes(receiptMarker(blocked.outbox_id)));
  const sender = new FeishuSender(store, credentials, {
    prepare: () => api.prepare(),
    create: (...args) => api.create(...args),
    get: (id) => api.get(id),
    history: (...args) => api.history(...args),
    update: () => {
      throw new Error('This recovery probe never PATCHes the original card');
    },
  });
  const operations = db.prepare('SELECT count(*) FROM rpc_operations').pluck().get();
  const deadline = Date.now() + 60_000;
  let notice;
  do {
    await sender.reconcileOne();
    // Only the independent notice is allowed to send in this probe. If the old
    // receipt becomes known concurrently, stop for a normal recovery instead.
    assert.equal(
      db.prepare('SELECT state FROM outbox WHERE outbox_id=?').pluck().get(blocked.outbox_id),
      'unknown',
    );
    await sender.flushOne();
    notice = db
      .prepare('SELECT * FROM outbox WHERE logical_key=?')
      .get(terminalNoticeKey(task.task_id));
    if (notice?.state === 'delivered') break;
    await delay(500);
  } while (Date.now() < deadline);
  assert.equal(notice?.state, 'delivered');
  assert.notEqual(notice.message_id, blocked.message_id);
  const remote = await api.get(notice.message_id);
  assertRemote(remote, notice.message_id);
  assert(remote.body.content.includes(receiptMarker(notice.outbox_id)));
  assert.equal(store.get(task.task_id).notification_message_id, blocked.message_id);
  assert.equal(db.prepare('SELECT count(*) FROM rpc_operations').pluck().get(), operations);
  report.checks.independentTerminalReceipt = 'PASS';
  report.checks.originalUnknownAndBindingPreserved = 'PASS';
  report.checks.noRpcOrPatchReplay = 'PASS';
  report.evidence = {
    taskId: task.task_id,
    taskStatus: task.status,
    sourceOutboxId: blocked.outbox_id,
    noticeOutboxId: notice.outbox_id,
    noticeMessageId: notice.message_id,
    attempts: notice.attempts,
  };
  report.finalState = store.diagnostics();
  report.status = 'PASS';
} catch (error) {
  report.status = 'BLOCKED';
  report.error = error instanceof Error ? error.name : 'Error';
  process.exitCode = 1;
} finally {
  db?.close();
  report.checks.sourceDatabaseUnchanged = (await digest()) === sourceHash ? 'PASS' : 'FAIL';
  if (report.checks.sourceDatabaseUnchanged !== 'PASS') {
    report.status = 'FAIL';
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify({ status: report.status, report: join(artifacts, 'report.json') }));
}
