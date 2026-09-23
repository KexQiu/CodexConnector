import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../../src/config/schema.ts';
import { privateDirectory, readPrivate, writeJson } from '../../src/service/files.ts';
import { gatewayCredentials } from '../../src/feishu/credentials.ts';
import { openGatewayDatabase } from '../../src/persistence/database.ts';
import { TaskStore } from '../../src/tasks/store.ts';
import { NotifyInbox } from '../../src/notify/inbox.ts';
import { NotifyReceiver } from '../../src/notify/receiver.ts';
import { notifyEventSchema } from '../../src/notify/event.ts';
import { FeishuApi } from '../../src/feishu/api.ts';
import { FeishuSender } from '../../src/feishu/sender.ts';
import { notifySetting } from './notify.mjs';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    config: { type: 'string' },
    directory: { type: 'string' },
    'capture-file': { type: 'string' },
    'gui-confirmed': { type: 'boolean' },
    timeout: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (
  values.help ||
  !values.live ||
  !values.config ||
  !values.directory ||
  !values['capture-file'] ||
  !values['gui-confirmed']
) {
  console.log(
    'pnpm gate:notify:live --live --config /private/gateway.proposed.json --directory /private/notify-plan --capture-file /private/captures/actual.json --gui-confirmed [--timeout 1200]\n仅在人工确认该捕获来自真实 GUI 专用任务后运行。临时使用隔离数据库、loopback 接收及既有专用单聊，不连接飞书 WebSocket、不启动 worker、不改 M5。',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const timeout = Number(values.timeout ?? 1200);
if (!Number.isSafeInteger(timeout) || timeout < 30 || timeout > 7200)
  throw new Error('timeout 需要 30–7200 秒');
const directory = resolve(values.directory);
const plan = JSON.parse(readPrivate(join(directory, 'plan.json')));
const captured = JSON.parse(readPrivate(values['capture-file']));
const observed = notifyEventSchema.parse(JSON.parse(captured.argv?.[0]));
if (
  captured.argv.length !== 1 ||
  captured.originalExitCode !== 0 ||
  JSON.stringify(captured.original) !== JSON.stringify(plan.originalCommand) ||
  !/^(M6_GUI_|M6GUI)[A-F0-9]{8}$/.test(
    observed['last-assistant-message'].replaceAll('\\_', '_').trim(),
  )
)
  throw new Error('需要成功完成、原通知正常、身份明确且最终标记一致的专用 GUI 捕获');
if (
  JSON.stringify(notifySetting(readPrivate(plan.configPath)).command) !==
  JSON.stringify(plan.wrapper)
)
  throw new Error('计划 wrapper 不在当前 notify 配置中，请先核对配置');
// The captured version is frozen. It must contain the test-scope guard before live forwarding.
if (!readPrivate(join(directory, 'notify-bridge.mjs')).includes('settings.testMarker'))
  throw new Error('该旧捕获计划缺少精确测试标记过滤；请恢复后用当前版本重新 prepare/install');
const base = await loadConfig(values.config);
if (!base.notify) throw new Error('需要 staged notify 配置');
const id = randomUUID(),
  root = join(directory, `live-${id}`);
privateDirectory(root);
const marker = `M6NOTIFY${id.slice(0, 8).toUpperCase()}`;
const tokenFile = join(root, 'token');
writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const config = {
  ...base,
  dataDir: root,
  notify: { ...base.notify, tokenFile, spoolDir: join(root, 'spool') },
};
const credentials = gatewayCredentials(config);
const db = openGatewayDatabase(join(root, 'gateway.sqlite'));
const store = new TaskStore(db);
const receiver = new NotifyReceiver(config.notify, new NotifyInbox(store, config, credentials));
const api = new FeishuApi(credentials),
  sender = new FeishuSender(store, credentials, api);
const settingsPath = plan.settingsPath,
  priorSettings = readPrivate(settingsPath);
const activeSettings =
  JSON.stringify(
    {
      version: 1,
      mode: 'forward',
      allowedRoots: [plan.allowedRoot],
      testMarker: marker,
      port: config.notify.port,
      tokenFile,
      spoolDir: config.notify.spoolDir,
      verifiedEvents: ['agent-turn-complete'],
    },
    null,
    2,
  ) + '\n';
let stop = false,
  installed = false;
const cancel = () => {
  stop = true;
};
const report = {
  gate: 'G3',
  status: 'IN_PROGRESS',
  startedAt: new Date().toISOString(),
  scope: 'isolated-GUI-completion-to-Feishu',
  sourceCapture: values['capture-file'],
  observedThread: observed['thread-id'],
  observedTurn: observed['turn-id'],
  guiOrigin: 'USER_CONFIRMED',
  marker,
  root,
  M5Unchanged: true,
};
try {
  await api.history(credentials.testChatId, Date.now() - 60_000);
  await receiver.start();
  if (readPrivate(settingsPath) !== priorSettings) throw new Error('bridge 设置并发变化');
  writeJson(settingsPath, JSON.parse(activeSettings));
  installed = true;
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  writeJson(join(root, 'report.json'), report);
  console.log(
    JSON.stringify({
      status: 'READY',
      marker,
      instruction: `在同一项目中新建桌面任务：不使用工具、不读取文件、不联网。只回复 ${marker}。`,
      report: join(root, 'report.json'),
    }),
  );
  const deadline = Date.now() + timeout * 1000;
  while (!stop && Date.now() < deadline) {
    receiver.drain();
    await sender.reconcileOne();
    await sender.flushOne();
    const row = db
      .prepare(
        "SELECT inbox_id,thread_id,turn_id,event_key FROM inbox WHERE source='gui-notify' ORDER BY created_at LIMIT 1",
      )
      .get();
    if (row) {
      const receipt = db
        .prepare('SELECT outbox_id,state,message_id FROM outbox WHERE logical_key=?')
        .get(row.event_key);
      if (receipt?.state === 'delivered') {
        Object.assign(report, {
          status: 'PASS_COMPLETION_DELIVERY_API',
          threadId: row.thread_id,
          turnId: row.turn_id,
          receipt,
          userVisibleReceipt: 'PENDING_USER_CONFIRMATION',
          originalForwarding: 'VERIFIED_IN_SOURCE_CAPTURE',
          duplicateCounts: {
            inbox: db.prepare("SELECT count(*) FROM inbox WHERE source='gui-notify'").pluck().get(),
            outbox: db.prepare('SELECT count(*) FROM outbox').pluck().get(),
          },
        });
        break;
      }
      if (receipt?.state === 'failed') {
        report.status = 'FAIL_DELIVERY';
        break;
      }
    }
    await delay(500);
  }
  if (report.status === 'IN_PROGRESS') report.status = stop ? 'CANCELLED' : 'TIMED_OUT';
} catch (error) {
  report.status = 'FAIL';
  report.errorType = error.name;
} finally {
  receiver.close();
  report.noModelExecution = ['tasks', 'rpc_operations', 'execution_locks'].every(
    (name) => db.prepare(`SELECT count(*) FROM ${name}`).pluck().get() === 0,
  );
  report.outbox = db.prepare('SELECT state,count(*) AS count FROM outbox GROUP BY state').all();
  report.remainingSpool = readdirSync(config.notify.spoolDir).filter((n) =>
    n.endsWith('.json'),
  ).length;
  report.finishedAt = new Date().toISOString();
  if (installed && readPrivate(settingsPath) === activeSettings) {
    writeJson(settingsPath, JSON.parse(priorSettings));
    report.bridgeSettingsRestored = true;
  } else report.bridgeSettingsRestored = !installed;
  writeJson(join(root, 'report.json'), report);
  db.close();
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
console.log(
  JSON.stringify({
    status: report.status,
    report: join(root, 'report.json'),
    guiRollbackStillRequired: true,
  }),
);
process.exitCode = report.status === 'PASS_COMPLETION_DELIVERY_API' ? 0 : 1;
