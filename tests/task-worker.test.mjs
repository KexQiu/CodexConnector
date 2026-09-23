import { once } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskWorker, configuredOwner } from '../src/tasks/worker.ts';
import { CodexRpcClient } from '../src/codex/rpc-client.ts';
import { z } from 'zod';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture(mode) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-m2-worker-')));
  const db = openGatewayDatabase(join(directory, 'tasks.sqlite'));
  const store = new TaskStore(db);
  const server = createServer(),
    wss = new WebSocketServer({ server });
  const messages = [],
    errors = [],
    workers = [];
  let recovered = false;
  const turn = (status) => ({
    id: 'turn-1',
    status,
    items: status === 'completed' ? [{ id: 'answer', type: 'agentMessage', text: 'M2_DONE' }] : [],
    error: null,
  });
  const thread = (turns = []) => ({
    id: 'thread-1',
    cwd: directory,
    historyMode: 'legacy',
    status: { type: 'idle' },
    turns,
  });
  cleanups.push(async () => {
    for (const worker of workers) worker.close();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  wss.on('connection', (socket) => {
    const result = (id, value) => socket.send(JSON.stringify({ id, result: value }));
    const event = (method, params) => socket.send(JSON.stringify({ method, params }));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      messages.push(message);
      const handle = async () => {
        if (message.method === 'initialize')
          return result(message.id, {
            userAgent: 'fixture',
            codexHome: '/fixture',
            platformFamily: 'unix',
            platformOs: 'macos',
          });
        if (!message.method || message.method === 'initialized') return;
        if (['thread/start', 'turn/start'].includes(message.method)) {
          const intent = db
            .prepare(
              'SELECT state FROM rpc_operations WHERE rpc_id_json = ? ORDER BY rowid DESC LIMIT 1',
            )
            .pluck()
            .get(JSON.stringify(message.id));
          if (intent !== 'sent') errors.push('wire preceded durable intent');
        }
        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          if (message.method === 'thread/resume' && mode.startsWith('resume-reject'))
            return socket.send(
              JSON.stringify({
                id: message.id,
                error: {
                  code: -32600,
                  message:
                    mode === 'resume-reject-writer'
                      ? 'failed to initialize thread persistence: thread-store conflict: thread thread-1 already has an active writer; private-sentinel'
                      : 'other invalid request; private-sentinel',
                },
              }),
            );
          for (const [key, value] of Object.entries({
            cwd: directory,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
          }))
            if (message.params[key] !== value) errors.push(`missing policy ${key}`);
          return result(message.id, { thread: thread() });
        }
        if (message.method === 'thread/read')
          return result(message.id, {
            thread: thread(
              message.params.includeTurns ? [turn(recovered ? 'completed' : 'inProgress')] : [],
            ),
          });
        if (message.method === 'turn/start') {
          if (mode === 'reject')
            return socket.send(
              JSON.stringify({
                id: message.id,
                error: { code: -32602, message: 'fixture rejection' },
              }),
            );
          if (mode === 'early' || mode === 'lost') {
            event('turn/started', { threadId: 'thread-1', turn: turn('inProgress') });
            event('item/completed', {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { id: 'answer', type: 'agentMessage', text: 'M2_DONE' },
            });
            event('turn/completed', { threadId: 'thread-1', turn: turn('completed') });
            await delay(25);
            if (mode === 'lost') {
              socket.terminate();
              return;
            }
          }
          return result(message.id, { turn: turn('inProgress') });
        }
        return socket.send(
          JSON.stringify({
            id: message.id,
            error: { code: -32601, message: 'unsupported fixture method' },
          }),
        );
      };
      handle().catch((error) => errors.push(error.message));
    });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const config = {
    schemaVersion: 1,
    dataDir: directory,
    codex: {
      binary: 'fixture',
      endpoint: `ws://127.0.0.1:${server.address().port}`,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    },
    feishu: {
      appId: 'a',
      tenantKey: 't',
      allowedOpenId: 'u',
      credentialsFile: join(directory, 'unused.json'),
    },
    maxConcurrentTasks: 1,
    projects: [{ key: 'test', name: 'test', root: directory, remoteWrite: true }],
  };
  const submit = (key = 'request-1') =>
    store.submit({
      owner: configuredOwner(config),
      requestKey: key,
      projectKey: 'test',
      cwd: directory,
      prompt: 'A harmless fixture task',
    }).task;
  const worker = () => {
    const instance = new TaskWorker(store, config);
    workers.push(instance);
    return instance;
  };
  return {
    db,
    store,
    config,
    messages,
    errors,
    submit,
    worker,
    finish: () => {
      recovered = true;
    },
  };
}

