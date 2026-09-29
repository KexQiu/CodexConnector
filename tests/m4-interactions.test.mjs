import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { TaskWorker, configuredOwner } from '../src/tasks/worker.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';
import { FeishuSender } from '../src/feishu/sender.ts';
import { FeishuRuntime } from '../src/feishu/runtime.ts';
import { RpcTransportError } from '../src/codex/rpc-client.ts';
import { migrationSources, migrate, SCHEMA_VERSION } from '../src/persistence/migrate.ts';
import { withinRoot } from '../src/tasks/interaction-policy.ts';

const credentials = {
  appId: 'cli_fixture',
  appSecret: 'fixture',
  tenantKey: 'tenant',
  allowedOpenId: 'ou_user',
  testChatId: 'oc_chat',
};
const wait = async (predicate) => {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Fixture timed out');
};
describe('M4 actual SQLite, WebSocket RPC and Feishu business routing; simulated servers', () => {
  let dir,
    db,
    store,
    worker,
    workers,
    server,
    wss,
    socket,
    config,
    task,
    inbox,
    commands,
    sender,
    cards,
    messages,
    replies,
    mode,
    remoteStatus;
  const event = (method, params) => socket.send(JSON.stringify({ method, params }));
  const turn = () => ({ id: 'turn-1', status: remoteStatus, items: [], error: null });
  const thread = (include) => ({
    id: 'thread-1',
    cwd: dir,
    historyMode: 'legacy',
    status: { type: 'idle' },
    turns: include ? [turn()] : [],
  });
  const rows = () => db.prepare('SELECT * FROM approvals ORDER BY rowid').all();
  const liveRows = () => rows().filter((r) => r.state === 'pending');
  const params = () => ({
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    startedAtMs: Date.now(),
    environmentId: null,
  });
  const commandParams = () => ({
    ...params(),
    kind: 'command',
    environmentId: 'local',
    cwd: dir,
    command: 'echo fixture',
    reason: 'M4 fixture',
    availableDecisions: ['accept', 'decline', 'cancel'],
  });
  const sendRequest = async (method, p, id = randomUUID()) => {
    const count = rows().length;
    socket.send(JSON.stringify({ id, method, params: p }));
    await wait(() => rows().length > count || replies.some((r) => r.id === id));
    return rows().at(-1);
  };
  const phone = async (text) => {
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
  };
  const callback = (nonce, messageId) => ({
    event_id: randomUUID(),
    app_id: credentials.appId,
    tenant_key: credentials.tenantKey,
    operator: { open_id: credentials.allowedOpenId },
    context: { open_chat_id: credentials.testChatId, open_message_id: messageId },
    action: { value: { gatewayNonce: nonce } },
  });
  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cfg-m4-')));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    workers = [];
    cards = [];
    messages = [];
    replies = [];
    mode = 'normal';
    remoteStatus = 'inProgress';
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on('connection', (s) => {
      socket = s;
      s.on('message', (data) => {
        const m = JSON.parse(data.toString());
        messages.push(m);
        const result = (r) => s.send(JSON.stringify({ id: m.id, result: r }));
        if (!m.method) {
          replies.push({
            ...m,
            durable: db
              .prepare(
                'SELECT response_state FROM approvals WHERE rpc_id_json=? ORDER BY rowid DESC LIMIT 1',
              )
              .pluck()
              .get(JSON.stringify(m.id)),
          });
          if (mode !== 'no-confirmation')
            s.send(
              JSON.stringify({
                method: 'serverRequest/resolved',
                params: { threadId: 'thread-1', requestId: m.id },
              }),
            );
          return;
        }
        if (m.method === 'initialize')
          return result({
            userAgent: 'fixture',
            codexHome: '/fixture',
            platformFamily: 'unix',
            platformOs: 'macos',
          });
        if (m.method === 'initialized') return;
        if (m.method === 'thread/read' && mode === 'disconnect-read') return s.terminate();
        if (m.method === 'thread/resume' && mode === 'writer-conflict')
          return s.send(
            JSON.stringify({
              id: m.id,
              error: { code: -32600, message: 'active writer private fixture' },
            }),
          );
        if (['thread/start', 'thread/resume', 'thread/read'].includes(m.method))
          return result({ thread: thread(m.params.includeTurns) });
        if (m.method === 'turn/start') return result({ turn: turn() });
        if (['turn/steer', 'turn/interrupt'].includes(m.method)) {
          if (mode === 'lost-control') return s.terminate();
          if (mode === 'reject-control')
            return s.send(
              JSON.stringify({
                id: m.id,
                error: { code: -32600, message: 'turn ended private detail' },
              }),
            );
          return result(m.method === 'turn/steer' ? { turnId: 'turn-1' } : {});
        }
        s.send(
          JSON.stringify({ id: m.id, error: { code: -32601, message: 'unsupported fixture' } }),
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    config = {
      schemaVersion: 1,
      dataDir: dir,
      maxConcurrentTasks: 1,
      codex: {
        binary: 'fixture',
        endpoint: `ws://127.0.0.1:${server.address().port}`,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
      },
      feishu: {
        appId: credentials.appId,
        tenantKey: credentials.tenantKey,
        allowedOpenId: credentials.allowedOpenId,
        credentialsFile: join(dir, 'unused'),
      },
      projects: [{ key: 'p', name: 'P', root: dir, remoteWrite: true }],
    };
    worker = new TaskWorker(store, config);
    workers.push(worker);
    await worker.start();
    task = store.submit({
      chatId: credentials.testChatId,
      owner: configuredOwner(config),
      requestKey: 'one',
      projectKey: 'p',
      cwd: dir,
      prompt: 'fixture',
    }).task;
    db.prepare('INSERT INTO task_destinations VALUES (?,?,?)').run(
      task.task_id,
      task.owner_key,
      credentials.testChatId,
    );
    await worker.dispatchNext();
    inbox = new FeishuInbox(store, credentials);
    commands = new FeishuCommands(
      inbox,
      config,
      { catalog: async () => [], sessions: async () => ({ data: [] }) },
      worker,
    );
    const remote = (id, content) => ({
      message_id: id,
      chat_id: credentials.testChatId,
      msg_type: 'interactive',
      sender: { id: credentials.appId, id_type: 'app_id', sender_type: 'app' },
      body: { content },
    });
    sender = new FeishuSender(store, credentials, {
      prepare: async () => {},
      create: async (chat, content) => {
        const id = `om_${cards.length}`;
        cards.push(remote(id, content));
        return id;
      },
      update: async (id, content) => {
        cards.find((c) => c.message_id === id).body.content = content;
        return id;
      },
      get: async (id) => cards.find((c) => c.message_id === id),
      history: async () => cards,
    });
  });
  afterEach(async () => {
    for (const w of workers) w.close();
    for (const s of wss.clients) s.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('rejects permission escalation for strict local policies without offering an approval card', async () => {
    delete config.projects[0].remoteWrite;
    config.projects[0].remotePermissions = { mode: 'read-only', networkAccess: false };
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    await wait(() => replies.length === 1);
    expect(row.state).toBe('unsupported');
    expect(replies[0].error).toBeTruthy();
    expect(store.get(task.task_id).waiting_approval).toBe(0);
  });
  it('does not send a previously selected grant after a stricter policy is applied', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    worker.interactions.decide(row.approval_id, 'accept');
    delete config.projects[0].remoteWrite;
    config.projects[0].remotePermissions = { mode: 'workspace-write', networkAccess: false };
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].error).toBeTruthy();
    expect(rows()[0].error_code).toBe('permission_changed');
  });
  it('still accepts ordinary clarification answers in a readonly project', async () => {
    delete config.projects[0].remoteWrite;
    config.projects[0].remotePermissions = { mode: 'read-only', networkAccess: false };
    const row = await sendRequest('item/tool/requestUserInput', {
      ...params(),
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'q',
          header: '范围',
          question: '请说明范围',
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    });
    expect(store.get(task.task_id).waiting_input).toBe(1);
    worker.interactions.answer(row.approval_id, 1, '仅分析');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({ answers: { q: { answers: ['仅分析'] } } });
  });
  it.each(['accept', 'decline', 'cancel'])(
    'maps command %s and commits the reply intent before the actual wire',
    async (choice) => {
      const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
      expect(store.get(task.task_id).waiting_approval).toBe(1);
      worker.interactions.decide(row.approval_id, choice);
      await worker.tickInteractions();
      await wait(() => replies.length === 1);
      expect(replies[0].result).toEqual({ decision: choice });
      expect(['intent', 'sent']).toContain(replies[0].durable);
      expect(rows()[0].state).toBe('resolved');
      expect(store.get(task.task_id).waiting_approval).toBe(0);
      expect(() => worker.interactions.decide(row.approval_id, choice)).toThrow(/失效/);
      expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    },
  );
  it('supports the observed local environment and respects cancel-only rejection choices', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', {
      ...commandParams(),
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/usr/bin/printf', 'fixture'] } },
        'cancel',
      ],
    });
    expect(row.state).toBe('pending');
    expect(() => worker.interactions.decide(row.approval_id, 'decline')).toThrow(/选项/);
    worker.interactions.decide(row.approval_id, 'cancel');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({ decision: 'cancel' });
    await sendRequest('item/commandExecution/requestApproval', {
      ...commandParams(),
      environmentId: 'remote-untrusted',
    });
    await wait(() => replies.length === 2);
    expect(rows()[1].state).toBe('unsupported');
  });
  it('renders and routes two real SDK-shaped button events to one approval decision', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    await sender.flushOne();
    expect(cards[0].body.content).toContain('echo fixture');
    const action = db
      .prepare("SELECT * FROM feishu_actions WHERE approval_id=? AND choice='accept'")
      .get(row.approval_id);
    expect(inbox.receive('action', callback(action.nonce, action.message_id)).outcome).toBe(
      'accepted',
    );
    expect(inbox.receive('action', callback(action.nonce, action.message_id)).outcome).toBe(
      'duplicate',
    );
    await commands.processNext();
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({ decision: 'accept' });
    expect(inbox.receive('action', callback(action.nonce, action.message_id)).outcome).toBe(
      'expired-or-invalid',
    );
  });
  it('validates observed file paths and maps file approval separately', async () => {
    event('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-1',
        type: 'fileChange',
        changes: [{ path: join(dir, 'file.txt'), kind: { type: 'add' }, diff: '+fixture' }],
      },
    });
    const row = await sendRequest('item/fileChange/requestApproval', {
      ...params(),
      reason: 'fixture',
      grantRoot: dir,
    });
    expect(row.state).toBe('pending');
    await sender.flushOne();
    expect(cards[0].body.content).toContain('+fixture');
    worker.interactions.decide(row.approval_id, 'decline');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({ decision: 'decline' });
  });
  it('refuses file changes without observed details or with an external move target', async () => {
    await sendRequest('item/fileChange/requestApproval', params());
    await wait(() => replies.length === 1);
    expect(rows()[0].state).toBe('unsupported');
    event('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-1',
        type: 'fileChange',
        changes: [
          {
            path: join(dir, 'file.txt'),
            kind: { type: 'update', move_path: '/private/tmp/outside-project.txt' },
            diff: 'fixture',
          },
        ],
      },
    });
    await sendRequest('item/fileChange/requestApproval', params());
    await wait(() => replies.length === 2);
    expect(rows()[1].state).toBe('unsupported');
    expect(replies.every((r) => r.error)).toBe(true);
  });
  it('rejects dangling symlink escapes and rechecks frozen file paths before approval', async () => {
    symlinkSync(join('/private/tmp', randomUUID()), join(dir, 'dangling'));
    expect(withinRoot(dir, join(dir, 'dangling', 'new-file'))).toBe(false);
    event('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-1',
        type: 'fileChange',
        changes: [
          { path: join(dir, 'future', 'file.txt'), kind: { type: 'add' }, diff: 'fixture' },
        ],
      },
    });
    const row = await sendRequest('item/fileChange/requestApproval', params());
    worker.interactions.decide(row.approval_id, 'accept');
    symlinkSync('/private/tmp', join(dir, 'future'));
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].error).toBeTruthy();
    expect(rows()[0].state).toBe('expired');
  });
  it('refuses secret input without persisting the private question', async () => {
    const row = await sendRequest('item/tool/requestUserInput', {
      ...params(),
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'secret',
          header: 'Secret',
          question: 'private sentinel',
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    });
    await wait(() => replies.length === 1);
    expect(row.state).toBe('unsupported');
    expect(row.payload).toBeNull();
    expect(replies[0].error).toBeTruthy();
  });
  it.each(['network', 'files', 'accept', 'decline'])(
    'grants exactly the selected permission subset: %s',
    async (choice) => {
      const permission = {
        network: { enabled: true },
        fileSystem: {
          read: [dir],
          write: [join(dir, 'output')],
          entries: [{ path: { type: 'path', path: dir }, access: 'read' }],
        },
      };
      const row = await sendRequest('item/permissions/requestApproval', {
        ...params(),
        cwd: dir,
        reason: 'fixture',
        permissions: permission,
      });
      worker.interactions.decide(row.approval_id, choice);
      await worker.tickInteractions();
      await wait(() => replies.length === 1);
      expect(replies[0].result).toEqual({
        permissions: {
          ...(['network', 'accept'].includes(choice) ? { network: permission.network } : {}),
          ...(['files', 'accept'].includes(choice) ? { fileSystem: permission.fileSystem } : {}),
        },
        scope: 'turn',
      });
    },
  );
  it('collects two answers by question ID, never replies early or creates another task', async () => {
    const questions = [
      {
        id: 'color',
        header: 'Color',
        question: 'Choose',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Blue', description: 'blue' }],
      },
      {
        id: 'comment',
        header: 'Text',
        question: 'Comment',
        isOther: true,
        isSecret: false,
        options: null,
      },
    ];
    const row = await sendRequest('item/tool/requestUserInput', {
      ...params(),
      questions,
      isBlocking: true,
      autoResolutionMs: null,
    });
    expect(store.get(task.task_id).waiting_input).toBe(1);
    await phone(`/回答 ${row.approval_id.slice(0, 8)} 1 Blue`);
    await worker.tickInteractions();
    expect(replies).toHaveLength(0);
    await phone(`/回答 ${row.approval_id.slice(0, 8)} 2 my answer`);
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({
      answers: { color: { answers: ['Blue'] }, comment: { answers: ['my answer'] } },
    });
    expect(store.list()).toHaveLength(1);
  });
  it('expires on resolved notifications and on turn completion before a click', async () => {
    const row = await sendRequest(
      'item/commandExecution/requestApproval',
      commandParams(),
      'request-1',
    );
    event('serverRequest/resolved', { threadId: 'thread-1', requestId: 'request-1' });
    await wait(() => rows()[0].state === 'resolved');
    expect(() => worker.interactions.decide(row.approval_id, 'accept')).toThrow();
    const second = await sendRequest(
      'item/commandExecution/requestApproval',
      commandParams(),
      'request-2',
    );
    worker.interactions.decide(second.approval_id, 'accept');
    remoteStatus = 'completed';
    event('turn/completed', { threadId: 'thread-1', turn: turn() });
    await wait(() => store.get(task.task_id).status === 'completed');
    await worker.tickInteractions();
    expect(replies).toHaveLength(0);
    expect(liveRows()).toHaveLength(0);
    expect(store.get(task.task_id).waiting_approval).toBe(0);
  });
  it('times out with an explicit error and rejects expired buttons', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    db.prepare('UPDATE approvals SET expires_at=1 WHERE approval_id=?').run(row.approval_id);
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].error.code).toBe(-32000);
    expect(rows()[0].state).toBe('expired');
    expect(() => worker.interactions.decide(row.approval_id, 'accept')).toThrow();
    await worker.tickInteractions();
    expect(replies).toHaveLength(1);
  });
  it('does not send a response if the durable intent write fails', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    worker.interactions.decide(row.approval_id, 'accept');
    db.exec(
      "CREATE TRIGGER fail_reply BEFORE UPDATE OF response_state ON approvals WHEN NEW.response_state='intent' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
    );
    await expect(worker.tickInteractions()).rejects.toThrow();
    expect(replies).toHaveLength(0);
    db.exec('DROP TRIGGER fail_reply');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
  });
  it('invalidates old request handles across reconnect, even when RPC IDs are reused', async () => {
    const row = await sendRequest(
      'item/commandExecution/requestApproval',
      commandParams(),
      'same-id',
    );
    worker.interactions.decide(row.approval_id, 'accept');
    worker.close();
    worker = new TaskWorker(store, config);
    workers.push(worker);
    await worker.start();
    expect(rows()[0].state).toBe('expired');
    expect(() => worker.interactions.decide(row.approval_id, 'accept')).toThrow();
    const next = await sendRequest(
      'item/commandExecution/requestApproval',
      commandParams(),
      'same-id',
    );
    expect(next.connection_epoch).not.toBe(row.connection_epoch);
    worker.interactions.decide(next.approval_id, 'decline');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({ decision: 'decline' });
  });
  it('does not confuse a successful socket write with server confirmation or replay it', async () => {
    mode = 'no-confirmation';
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    worker.interactions.decide(row.approval_id, 'accept');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(rows()[0].state).toBe('pending');
    expect(rows()[0].response_state).toBe('sent');
    await worker.tickInteractions();
    expect(replies).toHaveLength(1);
    worker.close();
    expect(rows()[0].state).toBe('expired');
    expect(rows()[0].response_state).toBe('unknown');
    mode = 'normal';
    worker = new TaskWorker(store, config);
    workers.push(worker);
    await worker.start();
    await worker.tickInteractions();
    expect(replies).toHaveLength(1);
  });
  it.each(['SIGTERM', 'SIGKILL'])(
    'recovers a real worker process killed with %s without restarting its turn',
    async (signal) => {
      worker.close();
      const configFile = join(dir, 'worker.json');
      writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tests/fixtures/m4-worker.mjs', configFile],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exit = once(child, 'exit');
      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      try {
        await wait(() => output.includes('READY'));
        const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
        expect(row.state).toBe('pending');
        child.kill(signal);
        await exit;
        worker = new TaskWorker(store, config);
        workers.push(worker);
        await worker.start();
        expect(rows()[0].state).toBe('expired');
        expect(store.get(task.task_id).status).toBe('running');
        expect(store.get(task.task_id).turn_id).toBe('turn-1');
        expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
        expect(() => worker.interactions.decide(row.approval_id, 'accept')).toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exit;
        }
      }
    },
  );
  it.each(['mcpServer/elicitation/request', 'item/tool/call'])(
    'gives %s an explicit unsupported result',
    async (method) => {
      const row = await sendRequest(method, params());
      await wait(() => replies.length === 1);
      expect(row.state).toBe('unsupported');
      expect(
        method === 'item/tool/call' ? replies[0].result.success : replies[0].result.action,
      ).toBe(method === 'item/tool/call' ? false : 'cancel');
    },
  );
  it('denies out-of-root symlinks and session-only command decisions', async () => {
    symlinkSync('/Users', join(dir, 'escape'));
    await sendRequest('item/permissions/requestApproval', {
      ...params(),
      cwd: dir,
      reason: null,
      permissions: {
        network: null,
        fileSystem: { read: null, write: [join(dir, 'escape', 'new-file')] },
      },
    });
    await wait(() => replies.length === 1);
    expect(rows()[0].state).toBe('unsupported');
    await sendRequest('item/commandExecution/requestApproval', {
      ...commandParams(),
      availableDecisions: ['acceptForSession'],
    });
    await wait(() => replies.length === 2);
    expect(replies.every((r) => r.error)).toBe(true);
  });
  it('rejects answers from a different user and approvals after project authorization is revoked', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    await sender.flushOne();
    const a = db
      .prepare("SELECT * FROM feishu_actions WHERE approval_id=? AND choice='accept'")
      .get(row.approval_id);
    const forged = callback(a.nonce, a.message_id);
    forged.operator.open_id = 'ou_intruder';
    expect(inbox.receive('action', forged).outcome).toBe('denied');
    worker.interactions.decide(row.approval_id, 'accept');
    config.projects[0].remoteWrite = false;
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].error).toBeTruthy();
  });
  it('sends steer with expectedTurnId; interrupt ACK keeps the task running until its terminal event', async () => {
    await phone(`/补充 ${task.task_id} extra instruction`);
    await worker.tickInteractions();
    expect(messages.find((m) => m.method === 'turn/steer').params.expectedTurnId).toBe('turn-1');
    await phone(`/打断 ${task.task_id}`);
    await worker.tickInteractions();
    expect(store.get(task.task_id).status).toBe('running');
    expect(store.diagnostics().locks).toBe(3);
    remoteStatus = 'interrupted';
    event('turn/completed', { threadId: 'thread-1', turn: turn() });
    await wait(() => store.get(task.task_id).status === 'interrupted');
    expect(store.diagnostics().locks).toBe(0);
    expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
  });
  it.each(['ended', 'reject-control', 'lost-control'])(
    'does not convert a %s steer race into another turn',
    async (scenario) => {
      worker.controls.enqueue('control-1', task.task_id, 'steer', 'extra');
      if (scenario === 'ended') {
        remoteStatus = 'completed';
        event('turn/completed', { threadId: 'thread-1', turn: turn() });
        await wait(() => store.get(task.task_id).status === 'completed');
      } else mode = scenario;
      await worker.tickInteractions();
      const control = db.prepare('SELECT * FROM task_controls').get();
      expect(control.state).toBe(scenario === 'lost-control' ? 'unknown' : 'rejected');
      expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
      if (scenario === 'lost-control') {
        mode = 'normal';
        worker.close();
        worker = new TaskWorker(store, config);
        workers.push(worker);
        await worker.start();
        await worker.tickInteractions();
        expect(messages.filter((m) => m.method === 'turn/steer')).toHaveLength(1);
      }
    },
  );
  it('keeps unknown and its lock if resume subscription fails although history says inProgress', async () => {
    worker.close();
    mode = 'writer-conflict';
    worker = new TaskWorker(store, config);
    workers.push(worker);
    await worker.start();
    expect(store.get(task.task_id).status).toBe('unknown');
    expect(store.diagnostics().locks).toBe(3);
    remoteStatus = 'completed';
    await worker.recover();
    expect(store.get(task.task_id).status).toBe('completed');
    expect(store.diagnostics().locks).toBe(0);
  });
  it('reconciles a subscribed turn without resuming or invalidating its pending approval', async () => {
    const row = await sendRequest('item/commandExecution/requestApproval', commandParams());
    await worker.recover();
    await worker.recover();
    expect(messages.filter((m) => m.method === 'thread/resume')).toHaveLength(0);
    expect(messages.filter((m) => m.method === 'thread/read')).toHaveLength(4);
    expect(worker.rpc.isReady).toBe(true);
    expect(liveRows()[0].approval_id).toBe(row.approval_id);
    worker.interactions.decide(row.approval_id, 'accept');
    await worker.tickInteractions();
    await wait(() => replies.length === 1);
    expect(replies[0].result).toEqual({ decision: 'accept' });
  });
  it('subscribes again after the server closes a previously loaded thread', async () => {
    event('thread/closed', { threadId: 'thread-1' });
    await delay(20);
    await worker.recover();
    await worker.recover();
    expect(messages.filter((m) => m.method === 'thread/resume')).toHaveLength(1);
    expect(store.get(task.task_id).status).toBe('running');
  });
  it('keeps Feishu delivery available when RPC disconnects during snapshot reconciliation', async () => {
    const runtime = new FeishuRuntime(store, config, credentials);
    runtime.worker = worker;
    runtime.sender.reconcileOne = sender.reconcileOne.bind(sender);
    runtime.sender.flushOne = sender.flushOne.bind(sender);
    mode = 'disconnect-read';
    try {
      await expect(runtime.tick()).resolves.toBeUndefined();
      expect(worker.rpc.isReady).toBe(false);
      expect(worker.rpc.disconnectReason).toBe('RPC connection closed');
      expect(store.get(task.task_id).status).toBe('unknown');
      expect(store.diagnostics().locks).toBe(3);
      expect(cards).toHaveLength(1);
      expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });
  it.each(['transport', 'storage'])(
    'handles a %s failure during interaction write with the correct boundary',
    async (kind) => {
      const runtime = new FeishuRuntime(store, config, credentials);
      runtime.worker = worker;
      runtime.sender.reconcileOne = sender.reconcileOne.bind(sender);
      runtime.sender.flushOne = sender.flushOne.bind(sender);
      const failure =
        kind === 'transport'
          ? new RpcTransportError('RPC send failed', 'unknown')
          : new Error('Fixture storage unavailable');
      worker.tickInteractions = async () => {
        throw failure;
      };
      try {
        if (kind === 'transport') {
          await expect(runtime.tick()).resolves.toBeUndefined();
          expect(cards).toHaveLength(1);
        } else {
          await expect(runtime.tick()).rejects.toBe(failure);
          expect(cards).toHaveLength(0);
        }
        expect(messages.filter((m) => m.method === 'turn/start')).toHaveLength(1);
      } finally {
        runtime.close();
      }
    },
  );
  it('marks explicit model policy refusal separately from generic execution failure', async () => {
    remoteStatus = 'failed';
    event('turn/completed', {
      threadId: 'thread-1',
      turn: {
        ...turn(),
        error: { codexErrorInfo: 'cyberPolicy', message: 'private upstream text' },
      },
    });
    await wait(() => store.get(task.task_id).status === 'failed');
    expect(store.get(task.task_id).error_code).toBe('model_refused');
    await sender.flushOne();
    expect(cards[0].body.content).toContain('模型明确拒绝');
    expect(cards[0].body.content).not.toContain('private upstream');
  });
  it('preserves v2 actions and refuses migration while the old Gateway lease exists', () => {
    const old = openGatewayDatabase(join(dir, 'v2.sqlite'));
    try {
      for (const m of migrationSources().slice(0, 2)) {
        old.exec(m.sql);
        old.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
        old.pragma(`user_version=${m.version}`);
      }
      old.prepare('INSERT INTO feishu_runtime_lease VALUES (1,?,?)').run(process.pid, 'token');
      expect(() => migrate(old)).toThrow(/Gateway/);
      expect(old.pragma('user_version', { simple: true })).toBe(2);
      old.exec('DELETE FROM feishu_runtime_lease');
      migrate(old);
      expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      old.close();
    }
  });
});
