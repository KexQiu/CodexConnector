import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskWorker, configuredOwner } from '../src/tasks/worker.ts';
import { executionPolicy } from '../src/tasks/project-policy.ts';

let root, db, store, server, wss, config, worker, requests, threads, badPolicy, activeMcp;
const freshWorker = async () => {
  worker = new TaskWorker(store, config);
  await worker.start();
};
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-concurrent-')));
  db = openGatewayDatabase(join(root, 'state.sqlite'));
  store = new TaskStore(db);
  requests = [];
  threads = new Map();
  badPolicy = false;
  activeMcp = false;
  server = createServer();
  wss = new WebSocketServer({ server });
  config = {
    schemaVersion: 1,
    dataDir: root,
    maxConcurrentTasks: 2,
    codex: {
      binary: 'fixture',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    },
    feishu: {
      appId: 'a',
      tenantKey: 't',
      allowedOpenId: 'u',
      credentialsFile: join(root, 'unused'),
    },
    projects: ['a', 'b', 'c'].map((key) => ({
      key,
      name: key,
      root: join(root, key),
      remotePermissions: { mode: 'workspace-write', networkAccess: false },
    })),
  };
  for (const p of config.projects) mkdirSync(p.root);
  wss.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString());
      requests.push(m);
      const reply = (result) => socket.send(JSON.stringify({ id: m.id, result }));
      if (m.method === 'initialize')
        return reply({
          userAgent: 'fixture',
          codexHome: root,
          platformFamily: 'unix',
          platformOs: 'macos',
        });
      if (m.method === 'config/read')
        return reply({ config: { mcp_servers: activeMcp ? { external: { enabled: true } } : {} } });
      if (m.method === 'thread/start') {
        const t = {
          id: `thread-${threads.size}`,
          cwd: m.params.cwd,
          historyMode: 'legacy',
          status: { type: 'idle' },
          turns: [],
        };
        threads.set(t.id, t);
        const project = config.projects.find((p) => p.root === t.cwd);
        return reply({
          thread: t,
          approvalPolicy: badPolicy ? 'on-request' : 'never',
          sandbox: executionPolicy(project, t.cwd).turn.sandboxPolicy,
        });
      }
      if (m.method === 'thread/resume' || m.method === 'thread/read') {
        const t = threads.get(m.params.threadId);
        const p = config.projects.find((p) => p.root === t.cwd);
        return reply({
          thread: { ...t, turns: m.params.includeTurns ? t.turns : [] },
          approvalPolicy: 'never',
          sandbox: executionPolicy(p, t.cwd).turn.sandboxPolicy,
        });
      }
      if (m.method === 'turn/start') {
        const t = threads.get(m.params.threadId);
        const turn = {
          id: `turn-${m.params.clientUserMessageId}`,
          status: 'inProgress',
          items: [],
          error: null,
        };
        t.turns.push(turn);
        return reply({ turn });
      }
      if (m.method === 'turn/interrupt') return reply({});
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.codex.endpoint = `ws://127.0.0.1:${server.address().port}`;
  await freshWorker();
});
afterEach(async () => {
  worker?.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const submit = (key, projectKey = 'a', threadId) => {
  const { task } = store.submit({
    owner: configuredOwner(config),
    requestKey: key,
    projectKey,
    cwd: config.projects.find((p) => p.key === projectKey).root,
    prompt: key,
    ...(threadId ? { threadId } : {}),
  });
  // Deterministic FIFO independent of clock precision / random IDs.
  db.prepare('UPDATE tasks SET created_at=? WHERE task_id=?').run(
    store.list().length,
    task.task_id,
  );
  return task;
};
const complete = (id) => {
  const task = store.get(id),
    t = threads.get(task.thread_id),
    turn = t.turns.find((v) => v.id === task.turn_id);
  turn.status = 'completed';
  store.reconcileTurn(id, turn);
};

it('skips a blocked checkout at the head, fills independent slots and guards overlapping dispatch calls', async () => {
  const a = submit('a1'),
    blocked = submit('a2'),
    b = submit('b1', 'b'),
    c = submit('c1', 'c');
  const first = worker.dispatchNext();
  expect(await worker.dispatchNext()).toBeNull();
  expect((await first).task_id).toBe(a.task_id);
  expect((await worker.dispatchNext()).task_id).toBe(b.task_id);
  expect(store.get(blocked.task_id).status).toBe('queued');
  expect(await worker.dispatchNext()).toBeNull();
  complete(a.task_id);
  expect((await worker.dispatchNext()).task_id).toBe(blocked.task_id);
  expect(store.get(c.task_id).status).toBe('queued');
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(3);
});
it('never dispatches siblings in one git checkout even when their project keys differ', async () => {
  mkdirSync(join(root, '.git'));
  submit('a1');
  submit('b1', 'b');
  expect((await worker.dispatchNext()).status).toBe('running');
  expect(await worker.dispatchNext()).toBeNull();
});
it('resumes multiple known turns after reconnect without duplicate start and keeps queued work blocked', async () => {
  const a = submit('a1'),
    b = submit('b1', 'b');
  submit('c1', 'c');
  await worker.dispatchNext();
  await worker.dispatchNext();
  worker.close();
  store.recoverLocal('restart');
  await freshWorker();
  expect(await worker.dispatchNext()).toBeNull();
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
  expect(requests.filter((r) => r.method === 'thread/resume')).toHaveLength(2);
  complete(a.task_id);
  complete(b.task_id);
  expect((await worker.dispatchNext()).project_key).toBe('c');
});
it('applies readonly sandbox on both a new task and a continued task', async () => {
  config.projects[0].remotePermissions.mode = 'read-only';
  const a = submit('read');
  await worker.dispatchNext();
  complete(a.task_id);
  submit('continue', 'a', store.get(a.task_id).thread_id);
  await worker.dispatchNext();
  expect(
    requests
      .filter((r) => ['thread/start', 'thread/resume'].includes(r.method))
      .every((r) => r.params.sandbox === 'read-only' && r.params.approvalPolicy === 'never'),
  ).toBe(true);
  expect(
    requests.filter((r) => r.method === 'turn/start').map((r) => r.params.sandboxPolicy),
  ).toEqual([
    { type: 'readOnly', networkAccess: false },
    { type: 'readOnly', networkAccess: false },
  ]);
});
it('rejects revoked queued work and rejects a backend that did not honor the local policy', async () => {
  const a = submit('a1');
  config.projects[0].remotePermissions.mode = 'disabled';
  expect((await worker.dispatchNext()).error_code).toBe('project_not_writable');
  expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(0);
  config.projects[0].remotePermissions.mode = 'workspace-write';
  badPolicy = true;
  submit('a2');
  expect((await worker.dispatchNext()).error_code).toBe('project_policy_mismatch');
  expect(requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
  expect(store.get(a.task_id).status).toBe('failed');
  expect(store.diagnostics().locks).toBe(0);
});
it('still interrupts its own running task after project execution has been disabled', async () => {
  const a = submit('a1');
  await worker.dispatchNext();
  config.projects[0].remotePermissions.mode = 'disabled';
  worker.controls.enqueue('stop', a.task_id, 'interrupt');
  await worker.tickInteractions();
  expect(requests.filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
  expect(store.get(a.task_id).status).toBe('running'); // An ACK is not a terminal event.
});

it('refuses project-specific unsandboxed MCP tools before creating a thread', async () => {
  activeMcp = true;
  submit('unsafe-tools');
  expect((await worker.dispatchNext()).error_code).toBe('project_tools_not_isolated');
  expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(0);
  expect(store.diagnostics().locks).toBe(0);
});