describe('M2 worker through real local WebSocket (not a live model)', () => {
  it('persists RPC IDs before wire, binds early completion, and never reruns a request key', async () => {
    const f = await fixture('early');
    const task = f.submit(),
      worker = f.worker();
    await worker.start();
    const result = await worker.dispatchNext();
    expect(result.status).toBe('completed');
    expect(f.store.result(task.task_id)).toBe('M2_DONE');
    expect(f.errors).toEqual([]);
    expect(f.submit().task_id).toBe(task.task_id);
    expect(await worker.dispatchNext()).toBeNull();
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(
      f.db
        .prepare("SELECT count(*) FROM inbox WHERE source = 'rpc' AND state != 'processed'")
        .pluck()
        .get(),
    ).toBe(0);
  });
  it('keeps a lost start response unknown and locked after restart, despite early terminal events', async () => {
    const f = await fixture('lost');
    const task = f.submit(),
      worker = f.worker();
    await worker.start();
    expect((await worker.dispatchNext()).status).toBe('unknown');
    expect(f.store.get(task.task_id).turn_id).toBeNull();
    expect(f.db.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBe(2);
    worker.close();
    const restarted = f.worker();
    await restarted.start();
    f.submit('request-2');
    expect(await restarted.dispatchNext()).toBeNull();
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(f.store.get(task.task_id).status).toBe('unknown');
  });
  it('restores subscriptions and reconciles a known turn after gateway restart without resubmitting', async () => {
    const f = await fixture('running');
    const task = f.submit(),
      worker = f.worker();
    await worker.start();
    expect((await worker.dispatchNext()).status).toBe('running');
    worker.close();
    expect(f.store.get(task.task_id).status).toBe('unknown');
    f.finish();
    const restarted = f.worker();
    await restarted.start();
    expect(f.store.get(task.task_id).status).toBe('completed');
    expect(f.store.result(task.task_id)).toBe('M2_DONE');
    expect(f.messages.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
    expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });
  it('distinguishes an explicit turn rejection from an unknown submit and retains the created thread', async () => {
    const f = await fixture('reject');
    const task = f.submit(),
      worker = f.worker();
    await worker.start();
    const result = await worker.dispatchNext();
    expect(result.status).toBe('failed');
    expect(result.failure_phase).toBe('turn_start');
    expect(result.thread_id).toBe('thread-1');
    expect(f.db.prepare('SELECT count(*) FROM execution_locks').pluck().get()).toBe(0);
    expect(f.submit().task_id).toBe(task.task_id);
    expect(await worker.dispatchNext()).toBeNull();
  });
  it('rechecks write authorization at dispatch and performs no thread/turn mutation when revoked', async () => {
    const f = await fixture('early');
    f.submit();
    f.config.projects[0].remoteWrite = false;
    const worker = f.worker();
    await worker.start();
    expect((await worker.dispatchNext()).error_code).toBe('project_not_writable');
    expect(
      f.messages.filter((m) => ['thread/start', 'turn/start'].includes(m.method)),
    ).toHaveLength(0);
  });
  it.each(['resume-reject-writer', 'resume-reject-other'])(
    'handles %s before any new turn, without replay or exposing the remote message',
    async (mode) => {
      const f = await fixture(mode),
        first = f.submit();
      f.store.claim(first.task_id, 'fixture');
      f.store.bindThread(first.task_id, 'thread-1', f.config.projects[0].root, 'fixture');
      f.store.bindTurn(first.task_id, { id: 'turn-old', status: 'completed', items: [] });
      const { task } = f.store.submit({
        owner: configuredOwner(f.config),
        requestKey: 'continue',
        projectKey: 'test',
        cwd: f.config.projects[0].root,
        prompt: 'continue fixture',
        threadId: 'thread-1',
      });
      const worker = f.worker();
      await worker.start();
      const result = await worker.dispatchNext();
      expect(result).toMatchObject({
        status: 'failed',
        failure_phase: 'thread_start',
        turn_id: null,
        error_code:
          mode === 'resume-reject-writer' ? 'thread_writer_conflict' : 'rpc_rejected_-32600',
      });
      expect(f.messages.filter((m) => m.method === 'turn/start')).toHaveLength(0);
      expect(f.store.diagnostics().locks).toBe(0);
      expect(await worker.dispatchNext()).toBeNull();
      expect(f.messages.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
      expect(JSON.stringify(f.store.get(task.task_id))).not.toContain('private-sentinel');
    },
  );
  it('does not send request bytes when the durable beforeRequest hook fails', async () => {
    const f = await fixture('early');
    const rpc = new CodexRpcClient({
      endpoint: f.config.codex.endpoint,
      beforeRequest: (request) => {
        if (request.method === 'thread/start') throw new Error('fixture disk failure');
      },
    });
    try {
      await rpc.connect();
      await expect(rpc.request('thread/start', {}, z.unknown())).rejects.toMatchObject({
        outcome: 'not-sent',
      });
      await delay(20);
      expect(f.messages.filter((m) => m.method === 'thread/start')).toHaveLength(0);
      expect(rpc.pendingRequestCount).toBe(0);
    } finally {
      rpc.close();
    }
  });
});
