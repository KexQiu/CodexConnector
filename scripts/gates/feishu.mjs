import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import {
  attachFeishuProbe,
  digest,
  FeishuProbeStore,
  loadFeishuCredentials,
  silentLogger,
  testCard,
} from './feishu-support.mjs';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'config/feishu.local.json' },
    connect: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    'retry-message': { type: 'boolean', default: false },
    timeout: { type: 'string', default: '600' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(
    'pnpm gate:feishu [--config PATH] [--connect | --live | --retry-message] [--timeout 600]\n默认只校验本机配置。--connect 只验证长连接；--live 需人工发消息/点卡片；--retry-message 仅接收一条测试消息并故意首次写库失败，观察平台自动重投。',
  );
  process.exit(0);
}
const timeout = Number(values.timeout);
if (
  !Number.isInteger(timeout) ||
  timeout < 30 ||
  timeout > 1800 ||
  [values.live, values.connect, values['retry-message']].filter(Boolean).length > 1
) {
  console.error('Invalid options: timeout must be 30..1800 seconds; select only one network mode');
  process.exit(1);
}
let credentials;
try {
  credentials = loadFeishuCredentials(resolve(values.config));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const require = createRequire(import.meta.url);
const sdkPath = require.resolve('@larksuiteoapi/node-sdk');
const sdkVersion = JSON.parse(
  readFileSync(resolve(dirname(sdkPath), '../package.json'), 'utf8'),
).version;
if (sdkVersion !== '1.74.0') {
  console.error('SDK version drift; expected 1.74.0');
  process.exit(1);
}
if (!values.live && !values.connect && !values['retry-message']) {
  console.log(
    JSON.stringify({ config: 'VALID', sdk: sdkVersion, network: 'NOT_RUN', gate: 'NOT_RUN' }),
  );
  process.exit(0);
}

process.umask(0o077);
const runId = randomUUID();
const directory = resolve(
  '.artifacts/g1',
  `${new Date().toISOString().replaceAll(':', '-')}-${runId.slice(0, 8)}`,
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const report = {
  runId,
  startedAt: new Date().toISOString(),
  sdk: sdkVersion,
  sdkSha256: digest(readFileSync(sdkPath)),
  mode: values.live ? 'live' : values['retry-message'] ? 'retry-message' : 'connect',
  status: 'RUNNING',
  checks: {},
  samples: [],
  limitations: [
    'SDK ACK observation is a send attempt, not proof of remote receipt.',
    'Forced disconnect affects only the owned test socket; this is not an OS network outage.',
    'Unauthorized identities and tampered callbacks are tested locally, not with another real account.',
    'This probe has no Codex/task execution; its isolated database is not the M2 production inbox.',
  ],
};
const journal = resolve(directory, 'events.jsonl');
const checkpoint = () =>
  writeFileSync(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
function log(type, details = {}) {
  const event = { at: new Date().toISOString(), type, ...details };
  appendFileSync(journal, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(event));
}
const database = openGatewayDatabase(resolve(directory, 'probe.sqlite'));
const store = new FeishuProbeStore(database, credentials, runId);
const acks = [];
let ws;
let stopped = false;
let connected = false;
let reconnects = 0;
let connectionFailed = false;
let token;
const deadline = Date.now() + timeout * 1000;
const stop = () => {
  stopped = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

class GateError extends Error {
  constructor(message, status = 'BLOCKED') {
    super(message);
    this.status = status;
  }
}
async function waitFor(predicate, label, limit = deadline) {
  while (!predicate()) {
    if (stopped) throw new GateError('Interrupted');
    if (connectionFailed) throw new GateError('Feishu connection failed');
    if (Date.now() >= Math.min(limit, deadline)) throw new GateError(`Timed out: ${label}`);
    await delay(200);
  }
}
async function api(path, method = 'GET', data, authenticate = true) {
  let response;
  try {
    response = await fetch(`https://open.feishu.cn/open-apis/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authenticate ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    throw new GateError('Feishu request transport failed; mutation outcome may be unknown');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new GateError('Invalid Feishu response; mutation outcome may be unknown');
  }
  if (!response.ok || result.code !== 0) {
    const code = Number.isSafeInteger(result.code) ? result.code : 'unknown';
    throw new GateError(`Feishu rejected request: HTTP ${response.status}, code ${code}`);
  }
  return result;
}
async function sendMessage(kind, content) {
  // Persist before POST. No automatic retries after ambiguous network outcomes.
  const uuid = randomUUID();
  database.prepare('INSERT INTO g1_outbound VALUES (?, ?, ?, NULL)').run(uuid, kind, 'intent');
  let result;
  try {
    result = await api('im/v1/messages?receive_id_type=chat_id', 'POST', {
      receive_id: credentials.testChatId,
      msg_type: kind === 'card' ? 'interactive' : 'text',
      content: JSON.stringify(content),
      uuid,
    });
  } catch (error) {
    database.prepare('UPDATE g1_outbound SET state = ? WHERE uuid = ?').run('unresolved', uuid);
    throw error;
  }
  const id = result.data?.message_id;
  if (typeof id !== 'string' || !id.startsWith('om_'))
    throw new GateError('Missing send receipt; do not resend blindly');
  database
    .prepare('UPDATE g1_outbound SET state = ?, message_id = ? WHERE uuid = ?')
    .run('sent', id, uuid);
  log('message-sent', { kind, messageIdHash: digest(id) });
  return id;
}
const seen = (commandKind, outcome = 'accepted') =>
  acks.some(
    (a) => a.commandKind === commandKind && a.outcome === outcome && a.ackCode === 200 && a.durable,
  );

try {
  checkpoint();
  log('probe-start', { directory, challenge: store.challenge });
  ws = new WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    logger: silentLogger,
    autoReconnect: true,
    handshakeTimeoutMs: 15_000,
    onReady: () => {
      connected = true;
      log('connected');
    },
    onError: () => {
      connectionFailed = true;
      log('connection-failed');
    },
    onReconnecting: () => {
      connected = false;
      log('reconnecting');
    },
    onReconnected: () => {
      connected = true;
      reconnects += 1;
      log('reconnected');
    },
  });
  const dispatcher = attachFeishuProbe(ws, store, (record) => {
    if (acks.length >= 1000) {
      stopped = true;
      return;
    }
    acks.push(record);
    if (record.sample && report.samples.length < 12) report.samples.push(record.sample);
    log('ack', record);
  });
  await ws.start({ eventDispatcher: dispatcher });
  await waitFor(() => connected, 'initial connection', Date.now() + 45_000);
  report.checks.connection = 'PASS';
  checkpoint();
  if (values['retry-message']) {
    log('user-action-required', {
      instruction:
        '请在配置的机器人单聊中只发送一次以下文本。首次写库会故意失败；之后不要手动重发，等待平台自动重投。',
      text: `${store.challenge} retry`,
    });
    await waitFor(
      () => acks.some((a) => a.ackCode === 500 && !a.durable),
      'first message write failure',
    );
    report.checks.messageStorageFailureAck500 = 'PASS';
    checkpoint();
    await waitFor(() => {
      const failed = new Set(acks.filter((a) => a.ackCode === 500).map((a) => a.key));
      return acks.some((a) => a.ackCode === 200 && a.durable && failed.has(a.key));
    }, 'automatic same-event redelivery');
    report.checks.platformRedeliverySameMessageEvent = 'PASS';
    report.status = 'PASS';
    report.limitations.push(
      'Retry-only PASS covers inbound message events, not card callback retries or the full G1 gate.',
    );
  } else if (values.live) {
    log('user-action-required', {
      instruction: '请在配置的机器人单聊中发送以下文本',
      text: store.challenge,
    });
    await waitFor(() => seen('message'), 'allowlisted test message');
    report.checks.inboundIdentityAndPersistence = 'PASS';
    const auth = await api(
      'auth/v3/tenant_access_token/internal',
      'POST',
      {
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      },
      false,
    );
    token = auth.tenant_access_token;
    if (typeof token !== 'string' || !token) throw new GateError('Missing access token');
    await sendMessage('text', {
      text: 'G1 已收到你的测试消息。接下来会发送一张联调卡片，请按卡片说明点击按钮。此次测试不执行 Codex 任务。',
    });
    report.checks.sendText = 'PASS';
    const actions = [
      { label: '确认（点两次）', value: store.issueAction('confirm') },
      { label: '过期按钮', value: store.issueAction('expired', Date.now() - 1000) },
      { label: '存储失败', value: store.issueAction('storage-failure') },
    ];
    const cardId = await sendMessage('card', testCard(runId, actions));
    store.bindCard(cardId);
    report.checks.sendCardV2 = 'PASS';
    checkpoint();
    log('user-action-required', {
      instruction: '请按卡片说明：确认点两次，过期按钮点一次，存储失败首次报错后稍后再点一次。',
    });
    await waitFor(
      () =>
        seen('confirm') &&
        seen('confirm', 'duplicate-command') &&
        acks.some((a) => a.outcome === 'expired' && a.ackCode === 200 && a.durable) &&
        acks.some((a) => a.ackCode === 500 && !a.durable) &&
        seen('storage-failure'),
      'card actions',
    );
    report.checks.cardCallbackAndResponse = 'PASS';
    report.checks.nonceDeduplication = 'PASS';
    report.checks.expiredButton = 'PASS';
    report.checks.storageFailureAck500AndRecovery = 'PASS';
    checkpoint();

    const socket = ws.wsConfig?.getWSInstance?.();
    if (!socket || typeof socket.terminate !== 'function')
      throw new GateError('Cannot isolate owned SDK socket');
    log('force-owned-socket-disconnect');
    socket.terminate();
    await waitFor(() => connected && reconnects > 0, 'SDK reconnect', Date.now() + 180_000);
    await sendMessage('text', {
      text: `G1 长连接已恢复。请在此单聊发送：${store.challenge} reconnect`,
    });
    log('user-action-required', {
      instruction: '请在同一单聊发送以下文本验证重连后的接收',
      text: `${store.challenge} reconnect`,
    });
    await waitFor(() => seen('reconnect-message'), 'message after reconnect');
    report.checks.reconnectAndReceive = 'PASS';
    await api(`im/v1/messages/${encodeURIComponent(cardId)}`, 'PATCH', {
      content: JSON.stringify(testCard(runId, [], true)),
    });
    report.checks.updateSameCard = 'PASS';
    const failures = new Set(acks.filter((a) => a.ackCode === 500).map((a) => a.key));
    report.checks.platformRedeliverySameEvent = acks.some(
      (a) => a.durable && a.ackCode === 200 && failures.has(a.key),
    )
      ? 'PASS'
      : 'NOT_OBSERVED';
    // A manual second click is NOT proof of the platform retrying a failed event.
    report.status = report.checks.platformRedeliverySameEvent === 'PASS' ? 'PASS' : 'PARTIAL';
  } else {
    report.status = 'PASS';
    report.limitations.push('Connection-only PASS is not a G1 gate PASS.');
  }
} catch (error) {
  report.status = error instanceof GateError ? error.status : 'FAIL';
  report.reason =
    error instanceof GateError
      ? error.message
      : 'Unexpected local probe failure; no raw error logged';
  log('stopped', { status: report.status, reason: report.reason });
} finally {
  ws?.close({ force: true });
  const timings = acks
    .filter((a) => a.ackCode === 200 && a.durable)
    .map((a) => a.elapsedMs)
    .sort((a, b) => a - b);
  report.ack = {
    count: acks.length,
    successfulDurableCount: timings.length,
    p95Ms: timings.length ? timings[Math.ceil(timings.length * 0.95) - 1] : null,
    boundary: 'sdk-send-attempt',
  };
  report.counts = store.counts();
  report.finishedAt = new Date().toISOString();
  report.cleanup = { ownedConnectionClosed: true, databaseClosed: true };
  database.close();
  checkpoint();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  console.log(
    JSON.stringify({
      status: report.status,
      mode: report.mode,
      report: resolve(directory, 'report.json'),
      checks: report.checks,
      ack: report.ack,
    }),
  );
}
process.exit(report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2);
