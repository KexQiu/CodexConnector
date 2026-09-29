import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, rmdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

// Explicitly opt in: this probe uses Codex's real account, but no Feishu connection.
if (!process.argv.includes('--live')) throw new Error('需要 --live 才会调用真实 Codex 账号');
const backendIndex = process.argv.indexOf('--backend');
const backend = backendIndex === -1 ? resolve('src') : resolve(process.argv[backendIndex + 1]);
const extension = backendIndex === -1 ? 'ts' : 'js';
const load = (file) => import(pathToFileURL(join(backend, `${file}.${extension}`)).href);
const { OrdinaryChatServer } = await load('conversations/server');
const { ConversationDirectories } = await load('conversations/directories');
const { TaskWorker } = await load('tasks/worker');
const { TaskStore } = await load('tasks/store');
const { openGatewayDatabase } = await load('persistence/database');
const { FeishuInbox } = await load('feishu/inbound');
const { FeishuCommands } = await load('feishu/commands');
process.umask(0o077);
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const artifacts = resolve('.artifacts/projectless-runtime', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const directory = await realpath(await mkdtemp(join(tmpdir(), 'cc-np-runtime-')));
const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const credentials = {
  appId: 'cli_np_fixture',
  appSecret: 'not-used',
  tenantKey: 'fixture',
  allowedOpenId: 'ou_fixture',
  testChatId: 'oc_fixture',
};
const config = {
  dataDir: directory,
  codex: { binary, endpoint: '' },
  feishu: credentials,
  projectless: { enabled: true },
  maxConcurrentTasks: 2,
  projects: [],
};
const report = {
  runId,
  status: 'INCOMPLETE',
  realModel: true,
  realFeishu: false,
  checks: [],
  taskCount: 0,
  threadCount: 0,
  cleanup: false,
};
let server, db, store, worker, inbox, commands;
const directories = new ConversationDirectories(directory);
const check = (name, evidence) => {
  report.checks.push({ name, status: 'PASS', evidence });
  console.log(JSON.stringify(report.checks.at(-1)));
};
async function start() {
  server = new OrdinaryChatServer(binary, true);
  await server.ensure();
  assert.equal(server.ready, true, server.error);
  config.codex.endpoint = server.endpoint;
  db = openGatewayDatabase(join(directory, 'gateway.sqlite'));
  store = new TaskStore(db);
  worker = new TaskWorker(store, config, server, credentials.testChatId);
  await worker.start();
  inbox = new FeishuInbox(store, credentials);
  commands = new FeishuCommands(
    inbox,
    config,
    { catalog: async () => [], sessions: async () => ({ data: [], total: 0, available: true }) },
    worker,
  );
}
async function message(text) {
  inbox.receive('message', {
    event_id: randomUUID(),
    app_id: credentials.appId,
    tenant_key: credentials.tenantKey,
    sender: { sender_type: 'user', sender_id: { open_id: credentials.allowedOpenId } },
    message: {
      message_id: randomUUID(),
      chat_id: credentials.testChatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
  await commands.processNext();
}
async function turn(prompt, expected) {
  await message(prompt);
  const started = await worker.dispatchNext();
  assert.ok(started, '没有派发任务');
  const task = await worker.waitForTask(started.task_id, 120000);
  assert.equal(task.status, 'completed', `${task.status}:${task.error_code}`);
  assert.equal(store.result(task.task_id).trim(), expected);
  const snapshot = await worker
    .rpcFor(task)
    .request(
      'thread/read',
      { threadId: task.thread_id, includeTurns: false },
      z.object({ thread: z.object({ environments: z.array(z.unknown()) }) }),
    );
  assert.deepEqual(snapshot.thread.environments, []);
  return task;
}
async function stop() {
  worker?.close();
  worker = undefined;
  if (db?.open) db.close();
  db = undefined;
  await server?.stop();
  server = undefined;
}
try {
  await start();
  const code = `NP_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const first = await turn(
    `普通聊天验收：请记住代号 ${code}。不使用工具，仅回复 NP_REMEMBERED。`,
    'NP_REMEMBERED',
  );
  check('first-message-with-zero-projects', { conversationId: first.conversation_id });
  const second = await turn('只回复刚才的代号。', code);
  assert.equal(second.conversation_id, first.conversation_id);
  check('continuous-chat', { sameThread: second.thread_id === first.thread_id });
  await message('/新话题');
  const other = await turn('不使用工具，仅回复 NP_SECOND_CHAT。', 'NP_SECOND_CHAT');
  assert.notEqual(other.conversation_id, first.conversation_id);
  check('second-conversation', { isolated: true });
  const switched = await turn(`/继续 ${first.task_id} 只回复之前记住的代号。`, code);
  assert.equal(switched.thread_id, first.thread_id);
  check('switch-back', { historyPreserved: true });
  await stop();
  await start();
  const resumed = await turn('只回复之前记住的代号。', code);
  assert.equal(resumed.thread_id, first.thread_id);
  check('server-and-database-restart', {
    sameConversation: resumed.conversation_id === first.conversation_id,
  });
  report.taskCount = store.list().length;
  report.threadCount = new Set(store.list().map((t) => t.thread_id)).size;
  assert.equal(report.taskCount, 5);
  assert.equal(report.threadCount, 2);
  assert.equal(
    db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
    5,
  );
  assert.equal(db.prepare('SELECT count(*) FROM task_destinations').pluck().get(), 5);
  check('no-replay-and-durable-destinations', { tasks: 5, turnStarts: 5, threads: 2 });
  for (const id of new Set(store.list().map((t) => t.thread_id))) {
    const task = store.list().find((t) => t.thread_id === id);
    await worker.rpcFor(task).request('thread/archive', { threadId: id }, z.object({}));
  }
  for (const conversation of store.conversations.list(worker.owner, credentials.testChatId, {
    kind: 'projectless',
  })) {
    directories.assert(conversation);
    await rmdir(conversation.cwd);
  }
  await rmdir(directories.profile);
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error instanceof Error ? error.message : 'integration failed';
  process.exitCode = 1;
} finally {
  if (worker) await worker.interruptOwnedTasks().catch(() => {});
  await stop();
  if (report.status === 'PASS') {
    await rm(directory, { recursive: true, force: true });
    report.cleanup = true;
  }
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(artifacts, 'report.json'),
      error: report.error,
    }),
  );
}
