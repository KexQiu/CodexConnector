import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskWorker, configuredOwner } from '../src/tasks/worker.ts';
import { ConversationDirectories } from '../src/conversations/directories.ts';
import { disabledFeatures } from '../src/conversations/policy.ts';
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
let db, store, config, worker, project, ordinary, lost, unsafe;
const wait = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error('fixture timed out');
};
async function server(name) {
  const http = createServer(),
    wss = new WebSocketServer({ server: http });
  const calls = [],
    threads = new Map();
  wss.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      calls.push(message);
      const { method, id, params } = message;
      const reply = (result) => socket.send(JSON.stringify({ id, result }));
      if (method === 'initialize')
        return reply({
          userAgent: 'fixture',
          codexHome: fixture.root,
          platformFamily: 'unix',
          platformOs: 'macos',
        });
      if (!method || method === 'initialized') return;
      if (method === 'config/read')
        return reply({
          config: {
            features: Object.fromEntries(disabledFeatures.map((f) => [f, false])),
            agents: { enabled: false },
            web_search: 'disabled',
            project_doc_max_bytes: 0,
            notify: [],
            mcp_servers: unsafe && name === 'ordinary' ? { external: { enabled: true } } : {},
          },
        });
      if (method === 'skills/list') return reply({ data: [{ skills: [] }] });
      if (method === 'thread/start') {
        const thread = {
          id: `${name}-${threads.size}`,
          cwd: params.cwd,
          historyMode: 'legacy',
          environments: [],
          status: { type: 'idle' },
          turns: [],
        };
        threads.set(thread.id, thread);
        if (lost && name === 'ordinary') return socket.terminate();
        return reply({
          thread,
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
      }
      if (method === 'thread/resume' || method === 'thread/read') {
        const thread = threads.get(params.threadId);
        return reply({
          thread: { ...thread, turns: params.includeTurns ? thread.turns : [] },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
      }
      if (method === 'turn/start') {
        const turn = { id: randomUUID(), status: 'inProgress', items: [], error: null };
        threads.get(params.threadId).turns.push(turn);
        return reply({ turn });
      }
      if (method === 'turn/steer') return reply({ turnId: params.expectedTurnId });
      if (method === 'turn/interrupt') {
        reply({});
        const thread = threads.get(params.threadId),
          turn = thread.turns.find((t) => t.id === params.turnId);
        turn.status = 'interrupted';
        socket.send(
          JSON.stringify({ method: 'turn/completed', params: { threadId: thread.id, turn } }),
        );
        return;
      }
    }),
  );
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return {
    calls,
    threads,
    wss,
    endpoint: `ws://127.0.0.1:${http.address().port}`,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => http.close(r));
    },
  };
}
beforeEach(async () => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-np-worker-')));
  mkdirSync(join(fixture.root, 'project'));
  db = openGatewayDatabase(join(fixture.root, 'gateway.sqlite'));
  store = new TaskStore(db);
  lost = false;
  unsafe = false;
  project = await server('project');
  ordinary = await server('ordinary');
  config = {
    dataDir: fixture.root,
    codex: { endpoint: project.endpoint },
    feishu: { appId: 'a', tenantKey: 't', allowedOpenId: 'u' },
    projectless: { enabled: true },
    maxConcurrentTasks: 2,
    projects: [
      {
        key: 'p',
        name: 'p',
        root: join(fixture.root, 'project'),
        remotePermissions: { mode: 'read-only', networkAccess: false },
      },
    ],
  };
  worker = new TaskWorker(
    store,
    config,
    { endpoint: ordinary.endpoint, ready: true, error: null },
    'oc_chat',
  );
  await worker.start();
});
afterEach(async () => {
  worker.close();
  await ordinary.close();
  await project.close();
  db.close();
  rmSync(fixture.root, { recursive: true, force: true });
});
function submit(isOrdinary, conversation) {
  if (isOrdinary && !conversation) {
    const id = randomUUID(),
      directory = new ConversationDirectories(config.dataDir).create(id);
    conversation = store.conversations.create({
      id,
      owner: worker.owner,
      chat: 'oc_chat',
      scope: { kind: 'projectless' },
      ...directory,
    });
  }
  const task = store.submit({
    owner: configuredOwner(config),
    requestKey: randomUUID(),
    chatId: 'oc_chat',
    projectKey: isOrdinary ? null : 'p',
    cwd: conversation?.cwd ?? config.projects[0].root,
    prompt: 'fixture',
    ...(conversation ? { conversationId: conversation.conversation_id } : {}),
  }).task;
  db.prepare('UPDATE tasks SET created_at=? WHERE task_id=?').run(
    store.list().length,
    task.task_id,
  );
  return store.get(task.task_id);
}
function complete(task) {
  task = store.get(task.task_id);
  const t = (task.project_key === null ? ordinary : project).threads
    .get(task.thread_id)
    .turns.find((t) => t.id === task.turn_id);
  t.status = 'completed';
  store.reconcileTurn(task.task_id, t);
}
it('routes mixed work to separate servers with shared capacity and resumes the same conversation for its second queued message', async () => {
  const first = submit(true),
    second = submit(true, store.conversations.get(first.conversation_id)),
    projectTask = submit(false);
  expect((await worker.dispatchNext()).task_id).toBe(first.task_id);
  expect((await worker.dispatchNext()).task_id).toBe(projectTask.task_id);
  expect(await worker.dispatchNext()).toBeNull();
  complete(first);
  expect((await worker.dispatchNext()).task_id).toBe(second.task_id);
  expect(store.get(second.task_id).thread_id).toBe(store.get(first.task_id).thread_id);
  expect(ordinary.calls.filter((m) => m.method === 'thread/start')).toHaveLength(1);
  expect(ordinary.calls.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
  expect(project.calls.filter((m) => m.method === 'thread/start')).toHaveLength(1);
  for (const call of ordinary.calls.filter((m) => m.method === 'turn/start'))
    expect(call.params).toMatchObject({
      environments: [],
      model: 'gpt-6-astra',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
});
it('preserves unknown after a lost first thread receipt without affecting the project connection or starting another thread', async () => {
  const p = submit(false);
  await worker.dispatchNext();
  const a = submit(true);
  submit(true, store.conversations.get(a.conversation_id));
  lost = true;
  expect((await worker.dispatchNext()).status).toBe('unknown');
  expect(worker.rpc.isReady).toBe(true);
  expect(store.get(p.task_id).status).toBe('running');
  expect(store.get(a.task_id).thread_id).toBeNull();
  expect(await worker.dispatchNext()).toBeNull();
  expect(ordinary.calls.filter((m) => m.method === 'thread/start')).toHaveLength(1);
});
it('refuses unsafe effective configuration before any projectless thread mutation while project execution remains available', async () => {
  unsafe = true;
  submit(true);
  expect((await worker.dispatchNext()).status).toBe('failed');
  expect(ordinary.calls.filter((m) => m.method === 'thread/start')).toHaveLength(0);
  submit(false);
  expect((await worker.dispatchNext()).status).toBe('running');
});
it('rejects projectless tool approval and interrupts only gateway-owned tasks after the local switch is disabled', async () => {
  const a = submit(true);
  await worker.dispatchNext();
  const running = store.get(a.task_id);
  const socket = [...ordinary.wss.clients][0];
  socket.send(
    JSON.stringify({
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: running.thread_id,
        turnId: running.turn_id,
        itemId: 'tool',
        command: 'pwd',
        cwd: running.cwd,
      },
    }),
  );
  await wait(() => ordinary.calls.some((m) => m.id === 900 && m.error));
  ordinary.threads.set('desktop-unowned', {
    turns: [{ id: 'desktop-turn', status: 'inProgress' }],
  });
  config.projectless.enabled = false;
  worker.controls.enqueue('steer', a.task_id, 'steer', 'forbidden');
  await worker.tickInteractions();
  expect(ordinary.calls.filter((m) => m.method === 'turn/steer')).toHaveLength(0);
  await worker.interruptOwnedTasks(1000);
  expect(store.get(a.task_id).status).toBe('interrupted');
  expect(
    ordinary.calls.filter((m) => m.method === 'turn/interrupt').map((m) => m.params.threadId),
  ).toEqual([running.thread_id]);
  expect(ordinary.threads.get('desktop-unowned').turns[0].status).toBe('inProgress');
});
it('recovers a known active ordinary-chat turn on its own server without sending another turn/start', async () => {
  const a = submit(true);
  await worker.dispatchNext();
  worker.close();
  worker = new TaskWorker(
    store,
    config,
    { endpoint: ordinary.endpoint, ready: true, error: null },
    'oc_chat',
  );
  await worker.start();
  expect(store.get(a.task_id).status).toBe('running');
  expect(ordinary.calls.filter((m) => m.method === 'turn/start')).toHaveLength(1);
  expect(ordinary.calls.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
  expect(project.calls.some((m) => m.params?.threadId?.startsWith('ordinary'))).toBe(false);
});
