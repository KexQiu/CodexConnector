import { randomUUID } from 'node:crypto';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { setTimeout as delay } from 'node:timers/promises';
import type { GatewayConfig } from '../config/schema.js';
import { ProjectStore } from '../projects/store.js';
import { TaskWorker } from '../tasks/worker.js';
import type { TaskStore } from '../tasks/store.js';
import { TaskError } from '../tasks/types.js';
import { FeishuInbox } from './inbound.js';
import { FeishuCommands } from './commands.js';
import { FeishuSender } from './sender.js';
import { FeishuApi, FeishuApiError } from './api.js';
import { silentLogger, type FeishuCredentials } from './credentials.js';
import { RpcTransportError, RpcRejectedError } from '../codex/rpc-client.js';
import { NotifyInbox } from '../notify/inbox.js';
import { NotifyReceiver } from '../notify/receiver.js';

export class FeishuRuntime {
  readonly inbox: FeishuInbox;
  readonly api: FeishuApi;
  readonly sender: FeishuSender;
  worker: TaskWorker;
  private commands: FeishuCommands;
  private ws: WSClient | undefined;
  private lease: string | undefined;
  private nextReconnect = 0;
  private reconnectAttempts = 0;
  private nextReconcile = 0;
  private closing = false;
  private notifyReceiver: NotifyReceiver | undefined;
  private notifyError: string | null = null;
  connected = false;
  constructor(
    readonly store: TaskStore,
    readonly config: GatewayConfig,
    readonly credentials: FeishuCredentials,
    private readonly options: { prefix?: string; api?: FeishuApi; rpcAllowed?: () => boolean } = {},
  ) {
    this.worker = new TaskWorker(store, config);
    this.api = options.api ?? new FeishuApi(credentials);
    this.inbox = new FeishuInbox(store, credentials, options.prefix);
    this.sender = new FeishuSender(store, credentials, this.api, config.projects);
    this.commands = new FeishuCommands(
      this.inbox,
      config,
      new ProjectStore(config.projects, this.worker.rpc),
      this.worker,
    );
  }
  status() {
    const rpcReady =
      this.worker.rpc.isReady && (this.options.rpcAllowed?.() ?? true) && !this.closing;
    return {
      rpcReady,
      feishuConnected: this.connected && !this.closing,
      ready: rpcReady && this.connected && !this.closing,
      ...(this.config.notify
        ? {
            notify: {
              enabled: true,
              ...this.notifyReceiver?.status(),
              listening: !this.closing && (this.notifyReceiver?.status().listening ?? false),
              startupError: this.notifyError,
            },
          }
        : {}),
    };
  }
  async start() {
    this.lease = this.store.db
      .transaction(() => {
        const pid = this.store.db
          .prepare('SELECT pid FROM feishu_runtime_lease WHERE singleton = 1')
          .pluck()
          .get();
        if (typeof pid === 'number') {
          try {
            process.kill(pid, 0);
            throw new TaskError('飞书 Gateway 已在运行');
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
              throw new TaskError('已有 Gateway 或无法确认旧进程已退出');
          }
        }
        const token = randomUUID();
        this.store.db
          .prepare('INSERT OR REPLACE INTO feishu_runtime_lease VALUES (1,?,?)')
          .run(process.pid, token);
        return token;
      })
      .immediate();
    try {
      if (this.config.notify) {
        try {
          this.notifyReceiver = new NotifyReceiver(
            this.config.notify,
            new NotifyInbox(this.store, this.config, this.credentials),
          );
          await this.notifyReceiver.start();
        } catch {
          // GUI notifications may fail without disabling the existing RPC/Feishu service.
          this.notifyReceiver?.close();
          this.notifyReceiver = undefined;
          this.notifyError = 'notify-start-failed';
        }
      }
      // Do not accept model work if the receipt-reconciliation prerequisite is unavailable.
      try {
        await this.api.history(this.credentials.testChatId, Date.now() - 60_000);
      } catch (error) {
        if (error instanceof FeishuApiError && error.apiCode === 99991672)
          throw new TaskError(
            '缺少飞书会话历史读取权限（99991672），请开通 im:message.history:readonly 并发布生效',
          );
        throw error;
      }
      try {
        if (this.options.rpcAllowed?.() ?? true) await this.worker.start();
      } catch (error) {
        if (!(error instanceof RpcTransportError) && !(error instanceof RpcRejectedError))
          throw error;
        /* Feishu read-only diagnostics remain available while RPC is offline. */
      }
      if (this.closing) throw new TaskError('Gateway 已停止');
      this.ws = new WSClient({
        appId: this.credentials.appId,
        appSecret: this.credentials.appSecret,
        logger: silentLogger,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        onReady: () => {
          this.connected = true;
        },
        onReconnected: () => {
          this.connected = true;
        },
        onReconnecting: () => {
          this.connected = false;
        },
        onError: () => {
          this.connected = false;
        },
      });
      await this.ws.start({ eventDispatcher: this.inbox.dispatcher() });
      const deadline = Date.now() + 45_000;
      while (!this.connected && !this.closing && Date.now() < deadline) await delay(100);
      if (!this.connected) throw new TaskError('飞书长连接未就绪');
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async tick() {
    if (this.closing) return;
    this.notifyReceiver?.drain();
    const rpcAllowed = this.options.rpcAllowed?.() ?? true;
    if (!rpcAllowed && this.worker.rpc.isReady) this.worker.close();
    if (rpcAllowed && !this.worker.rpc.isReady && Date.now() >= this.nextReconnect) {
      this.nextReconnect =
        Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 6));
      this.worker.close();
      this.worker = new TaskWorker(this.store, this.config);
      this.commands = new FeishuCommands(
        this.inbox,
        this.config,
        new ProjectStore(this.config.projects, this.worker.rpc),
        this.worker,
      );
      try {
        await this.worker.start();
        this.reconnectAttempts = 0;
      } catch (error) {
        if (!(error instanceof RpcTransportError) && !(error instanceof RpcRejectedError))
          throw error;
        /* Durable tasks remain queued or unknown. */
      }
    }
    if (this.closing) return;
    if (this.status().rpcReady) this.worker.pollMetrics();
    await this.commands.processNext();
    if (this.status().rpcReady && !this.closing) {
      try {
        await this.worker.tickInteractions();
        if (this.worker.rpc.isReady && !this.closing && Date.now() >= this.nextReconcile) {
          this.nextReconcile = Date.now() + 30_000;
          await this.worker.recover();
        }
        if (this.status().rpcReady && !this.closing) await this.worker.dispatchNext();
      } catch (error) {
        if (!(error instanceof RpcTransportError)) throw error;
        // RPC may disconnect during an awaited write; Feishu delivery remains independent.
      }
    }
    if (!this.closing) await this.sender.reconcileOne();
    if (!this.closing) this.commands.panel.sync();
    if (!this.closing) await this.sender.flushOne();
  }
  close() {
    this.closing = true;
    this.connected = false;
    this.ws?.close({ force: true });
    this.notifyReceiver?.close();
    this.worker.close();
    if (this.lease) {
      this.store.db.prepare('DELETE FROM feishu_runtime_lease WHERE token = ?').run(this.lease);
      this.lease = undefined;
    }
  }
}
