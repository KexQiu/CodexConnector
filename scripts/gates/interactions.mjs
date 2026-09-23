import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { configuredOwner } from '../../src/tasks/worker.ts';
import { FeishuRuntime } from '../../src/feishu/runtime.ts';
import { readCredentials } from '../../src/feishu/credentials.ts';
import { receiptMarker } from '../../src/feishu/sender.ts';
import { parseInteraction } from '../../src/tasks/interaction-policy.ts';
import { allowedInputMessage, inputPrompt, validateInputRequest } from './input-fixture.mjs';
import { permissionsPrompt, validatePermissionsRequest } from './permissions-fixture.mjs';
import {
  allowedPhoneControlMessage,
  phoneControlPrompt,
  phoneSteerText,
  phoneWaitSeconds,
  validatePhoneWaitItem,
} from './phone-control-fixture.mjs';
import {
  fileContent,
  fileTarget,
  filePrompt,
  validateFileRequest,
  validateFileOutcome,
} from './file-fixture.mjs';
import {
  privateDirectory,
  startServer,
  connectClient,
  versionBaseline,
  cleanupDirectory,
  ProbeBlocked,
  delay,
} from './probe-support.mjs';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    suite: { type: 'string', default: 'controls' },
    'permission-decision': { type: 'string', default: 'all' },
    'file-decision': { type: 'string', default: 'all' },
    'phone-mode': { type: 'string', default: 'all' },
    config: { type: 'string', default: 'config/feishu.local.json' },
    timeout: { type: 'string', default: '1800' },
    help: { type: 'boolean' },
  },
});
if (values.help || !values.live) {
  console.log(
    'pnpm gate:interactions --live --suite controls|phone-controls|approvals|inputs|permissions|files [--phone-mode all|interrupt-only] [--permission-decision all|network|cancel] [--file-decision all|accept|cancel] [--config config/feishu.local.json] [--timeout 1800]\nM4 controls: 真实模型、同 turn 补充/打断和 worker 重连。phone-controls: 固定 sleep 保持任务运行，手机依次发送补充和打断，核对同一 turn；--phone-mode interrupt-only 可单独补测打断。approvals: 专用飞书单聊由用户接受/拒绝两次固定 printf 请求。inputs: 临时启用输入工具，手机逐题回答两道题，再取消另一次请求。permissions: 临时启用权限工具，手机选择仅网络，再取消另一请求，不执行文件或网络操作；可用 --permission-decision 单独补测一项。files: 仅测试进程收紧为只读沙箱，验证固定临时文件的允许/取消；可用 --file-decision 单项补测。只使用临时项目、隔离外部集成；不更改全局配置，不安装服务。',
  );
  process.exit(values.help ? 0 : 1);
}
assert(
  ['controls', 'phone-controls', 'approvals', 'inputs', 'permissions', 'files'].includes(
    values.suite,
  ),
);
assert(['all', 'network', 'cancel'].includes(values['permission-decision']));
assert(values.suite === 'permissions' || values['permission-decision'] === 'all');
const permissionDecisions =
  values['permission-decision'] === 'all' ? ['network', 'cancel'] : [values['permission-decision']];
assert(['all', 'accept', 'cancel'].includes(values['file-decision']));
assert(values.suite === 'files' || values['file-decision'] === 'all');
const fileDecisions =
  values['file-decision'] === 'all' ? ['accept', 'cancel'] : [values['file-decision']];
assert(['all', 'interrupt-only'].includes(values['phone-mode']));
assert(values.suite === 'phone-controls' || values['phone-mode'] === 'all');
const selectedControls = values['phone-mode'] === 'all' ? ['steer', 'interrupt'] : ['interrupt'];
const timeout = Number(values.timeout);
assert(Number.isInteger(timeout) && timeout >= 60 && timeout <= 3600);
process.umask(0o077);
const credentials = readCredentials(resolve(values.config));
const runId =
  new Date().toISOString().replaceAll(':', '-') +
  '-' +
  values.suite +
  '-' +
  randomUUID().slice(0, 8);
const artifacts = resolve('.artifacts/m4', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const directory = await privateDirectory('codex-m4-');
const report = {
  runId,
  suite: values.suite,
  ...(values.suite === 'permissions' ? { selectedDecisions: permissionDecisions } : {}),
  ...(values.suite === 'files' ? { selectedDecisions: fileDecisions } : {}),
  ...(values.suite === 'phone-controls' ? { selectedControls } : {}),
  startedAt: new Date().toISOString(),
  baseline: null,
  status: 'RUNNING',
  checks: {},
  callbacks: [],
  cleanup: [],
  limitations: [
    'Tests fixed harmless commands, a timed sleep, questions, permission requests or no-tool model text inside a temporary project.',
    'The controls suite enqueues locally. The phone-controls suite and phone approval actions use the production SDK/inbox/commands.',
    'Only the selected suite and decisions are covered. Does not claim platform automatic redelivery.',
  ],
};
const checkpoint = () =>
  writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));
let server,
  client,
  db,
  runtime,
  stopped = false;
