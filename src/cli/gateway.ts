import { mkdirSync, lstatSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { GatewayConfig } from '../config/schema.js';
import { runtimePaths } from '../config/schema.js';
import { openGatewayDatabase } from '../persistence/database.js';
import { TaskStore } from '../tasks/store.js';
import { TaskError } from '../tasks/types.js';
import { gatewayCredentials, type FeishuCredentials } from '../feishu/credentials.js';
import { FeishuRuntime } from '../feishu/runtime.js';
import { FeishuApi } from '../feishu/api.js';
import { FeishuInbox } from '../feishu/inbound.js';

export async function runGatewayCli(
  config: GatewayConfig,
  options: {
    timeout?: string | undefined;
    'message-id'?: string | undefined;
    observe?: (state: { rpcReady: boolean; feishuConnected: boolean; ready: boolean }) => void;
    rpcAllowed?: () => boolean;
    signal?: AbortSignal;
    credentials?: FeishuCredentials;
    interruptOnStop?: boolean;
  },
  recover = false,
) {
  process.umask(0o077);
  const credentials = gatewayCredentials(config, options.credentials);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(config.dataDir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new TaskError('dataDir 必须是当前用户私有目录（700）');
  const db = openGatewayDatabase(runtimePaths(config.dataDir).database);
  let runtime: FeishuRuntime | undefined;
  let stopped = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const stop = () => {
    stopped = true;
    if (options.interruptOnStop) runtime?.beginShutdown();
    else runtime?.close();
  };
  try {
    const store = new TaskStore(db);
    if (recover) {
      const id = options['message-id'];
      if (!id || !/^om_[a-zA-Z0-9]+$/.test(id)) throw new TaskError('需要有效的 --message-id');
      const inbox = new FeishuInbox(store, credentials);
      const result = inbox.recoverMessage(await new FeishuApi(credentials).get(id));
      // Existing failed work becomes eligible; a processed command remains processed.
      db.prepare(
        "UPDATE feishu_commands SET attempts = 0, next_retry_at = 0 WHERE state = 'failed' AND command_id = ?",
      ).run('commandId' in result ? result.commandId : '');
      process.stdout.write(
        JSON.stringify({
          status: result.outcome,
          scope: 'inbox-only',
          next: '运行 gateway 处理已持久化的命令',
        }) + '\n',
      );
      return 0;
    }
    const timeout = Number(options.timeout ?? 0);
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 86400)
      throw new TaskError('timeout 必须为 0–86400 秒，0 表示前台持续运行');
    runtime = new FeishuRuntime(
      store,
      config,
      credentials,
      options.rpcAllowed ? { rpcAllowed: options.rpcAllowed } : {},
    );
    const observe = () => {
      if (runtime) options.observe?.(runtime.status());
    };
    observe();
    heartbeat = setInterval(observe, 2000);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) {
      stop();
      return 0;
    }
    await runtime.start();
    process.stdout.write(
      JSON.stringify({
        status: runtime.status().ready ? 'ready' : 'degraded',
        mode: 'foreground',
        ...runtime.status(),
      }) + '\n',
    );
    const deadline = timeout ? Date.now() + timeout * 1000 : Infinity;
    while (!stopped && Date.now() < deadline) {
      await runtime.tick();
      await delay(500);
    }
    return 0;
  } finally {
    if (options.interruptOnStop && runtime) await runtime.shutdown();
    runtime?.close();
    if (heartbeat) clearInterval(heartbeat);
    options.observe?.({
      ...runtime?.status(),
      ready: false,
      rpcReady: false,
      feishuConnected: false,
    });
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    db.close();
  }
}