const stop = () => {
  stopped = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const deadline = Date.now() + timeout * 1000;
const check = () => {
  if (stopped || Date.now() > deadline)
    throw new ProbeBlocked(stopped ? 'Interrupted' : 'Timed out waiting for live interaction');
};
const commandItems = new Map();
let activeInputId = null;
const inputResponses = [];
const permissionResponses = [];
const fileResponses = [];
const fileItems = new Map();
let activeFileDecision = null;
let activePhoneTask = null;
let phoneStage = null;
let phoneWaitItem = null;
let phoneWaitStartedAt = null;
const phoneControlRequests = [];
let unexpectedRequest = false;
try {
  report.baseline = versionBaseline();
  const extraConfig = [
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.shell_snapshot=false',
    'mcp_servers={}',
    'model_reasoning_effort="low"',
  ];
  if (values.suite === 'inputs') {
    extraConfig.push('features.default_mode_request_user_input=true');
    report.limitations.push(
      'User-input tool is enabled only for this test App Server. Global/default production configuration is unchanged.',
    );
  }
  if (values.suite === 'permissions') {
    extraConfig.push('features.request_permissions_tool=true');
    report.limitations.push(
      'Permission tool is enabled only in this test process. Tests subset/empty RPC grants, not subsequent sandbox enforcement; no network or file operations are requested.',
    );
  }
  if (values.suite === 'files') {
    report.limitations.push(
      'Only this test overrides thread and turn sandbox to read-only to trigger native file approval inside the project. Production workspace-write policy and global config are unchanged.',
    );
  }
  if (values.suite === 'phone-controls') {
    report.limitations.push(
      'Verifies phone messages reach steer/interrupt for the same turn, acknowledgement and interruption. Does not claim the model completed the steer instruction. Uses one fixed sleep command to keep the turn active.',
    );
  }
  const configSchema = z.object({
    config: z.object({
      mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
      features: z.record(z.string(), z.unknown()),
    }),
  });
  server = await startServer({ directory, homeMode: 'existing', transport: 'unix', extraConfig });
  client = await connectClient(server);
  let effective = await client.request(
    'config/read',
    { includeLayers: false, cwd: directory },
    configSchema,
  );
  const names = Object.entries(effective.config.mcp_servers)
    .filter(([, s]) => s.enabled !== false)
    .map(([n]) => n);
  if (names.length) {
    assert(names.every((n) => /^[a-zA-Z0-9_-]+$/.test(n)));
    client.close();
    report.cleanup.push({ stage: 'discovery', ...(await server.stop()) });
    extraConfig.push(...names.map((n) => `mcp_servers.${n}.enabled=false`));
    server = await startServer({ directory, homeMode: 'existing', transport: 'unix', extraConfig });
    client = await connectClient(server);
    effective = await client.request(
      'config/read',
      { includeLayers: false, cwd: directory },
      configSchema,
    );
  }
  assert(Object.values(effective.config.mcp_servers).every((s) => s.enabled === false));
  for (const key of ['hooks', 'plugins', 'apps', 'multi_agent'])
    assert.equal(effective.config.features[key], false);
  if (values.suite === 'inputs') {
    assert.equal(effective.config.features.default_mode_request_user_input, true);
    report.checks.inputToolEnabledInTestProcess = 'PASS';
  }
  if (values.suite === 'permissions') {
    assert.equal(effective.config.features.request_permissions_tool, true);
    report.checks.permissionToolEnabledInTestProcess = 'PASS';
  }
  client.close();
  client = undefined;
  report.checks.integrationIsolation = 'PASS';
  db = openGatewayDatabase(join(artifacts, 'gateway.sqlite'));
  const store = new TaskStore(db);
  const config = {
    schemaVersion: 1,
    dataDir: artifacts,
    maxConcurrentTasks: 1,
    codex: {
      binary: report.baseline.binary,
      endpoint: server.endpoint,
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    },
    feishu: {
      appId: credentials.appId,
      tenantKey: credentials.tenantKey,
      allowedOpenId: credentials.allowedOpenId,
      credentialsFile: resolve(values.config),
    },
    projects: [{ key: 'fixture', name: 'M4 临时验收', root: directory, remoteWrite: true }],
  };
  await writeFile(join(artifacts, 'config.private.json'), JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  const record = store.recordEvent.bind(store);
  store.recordEvent = (event) => {
    record(event);
    if (
      values.suite === 'phone-controls' &&
      event.method === 'item/started' &&
      event.params?.item?.type === 'commandExecution'
    ) {
      try {
        validatePhoneWaitItem(event.params.item, directory);
        if (phoneWaitItem && phoneWaitItem.id !== event.params.item.id)
          throw new Error('Unexpected second sleep command');
        phoneWaitItem = event.params.item;
        phoneWaitStartedAt ??= Date.now();
      } catch {
        unexpectedRequest = true;
      }
    }
    if (event.method === 'item/completed' && event.params?.item?.type === 'fileChange')
      fileItems.set(event.params.turnId, event.params.item);
    if (event.method === 'item/completed' && event.params?.item?.type === 'commandExecution') {
      const p = event.params;
      commandItems.set(p.turnId, {
        itemId: p.item.id,
        status: p.item.status,
        exitCode: p.item.exitCode,
        output: p.item.aggregatedOutput,
      });
    }
  };
  runtime = new FeishuRuntime(store, config, credentials);
  const incoming = runtime.inbox.receive.bind(runtime.inbox);
  runtime.inbox.receive = (kind, data) => {
    if (values.suite === 'phone-controls') {
      if (
        kind !== 'message' ||
        !allowedPhoneControlMessage(data.message?.content, activePhoneTask, phoneStage)
      )
        return { outcome: 'ignored' };
    } else if (
      kind !== 'action' &&
      !(
        values.suite === 'inputs' &&
        kind === 'message' &&
        allowedInputMessage(data.message?.content, activeInputId)
      )
    )
      return { outcome: 'ignored' };
    const result = incoming(kind, data);
    if (result.outcome === 'accepted' || result.outcome === 'duplicate')
      report.callbacks.push({
        kind,
        at: new Date().toISOString(),
        outcome: result.outcome,
        eventHash: createHash('sha256').update(data.event_id).digest('hex'),
      });
    return result;
  };
  const allowed = new Set([
    '/usr/bin/printf M4_APPROVAL_PROBE',
    ...['-c', '-lc'].flatMap((flag) => [
      '/bin/zsh ' + flag + " '/usr/bin/printf M4_APPROVAL_PROBE'",
      '/bin/zsh ' + flag + ' "/usr/bin/printf M4_APPROVAL_PROBE"',
    ]),
  ]);
  const guardWorker = () => {
    if (values.suite === 'phone-controls') {
      const request = runtime.worker.rpc.request.bind(runtime.worker.rpc);
      runtime.worker.rpc.request = (method, params, schema, timeoutMs) => {
        if (method === 'turn/steer' || method === 'turn/interrupt')
          phoneControlRequests.push({ method, params });
        return request(method, params, schema, timeoutMs);
      };
    }
    if (values.suite === 'files') {
      const request = runtime.worker.rpc.request.bind(runtime.worker.rpc);
      runtime.worker.rpc.request = async (method, params, schema, timeoutMs) => {
        if (method === 'thread/start' || method === 'thread/resume') {
          const result = await request(
            method,
            { ...params, sandbox: 'read-only' },
            schema.and(
              z.object({
                sandbox: z.object({ type: z.literal('readOnly'), networkAccess: z.literal(false) }),
              }),
            ),
            timeoutMs,
          );
          report.checks.testThreadReadOnlySandbox = 'PASS';
          return result;
        }
        if (method === 'turn/start') {
          params = { ...params, sandboxPolicy: { type: 'readOnly', networkAccess: false } };
          report.testTurnSandbox = params.sandboxPolicy;
        }
        return request(method, params, schema, timeoutMs);
      };
    }
    const respond = runtime.worker.rpc.respond.bind(runtime.worker.rpc);
    runtime.worker.rpc.respond = async (request, response) => {
      if (request.method === 'item/tool/requestUserInput')
        inputResponses.push({ requestId: request.id, response });
      if (request.method === 'item/permissions/requestApproval')
        permissionResponses.push({ requestId: request.id, response });
      if (request.method === 'item/fileChange/requestApproval')
        fileResponses.push({ requestId: request.id, response });
      return respond(request, response);
    };
    const receive = runtime.worker.interactions.receive.bind(runtime.worker.interactions);
    runtime.worker.interactions.receive = async (request) => {
      let expectedInput = false;
      let expectedPermissions = false;
      let expectedFile = false;
      if (values.suite === 'inputs') {
        try {
          validateInputRequest(request, directory);
          expectedInput = true;
        } catch (error) {
          await writeFile(
            join(artifacts, 'input-shape.private.json'),
            JSON.stringify(
              {
                method: request.method,
                params:
                  request.method === 'item/tool/requestUserInput' ? request.params : undefined,
                error: error.message,
              },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          );
          /* Reject unexpected input shape. */
        }
      }
      if (values.suite === 'permissions') {
        try {
          validatePermissionsRequest(request, directory);
          expectedPermissions = true;
        } catch (error) {
          await writeFile(
            join(artifacts, 'permissions-shape.private.json'),
            JSON.stringify(
              {
                method: request.method,
                params:
                  request.method === 'item/permissions/requestApproval'
                    ? request.params
                    : undefined,
                error: error.message,
              },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          );
        }
      }
      if (values.suite === 'files') {
        let observation;
        try {
          if (!activeFileDecision) throw new Error('No active file test');
          const p = request.params;
          const raw = db
            .prepare(
              'SELECT payload FROM tool_observations WHERE thread_id=? AND turn_id=? AND item_id=?',
            )
            .pluck()
            .get(p?.threadId ?? '', p?.turnId ?? '', p?.itemId ?? '');
          observation = typeof raw === 'string' ? JSON.parse(raw) : undefined;
          validateFileRequest(request, observation, directory, activeFileDecision);
          expectedFile = true;
        } catch (error) {
          await writeFile(
            join(artifacts, 'file-shape.private.json'),
            JSON.stringify(
              {
                method: request.method,
                params:
                  request.method === 'item/fileChange/requestApproval' ? request.params : undefined,
                observation,
                error: error.message,
              },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          );
        }
      }
      if (
        !expectedInput &&
        !expectedPermissions &&
        !expectedFile &&
        (values.suite !== 'approvals' ||
          request.method !== 'item/commandExecution/requestApproval' ||
          request.params?.cwd !== directory ||
          !allowed.has(request.params.command))
      ) {
        unexpectedRequest = true;
        await runtime.worker.rpc.reject(request);
        return;
      }
      await receive(request);
      const stored = db
        .prepare('SELECT state FROM approvals WHERE connection_epoch=? AND rpc_id_json=?')
        .pluck()
        .get(request.connectionEpoch, JSON.stringify(request.id));
      if (stored === 'unsupported') {
        let diagnostic;
        try {
          parseInteraction(request.method, request.params, directory);
          diagnostic = { reason: 'Project or display constraints' };
        } catch (error) {
          diagnostic = { name: error.name, message: error.message };
        }
        await writeFile(
          join(artifacts, 'approval-shape.private.json'),
          JSON.stringify({ params: request.params, diagnostic }, null, 2) + '\n',
          { mode: 0o600 },
        );
      }
    };
  };
  guardWorker();
  await runtime.start();
  assert(runtime.worker.rpc.isReady);
  report.checks.connections = 'PASS';
  const submit = (key, prompt) => {
    const task = store.submit({
      owner: configuredOwner(config),
      requestKey: key,
      projectKey: 'fixture',
      cwd: directory,
      prompt,
    }).task;
    db.prepare('INSERT INTO task_destinations VALUES (?,?,?)').run(
      task.task_id,
      task.owner_key,
      credentials.testChatId,
    );
    store.refresh(task.task_id);
    return task.task_id;
  };
  const tick = async () => {
    check();
    if (unexpectedRequest)
      throw new ProbeBlocked('Unexpected tool request; refused without approval');
    await runtime.tick();
    await delay(250);
  };
  const terminal = async (id) => {
    while (!['completed', 'failed', 'interrupted'].includes(store.get(id).status)) {
      if (store.get(id).status === 'unknown')
        throw new ProbeBlocked(
          `Task became unknown; no automatic replay (${runtime.worker.rpc.disconnectReason ?? 'no transport error'})`,
        );
      await tick();
    }
    return store.get(id);
  };
  const verifyCard = async (id) => {
    const deliveryDeadline = Date.now() + 60_000;
    while (
      db.prepare("SELECT 1 FROM outbox WHERE state NOT IN ('delivered','superseded') LIMIT 1").get()
    ) {
      if (Date.now() >= deliveryDeadline) {
        report.deliveryBlocked = db
          .prepare(
            "SELECT card_version,state,error_code FROM outbox WHERE state NOT IN ('delivered','superseded')",
          )
          .all();
        throw new ProbeBlocked(
          'Card delivery could not be verified within 60 seconds; ambiguous writes are not retried',
        );
      }
      await tick();
    }
    const task = store.get(id),
      outbox = db
        .prepare("SELECT * FROM outbox WHERE task_id=? AND card_version=? AND state='delivered'")
        .get(id, task.version);
    assert(outbox);
    const message = await runtime.api.get(task.notification_message_id);
    assert.equal(message.chat_id, credentials.testChatId);
    assert.equal(message.sender.id, credentials.appId);
    assert.equal(message.sender.sender_type, 'app');
    assert(!message.deleted && message.body.content.includes(receiptMarker(outbox.outbox_id)));
  };
  if (values.suite === 'controls') {
    const id = submit(
      'controls',
      'Do not use tools or read any file or personal data. List the integers 1 through 5000 in order, one per line.',
    );
    await runtime.worker.dispatchNext();
    const running = store.get(id);
    assert.equal(running.status, 'running');
    // The start response may precede execution-loop readiness.
    await delay(1200);
    runtime.worker.controls.enqueue(
      'm4-steer',
      id,
      'steer',
      'Continue with only the odd integers. Do not use tools.',
    );
    await runtime.worker.tickInteractions();
    assert.equal(
      db.prepare("SELECT state FROM task_controls WHERE control_id='m4-steer'").pluck().get(),
      'accepted',
    );
    report.checks.steerAcceptedForExactTurn = 'PASS';
    await checkpoint();
    runtime.worker.close();
    // Runtime creates a new client/epoch, reconnects and subscribes before snapshot reconciliation.
    await runtime.tick();
    guardWorker();
    assert.equal(store.get(id).turn_id, running.turn_id);
    assert.equal(store.get(id).status, 'running');
    report.checks.workerReconnectSameTurn = 'PASS';
    runtime.worker.controls.enqueue('m4-interrupt', id, 'interrupt');
    await runtime.worker.tickInteractions();
    assert.equal(
      db.prepare("SELECT state FROM task_controls WHERE control_id='m4-interrupt'").pluck().get(),
      'accepted',
    );
    const done = await terminal(id);
    assert.equal(done.status, 'interrupted');
    assert.equal(
      db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
      1,
    );
    assert.equal(store.diagnostics().locks, 0);
    await verifyCard(id);
    report.checks.interruptTerminalAndLockRelease = 'PASS';
    report.checks.noSecondTurn = 'PASS';
    report.checks.remoteTerminalCard = 'PASS';
  } else if (values.suite === 'phone-controls') {
    const id = submit('phone-controls', phoneControlPrompt(directory));
    await runtime.worker.dispatchNext();
    const running = store.get(id);
    assert.equal(running.status, 'running');
    const requireRunning = async () => {
      if (store.get(id).status !== 'running') {
        if (['completed', 'failed', 'interrupted'].includes(store.get(id).status))
          await verifyCard(id);
        throw new ProbeBlocked(
          'Phone control turn ended or became unavailable before the required action',
        );
      }
    };
    while (!phoneWaitItem) {
      await requireRunning();
      await tick();
    }
    await verifyCard(id);
    await requireRunning();
    assert(!commandItems.has(running.turn_id));
    report.checks.fixedWaitCommandStarted = 'PASS';
    report.waitCommand = {
      command: phoneWaitItem.command,
      itemId: phoneWaitItem.id,
      seconds: phoneWaitSeconds,
    };
    activePhoneTask = id;
    for (const kind of selectedControls) {
      phoneStage = kind;
      report.waitingFor = {
        stage: kind,
        taskPrefix: id.slice(0, 8),
        message:
          kind === 'steer'
            ? `/补充 ${id.slice(0, 8)} ${phoneSteerText}`
            : `/打断 ${id.slice(0, 8)}`,
        expiresAt: new Date(
          Math.min(deadline, phoneWaitStartedAt + phoneWaitSeconds * 1000),
        ).toISOString(),
      };
      await checkpoint();
      log('phone-control-ready', { ...report.waitingFor, report: join(artifacts, 'report.json') });
      let control;
      while (true) {
        control = db
          .prepare('SELECT * FROM task_controls WHERE task_id=? AND kind=?')
          .get(id, kind);
        if (control && !['queued', 'sending'].includes(control.state)) break;
        await requireRunning();
        await tick();
      }
      phoneStage = null;
      assert.equal(control.state, 'accepted');
      assert.equal(control.turn_id, running.turn_id);
      const method = kind === 'steer' ? 'turn/steer' : 'turn/interrupt';
      const calls = phoneControlRequests.filter((c) => c.method === method);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0].params,
        kind === 'steer'
          ? {
              threadId: running.thread_id,
              expectedTurnId: running.turn_id,
              clientUserMessageId: control.control_id,
              input: [{ type: 'text', text: phoneSteerText, text_elements: [] }],
            }
          : { threadId: running.thread_id, turnId: running.turn_id },
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) FROM rpc_operations WHERE task_id=? AND method=? AND state='known'",
          )
          .pluck()
          .get(id, method),
        1,
      );
      report.checks[`phoneControl_${kind}`] = 'PASS';
      report[`${kind}Evidence`] = {
        originalTurn: true,
        controlState: control.state,
        requests: 1,
        wire: calls[0],
      };
      delete report.waitingFor;
      // Notification recovery must not prevent the user from interrupting an active turn.
      if (kind === 'steer') await requireRunning();
      await checkpoint();
      log('phone-control-verified', { kind });
    }
    activePhoneTask = null;
    const done = await terminal(id);
    assert.equal(done.status, 'interrupted');
    assert.equal(done.turn_id, running.turn_id);
    assert.equal(store.diagnostics().locks, 0);
    assert.equal(
      db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
      1,
    );
    assert.equal(
      db.prepare('SELECT count(*) FROM task_controls').pluck().get(),
      selectedControls.length,
    );
    assert.equal(
      report.callbacks.filter((e) => e.kind === 'message' && e.outcome === 'accepted').length,
      selectedControls.length,
    );
    assert.equal(report.callbacks.filter((e) => e.kind === 'action').length, 0);
    report.checks.phoneInterruptTerminalAndLockRelease = 'PASS';
    report.checks[
      selectedControls.length === 2 ? 'twoPhoneMessagesOneTurn' : 'onePhoneMessageOneTurn'
    ] = 'PASS';
    report.waitCommandResult = commandItems.get(running.turn_id) ?? null;
    await checkpoint();
    await verifyCard(id);
    report.checks.remoteTerminalCard = 'PASS';
  } else if (values.suite === 'inputs') {
    for (const mode of ['answer', 'cancel']) {
      const id = submit(`input-${mode}`, inputPrompt(mode === 'cancel'));
      await runtime.worker.dispatchNext();
      const turnId = store.get(id).turn_id;
      let row;
      while (
        !(row = db
          .prepare("SELECT * FROM approvals WHERE task_id=? AND state='pending' LIMIT 1")
          .get(id))
      ) {
        if (['completed', 'failed', 'interrupted', 'unknown'].includes(store.get(id).status))
          throw new ProbeBlocked('Model did not produce the requested input questions');
        await tick();
      }
      assert.equal(row.method, 'item/tool/requestUserInput');
      activeInputId = mode === 'answer' ? row.approval_id : null;
      await verifyCard(id);
      if (
        db
          .prepare('SELECT state FROM approvals WHERE approval_id=?')
          .pluck()
          .get(row.approval_id) !== 'pending'
      )
        throw new ProbeBlocked('Input request ended before its card was delivered');
      report.inputMode = {
        isBlocking: JSON.parse(row.payload).isBlocking,
        autoResolutionMs: JSON.parse(row.payload).autoResolutionMs,
      };
      report.waitingFor = {
        mode,
        stage: mode === 'answer' ? 'question-1' : 'cancel',
        taskPrefix: id.slice(0, 8),
        approvalId: row.approval_id,
        expiresAt: new Date(row.expires_at).toISOString(),
        ...(mode === 'answer'
          ? {
              messages: [
                `/回答 ${row.approval_id.slice(0, 8)} 1 蓝色`,
                `/回答 ${row.approval_id.slice(0, 8)} 2 中文`,
              ],
            }
          : {}),
      };
      await checkpoint();
      log('phone-input-ready', { ...report.waitingFor, report: join(artifacts, 'report.json') });
      let partialVerified = false;
      const responsesBefore = inputResponses.length;
      while (!['completed', 'failed', 'interrupted'].includes(store.get(id).status)) {
        if (store.get(id).status === 'unknown')
          throw new ProbeBlocked('Input task became unknown; no automatic replay');
        await tick();
        const pending = db
          .prepare('SELECT * FROM approvals WHERE approval_id=?')
          .get(row.approval_id);
        const answers = JSON.parse(pending.answers);
        if (
          mode === 'answer' &&
          !partialVerified &&
          answers.color === '蓝色' &&
          !answers.language
        ) {
          assert.equal(pending.state, 'pending');
          assert.equal(pending.response_state, 'none');
          assert.equal(inputResponses.length, responsesBefore);
          assert.equal(store.get(id).waiting_input, 1);
          partialVerified = true;
          report.checks.partialAnswerStillWaiting = 'PASS';
          report.waitingFor.stage = 'question-2';
          await checkpoint();
          log('phone-input-partial-verified', { nextMessage: report.waitingFor.messages[1] });
        }
      }
      activeInputId = null;
      const approval = db
        .prepare('SELECT * FROM approvals WHERE approval_id=?')
        .get(row.approval_id);
      const done = store.get(id);
      assert.equal(done.turn_id, turnId);
      assert.equal(done.status, 'completed');
      assert.equal(approval.state, 'resolved');
      assert.equal(approval.response_state, 'sent');
      assert.equal(approval.decision, mode);
      assert.equal(inputResponses.length, responsesBefore + 1);
      assert.deepEqual(
        inputResponses.at(-1).response,
        mode === 'answer'
          ? { answers: { color: { answers: ['蓝色'] }, language: { answers: ['中文'] } } }
          : { answers: {} },
      );
      const output = store.result(id);
      if (mode === 'answer') {
        assert(partialVerified);
        assert(
          output.includes('M4_INPUT_OK') && output.includes('蓝色') && output.includes('中文'),
        );
      } else assert(output.includes('M4_INPUT_CANCELLED'));
      await verifyCard(id);
      report.checks[`phoneInput_${mode}`] = 'PASS';
      report.checks[`remoteCard_${mode}`] = 'PASS';
      delete report.waitingFor;
      await checkpoint();
      log('input-verified', { mode });
    }
    assert.equal(store.diagnostics().locks, 0);
    assert.equal(
      db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
      2,
    );
    assert.equal(
      report.callbacks.filter((e) => e.kind === 'message' && e.outcome === 'accepted').length,
      2,
    );
    assert.equal(
      report.callbacks.filter((e) => e.kind === 'action' && e.outcome === 'accepted').length,
      1,
    );
    report.checks.twoMessagesOneCancelTwoTurns = 'PASS';
  } else if (values.suite === 'files') {
    for (const decision of fileDecisions) {
      activeFileDecision = decision;
      const target = fileTarget(directory, decision);
      assert(!existsSync(target));
      const id = submit(`file-${decision}`, filePrompt(directory, decision));
      await runtime.worker.dispatchNext();
      const turnId = store.get(id).turn_id;
      let row;
      while (
        !(row = db
          .prepare("SELECT * FROM approvals WHERE task_id=? AND state='pending' LIMIT 1")
          .get(id))
      ) {
        if (['completed', 'failed', 'interrupted', 'unknown'].includes(store.get(id).status)) {
          if (store.get(id).status !== 'unknown') await verifyCard(id);
          throw new ProbeBlocked(
            'Model did not produce native file approval; no phone approval coverage',
          );
        }
        await tick();
      }
      assert.equal(row.method, 'item/fileChange/requestApproval');
      assert(!existsSync(target));
      await verifyCard(id);
      assert.equal(
        db.prepare('SELECT state FROM approvals WHERE approval_id=?').pluck().get(row.approval_id),
        'pending',
      );
      report.waitingFor = {
        decision,
        button: decision === 'accept' ? '仅允许本次' : '取消',
        taskPrefix: id.slice(0, 8),
        approvalId: row.approval_id,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
      const responsesBefore = fileResponses.length;
      await checkpoint();
      log('phone-file-ready', { ...report.waitingFor, report: join(artifacts, 'report.json') });
      const done = await terminal(id);
      await verifyCard(id);
      const approval = db
        .prepare('SELECT * FROM approvals WHERE approval_id=?')
        .get(row.approval_id);
      const item = fileItems.get(turnId);
      const fileCreated = existsSync(target);
      const responseCount = fileResponses.length - responsesBefore;
      report[`${decision}Evidence`] = {
        taskStatus: done.status,
        toolStatus: item?.status ?? null,
        fileCreated,
        ...(decision === 'accept' && fileCreated
          ? { fileContentMatches: (await readFile(target, 'utf8')) === fileContent }
          : {}),
        response: responseCount > 0 ? fileResponses.at(-1).response : null,
        responseCount,
      };
      // Preserve the disk and protocol evidence even if a later assertion fails.
      await checkpoint();
      if (approval.state === 'expired') {
        delete report.waitingFor;
        throw new ProbeBlocked('File approval expired before a phone decision');
      }
      assert.equal(done.turn_id, turnId);
      assert.equal(approval.decision, decision);
      assert.equal(approval.state, 'resolved');
      assert.equal(approval.response_state, 'sent');
      assert.equal(fileResponses.length, responsesBefore + 1);
      assert.deepEqual(fileResponses.at(-1).response, { decision });
      assert(item);
      validateFileOutcome(decision, report[`${decision}Evidence`]);
      if (done.status === 'completed')
        assert(store.result(id).includes(`M4_FILE_${decision.toUpperCase()}_DONE`));
      report.checks[`phoneFile_${decision}`] = 'PASS';
      report.checks[`remoteCard_${decision}`] = 'PASS';
      delete report.waitingFor;
      await checkpoint();
      log('file-verified', { decision });
    }
    activeFileDecision = null;
    assert.equal(store.diagnostics().locks, 0);
    assert.equal(
      report.callbacks.filter((e) => e.kind === 'action' && e.outcome === 'accepted').length,
      fileDecisions.length,
    );
    assert.equal(
      db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
      fileDecisions.length,
    );
    report.checks.selectedFileDecisionsNoExtraTurns = 'PASS';
  } else if (values.suite === 'permissions') {
    for (const decision of permissionDecisions) {
      const id = submit(
        `permissions-${decision}`,
        permissionsPrompt(directory, decision === 'cancel'),
      );
      await runtime.worker.dispatchNext();
      const turnId = store.get(id).turn_id;
      let row;
      while (
        !(row = db
          .prepare("SELECT * FROM approvals WHERE task_id=? AND state='pending' LIMIT 1")
          .get(id))
      ) {
        if (['completed', 'failed', 'interrupted', 'unknown'].includes(store.get(id).status))
          throw new ProbeBlocked('Model did not produce the requested permission approval');
        await tick();
      }
      assert.equal(row.method, 'item/permissions/requestApproval');
      await verifyCard(id);
      assert.equal(
        db.prepare('SELECT state FROM approvals WHERE approval_id=?').pluck().get(row.approval_id),
        'pending',
      );
      report.waitingFor = {
        decision,
        button: decision === 'network' ? '仅网络（本轮）' : '取消',
        taskPrefix: id.slice(0, 8),
        approvalId: row.approval_id,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
      const responsesBefore = permissionResponses.length;
      await checkpoint();
      log('phone-permissions-ready', {
        ...report.waitingFor,
        report: join(artifacts, 'report.json'),
      });
      const done = await terminal(id);
      assert.equal(done.turn_id, turnId);
      const approval = db
        .prepare('SELECT * FROM approvals WHERE approval_id=?')
        .get(row.approval_id);
      // Deliver the real terminal state even when the phone decision never arrived.
      await verifyCard(id);
      if (approval.state === 'expired') {
        report.expiryEvidence = {
          taskStatus: done.status,
          decision: approval.decision,
          responseState: approval.response_state,
          remainingLocks: store.diagnostics().locks,
          originalCardUpdated: true,
        };
        delete report.waitingFor;
        throw new ProbeBlocked('Permission request expired before a phone decision');
      }
      assert.equal(done.status, 'completed');
      assert.equal(approval.decision, decision);
      assert.equal(approval.state, 'resolved');
      assert.equal(approval.response_state, 'sent');
      assert.equal(permissionResponses.length, responsesBefore + 1);
      const expectedResponse = {
        permissions: decision === 'network' ? { network: { enabled: true } } : {},
        scope: 'turn',
      };
      assert.deepEqual(permissionResponses.at(-1).response, expectedResponse);
      assert(
        store
          .result(id)
          .includes(
            decision === 'network' ? 'M4_PERMISSIONS_SUBSET_OK' : 'M4_PERMISSIONS_CANCELLED',
          ),
      );
      report.checks[`phonePermissions_${decision}`] = 'PASS';
      report.checks[`remoteCard_${decision}`] = 'PASS';
      report[`${decision}Evidence`] = {
        response: expectedResponse,
        taskStatus: done.status,
        originalTurn: true,
      };
      delete report.waitingFor;
      await checkpoint();
      log('permissions-verified', { decision });
    }
    assert.equal(store.diagnostics().locks, 0);
    assert.equal(
      report.callbacks.filter((e) => e.kind === 'action' && e.outcome === 'accepted').length,
      permissionDecisions.length,
    );
    assert.equal(
      db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
      permissionDecisions.length,
    );
    report.checks[
      permissionDecisions.length === 2 ? 'twoPhoneDecisionsTwoTurns' : 'onePhoneDecisionOneTurn'
    ] = 'PASS';
  } else {
    const ids = [];
    for (const decision of ['accept', 'decline']) {
      const prompt = `This is a harmless M4 ${decision} approval test. Request explicit command approval with sandbox_permissions="require_escalated" for exactly \`/usr/bin/printf M4_APPROVAL_PROBE\`, using the current directory as workdir. Use justification "M4 ${decision} 测试，仅打印固定文本". Do not read files or personal data. Do not use any other tool, do not retry after refusal. After the command result, including refusal, reply M4_${decision.toUpperCase()}_DONE and stop.`;
      const id = submit(decision, prompt);
      ids.push(id);
      await runtime.worker.dispatchNext();
      let row;
      while (
        !(row = db
          .prepare("SELECT * FROM approvals WHERE task_id=? AND state='pending' LIMIT 1")
          .get(id))
      ) {
        if (['completed', 'failed', 'interrupted', 'unknown'].includes(store.get(id).status))
          throw new ProbeBlocked('Model did not produce the requested approval');
        await tick();
      }
      while (
        !store.get(id).notification_message_id ||
        db
          .prepare(
            "SELECT 1 FROM outbox WHERE task_id=? AND state NOT IN ('delivered','superseded') LIMIT 1",
          )
          .get(id)
      )
        await tick();
      report.waitingFor = {
        decision,
        wireDecision:
          decision === 'accept'
            ? 'accept'
            : JSON.parse(row.payload).availableDecisions?.includes('decline')
              ? 'decline'
              : 'cancel',
        taskPrefix: id.slice(0, 8),
        approvalId: row.approval_id,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
      await checkpoint();
      log('phone-approval-ready', { ...report.waitingFor, report: join(artifacts, 'report.json') });
      const done = await terminal(id);
      if (decision === 'accept') assert.equal(done.status, 'completed');
      else assert(['completed', 'interrupted'].includes(done.status));
      const approval = db
        .prepare('SELECT * FROM approvals WHERE approval_id=?')
        .get(row.approval_id);
      assert.equal(approval.decision, report.waitingFor.wireDecision);
      assert.equal(approval.response_state, 'sent');
      const item = commandItems.get(done.turn_id);
      assert(item);
      if (decision === 'accept') {
        assert.equal(item.status, 'completed');
        assert.equal(item.exitCode, 0);
        assert.equal(item.output?.trim(), 'M4_APPROVAL_PROBE');
      } else {
        assert.equal(item.status, 'declined');
        assert(!item.output?.includes('M4_APPROVAL_PROBE'));
      }
      if (done.status === 'completed')
        assert(store.result(id).includes(`M4_${decision.toUpperCase()}_DONE`));
      await verifyCard(id);
      report.checks[`phoneApproval_${decision}`] = 'PASS';
      report.checks[`remoteCard_${decision}`] = 'PASS';
      report[`${decision}Evidence`] = {
        wireDecision: approval.decision,
        taskStatus: done.status,
        toolStatus: item.status,
        toolExecuted: decision === 'accept',
      };
      delete report.waitingFor;
      await checkpoint();
      log('approval-verified', { decision });
    }
    assert.equal(store.diagnostics().locks, 0);
    assert.equal(report.callbacks.filter((e) => e.outcome === 'accepted').length, 2);
    assert.equal(
      db.prepare("SELECT count(*) FROM rpc_operations WHERE method='turn/start'").pluck().get(),
      2,
    );
    report.checks.twoPhoneDecisionsTwoTurns = 'PASS';
  }
  report.status = 'PASS';
} catch (error) {
  report.status = error instanceof ProbeBlocked ? 'BLOCKED' : 'FAIL';
  report.error = {
    name: error.name,
    reason: error instanceof ProbeBlocked ? error.message : 'Inspect private diagnostic',
  };
  await writeFile(
    join(artifacts, 'error.private.json'),
    JSON.stringify({ message: error.message, stack: error.stack }, null, 2) + '\n',
    { mode: 0o600 },
  );
} finally {
  if (runtime?.worker.rpc.isReady && db?.open) {
    for (const task of runtime.store.list())
      if (task.status === 'running' && task.thread_id && task.turn_id) {
        try {
          await runtime.worker.rpc.request(
            'turn/interrupt',
            { threadId: task.thread_id, turnId: task.turn_id },
            z.object({}),
            5000,
          );
          report.cleanup.push({ requestedOwnedTurnInterrupt: true });
          const terminalDeadline = Date.now() + 5000;
          while (
            runtime.worker.rpc.isReady &&
            Date.now() < terminalDeadline &&
            ['starting', 'running'].includes(runtime.store.get(task.task_id).status)
          )
            await delay(50);
          report.cleanup.push({
            ownedTurnTerminalConfirmed: ['completed', 'failed', 'interrupted'].includes(
              runtime.store.get(task.task_id).status,
            ),
          });
        } catch {
          report.cleanup.push({ requestedOwnedTurnInterrupt: false });
        }
      }
  }
  runtime?.close();
  client?.close();
  if (db?.open) {
    report.finalState = new TaskStore(db).diagnostics();
    db.close();
  }
  if (server) {
    await server.diagnostics(join(artifacts, 'server.private.log'));
    report.cleanup.push(await server.stop());
  }
  await cleanupDirectory(directory);
  report.cleanup.push({ temporaryDirectoryRemoved: true });
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
log('finished', {
  status: report.status,
  report: join(artifacts, 'report.json'),
  error: report.error,
});
process.exitCode = report.status === 'PASS' ? 0 : 1;
