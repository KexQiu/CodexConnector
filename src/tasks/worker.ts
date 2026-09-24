import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import { CodexRpcClient, RpcRejectedError, RpcTransportError } from '../codex/rpc-client.js';
import { threadResultSchema, turnResultSchema, turnsPageSchema } from '../codex/schemas.js';
import { isTerminal, type OwnerIdentity } from '../domain/model.js';
import { canonicalDirectory, executableProject, checkoutRoot } from '../projects/store.js';
import { assertThreadPolicy, executionPolicy } from './project-policy.js';
import { OutboxStore } from './outbox.js';
import { ownerKey, type TaskStore } from './store.js';
import { durableTurnSchema, TaskError, type StoredTask } from './types.js';
import { Interactions } from './interactions.js';
import { TaskControls } from './controls.js';
import { MetricsPoller, StatusMetrics } from './status-metrics.js';

export function configuredOwner(config: GatewayConfig): OwnerIdentity {
  return {
    tenantKey: config.feishu.tenantKey,
    appId: config.feishu.appId,
    openId: config.feishu.allowedOpenId,
  };
}

/** Connects to an independently owned server; never spawns or terminates that server. */
export class TaskWorker {
  readonly rpc: CodexRpcClient;
  private lease: string | undefined;
  private activeOperation: { id: string; method: string } | undefined;
  private fatal = false;
  private stopping = false;
  private dispatching = false;
  private readonly subscribedThreads = new Set<string>();
  readonly owner: string;
  readonly interactions: Interactions;
  readonly controls: TaskControls;
  readonly metrics: StatusMetrics;
  readonly metricsPoller: MetricsPoller;
  private metricsReading: Promise<void> | undefined;

  constructor(
    readonly store: TaskStore,
    private readonly config: GatewayConfig,
  ) {
    this.owner = ownerKey(configuredOwner(config));
    this.metrics = new StatusMetrics(store, this.owner);
    this.rpc = new CodexRpcClient({
      endpoint: config.codex.endpoint,
      beforeRequest: (request) => {
        if (this.activeOperation?.method === request.method)
          this.store.beforeWire(this.activeOperation.id, request.connectionEpoch, request.id);
      },
      onNotification: (notification) => {
        if (notification.method === 'account/updated') this.metricsPoller.invalidateAccount();
        if (notification.method === 'account/rateLimits/updated') this.metricsPoller.request();
        this.metrics.notification(notification);
        if (notification.method === 'thread/closed') {
          const closed = z.object({ threadId: z.string() }).safeParse(notification.params);
          if (closed.success) this.subscribedThreads.delete(closed.data.threadId);
        }
        this.store.recordEvent(notification);
        this.interactions.notification(notification);
      },
      onServerRequest: (request) => this.interactions.receive(request),
      onDisconnect: () => {
        this.subscribedThreads.clear();
        try {
          this.interactions.disconnect();
          this.controls.recover();
          for (const task of this.store.list(this.owner))
            if (['starting', 'running'].includes(task.status))
              this.store.unknown(task.task_id, 'rpc_disconnected');
        } catch {
          this.fatal = true;
        }
      },
    });
    this.interactions = new Interactions(store, config, this.rpc, this.owner);
    this.controls = new TaskControls(store, this.owner);
    this.metricsPoller = new MetricsPoller(this.metrics, this.rpc, config.projects);
  }

  async start() {
    this.lease = this.store.acquireWorker();
    try {
      this.store.recoverLocal(this.rpc.connectionEpoch);
      new OutboxStore(this.store.db).recoverExpired();
      const initialized = await this.rpc.connect();
      this.metricsPoller.codexHome = initialized.codexHome;
      await this.recover();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    this.metricsPoller.close();
    this.rpc.close();
    if (this.lease) {
      this.store.releaseWorker(this.lease);
      this.lease = undefined;
    }
  }
  private metricsTarget(taskId?: string, projectKey?: string) {
    if (projectKey) return { threadId: null, projectKey };
    const context = this.store.db
      .prepare('SELECT project_key,task_id FROM user_context WHERE owner_key=?')
      .get(this.owner);
    const selected = z
      .object({ project_key: z.string(), task_id: z.string().nullable() })
      .optional()
      .parse(context);
    const id = taskId ?? selected?.task_id;
    const task = id ? this.store.get(id) : null;
    if (task && task.owner_key !== this.owner) throw new TaskError('会话无权限');
    return {
      threadId: task?.thread_id ?? null,
      projectKey: task?.project_key ?? selected?.project_key,
    };
  }
  async refreshMetrics(taskId?: string, projectKey?: string) {
    const target = this.metricsTarget(taskId, projectKey);
    await this.metricsPoller.refreshSession(target.threadId, target.projectKey);
  }
  async refreshQuota() {
    await this.metricsPoller.refreshAccount();
  }
  pollMetrics() {
    if (this.metricsReading) return;
    const target = this.metricsTarget();
    this.metricsReading = this.metricsPoller
      .poll(target.threadId, Date.now(), target.projectKey)
      .catch(() => {
        /* Optional display reads must not disable task execution. */
      })
      .finally(() => {
        this.metricsReading = undefined;
      });
  }
  private ensureReady() {
    if (!this.lease || !this.rpc.isReady || this.fatal)
      throw new TaskError('worker 未就绪，停止派发');
  }
  private policy(task: StoredTask) {
    return executionPolicy(
      executableProject(this.config.projects, task.project_key, task.cwd),
      task.cwd,
    );
  }
  private async verifyProjectTools(task: StoredTask) {
    if (!executableProject(this.config.projects, task.project_key, task.cwd).remotePermissions)
      return;
    // MCP tools run outside the command sandbox. Inspect the project layer as well
    // as the service defaults; a newly introduced server must not bypass local caps.
    const effective = await this.rpc.request(
      'config/read',
      { cwd: task.cwd, includeLayers: false },
      z.object({
        config: z.object({
          mcp_servers: z
            .record(z.string(), z.object({ enabled: z.boolean().optional() }))
            .default({}),
        }),
      }),
    );
    if (Object.values(effective.config.mcp_servers).some((server) => server.enabled !== false))
      throw new TaskError('项目存在未隔离的 MCP 工具');
  }
  private async mutating<T>(
    operationId: string,
    method: 'thread/start' | 'thread/resume' | 'turn/start' | 'turn/steer' | 'turn/interrupt',
    call: () => Promise<T>,
  ): Promise<T> {
    if (this.activeOperation) throw new TaskError('不允许并发 RPC 提交');
    this.activeOperation = { id: operationId, method };
    try {
      return await call();
    } finally {
      this.activeOperation = undefined;
    }
  }

  async dispatchNext(): Promise<StoredTask | null> {
    if (this.stopping || this.dispatching || this.activeOperation) return null;
    this.ensureReady();
    this.dispatching = true;
    try {
      return await this.dispatchQueued();
    } finally {
      this.dispatching = false;
    }
  }
  private async dispatchQueued(): Promise<StoredTask | null> {
    const queued = this.store
      .list(this.owner)
      .filter((entry) => entry.status === 'queued')
      .sort((a, b) => a.created_at - b.created_at || a.task_id.localeCompare(b.task_id));
    let selected: { task: StoredTask; operation: string } | undefined;
    for (const task of queued) {
      let root: string;
      try {
        executableProject(this.config.projects, task.project_key, task.cwd);
        root = checkoutRoot(task.cwd);
      } catch {
        this.store.fail(task.task_id, 'thread_start', 'project_not_writable');
        return this.store.get(task.task_id);
      }
      const operation = this.store.claim(task.task_id, this.rpc.connectionEpoch, {
        maxConcurrentTasks: this.config.maxConcurrentTasks,
        checkoutRoot: root,
      });
      if (operation) {
        selected = { task, operation };
        break;
      }
    }
    if (!selected) return null;
    const { task } = selected;
    let { operation } = selected;
    let phase: 'thread_start' | 'turn_start' = 'thread_start';
    try {
      try {
        await this.verifyProjectTools(task);
      } catch {
        this.store.settleOperation(operation, 'not_sent');
        this.store.fail(task.task_id, 'thread_start', 'project_tools_not_isolated');
        return this.store.get(task.task_id);
      }
      if (task.thread_id) this.store.ownedThread(task.thread_id, this.owner);
      const response = task.thread_id
        ? await this.mutating(operation, 'thread/resume', () =>
            this.rpc.request(
              'thread/resume',
              { ...this.policy(task).thread, threadId: task.thread_id ?? '', excludeTurns: true },
              threadResultSchema,
              45_000,
            ),
          )
        : await this.mutating(operation, 'thread/start', () =>
            this.rpc.request(
              'thread/start',
              { ...this.policy(task).thread, historyMode: 'legacy', ephemeral: false },
              threadResultSchema,
              45_000,
            ),
          );
      this.store.settleOperation(operation, 'known', { threadId: response.thread.id });
      if (canonicalDirectory(response.thread.cwd) !== task.cwd)
        throw new TaskError('服务端执行目录不匹配');
      try {
        assertThreadPolicy(
          executableProject(this.config.projects, task.project_key, task.cwd),
          task.cwd,
          response,
        );
      } catch {
        this.store.fail(task.task_id, 'thread_start', 'project_policy_mismatch');
        return this.store.get(task.task_id);
      }
      this.subscribedThreads.add(response.thread.id);
      if (response.thread.status.type === 'active' || response.thread.status.type === 'systemError')
        throw new TaskError('会话已有执行或状态异常，不能提交新 turn');
      operation = this.store.bindThread(
        task.task_id,
        response.thread.id,
        task.cwd,
        this.rpc.connectionEpoch,
      );
      this.metrics.metadata(response.thread.id, response.thread);
      phase = 'turn_start';
      if (this.stopping) {
        this.store.settleOperation(operation, 'not_sent');
        this.store.fail(task.task_id, 'turn_start', 'desktop_stopped');
        return this.store.get(task.task_id);
      }
      const result = await this.mutating(operation, 'turn/start', () =>
        this.rpc.request(
          'turn/start',
          {
            threadId: response.thread.id,
            clientUserMessageId: task.task_id,
            input: [{ type: 'text', text: task.prompt, text_elements: [] }],
            ...this.policy(task).turn,
          },
          turnResultSchema,
          45_000,
        ),
      );
      this.store.settleOperation(operation, 'known', { turnId: result.turn.id });
      this.store.bindTurn(task.task_id, durableTurnSchema.parse(result.turn));
    } catch (error) {
      if (
        error instanceof RpcRejectedError ||
        (error instanceof RpcTransportError && error.outcome === 'not-sent')
      ) {
        this.store.settleOperation(
          operation,
          error instanceof RpcRejectedError ? 'rejected' : 'not_sent',
        );
        this.store.fail(
          task.task_id,
          phase,
          error instanceof RpcRejectedError
            ? phase === 'thread_start' &&
              error.method === 'thread/resume' &&
              error.code === -32600 &&
              task.thread_id &&
              error.remoteMessage.includes('thread-store conflict:') &&
              error.remoteMessage.includes(`thread ${task.thread_id} already has an active writer`)
              ? 'thread_writer_conflict'
              : `rpc_rejected_${error.code}`
            : 'rpc_not_sent',
        );
      } else {
        this.store.settleOperation(operation, 'unknown');
        this.store.unknown(task.task_id, 'submission_outcome_unknown');
      }
    }
    return this.store.get(task.task_id);
  }

  async recover() {
    this.ensureReady();
    for (const task of this.store.list(this.owner)) {
      if (!['starting', 'running', 'unknown'].includes(task.status) || !task.thread_id) continue;
      // Missing turn_id is not evidence of non-execution. Preserve the lock, never guess a turn by recency.
      if (!task.turn_id) continue;
      try {
        this.store.ownedThread(task.thread_id, this.owner);
        const metadata = await this.rpc.request(
          'thread/read',
          { threadId: task.thread_id, includeTurns: false },
          threadResultSchema,
        );
        if (metadata.thread.cwd !== task.cwd || metadata.thread.id !== task.thread_id)
          throw new TaskError('会话快照不匹配');
        let subscribed = false;
        let unavailableReason = 'subscription_unavailable';
        try {
          executableProject(this.config.projects, task.project_key, task.cwd);
          if (this.subscribedThreads.has(task.thread_id)) {
            subscribed = true;
          } else {
            await this.verifyProjectTools(task);
            const operation = this.store.recoveryOperation(task.task_id, this.rpc.connectionEpoch);
            try {
              const resumed = await this.mutating(operation, 'thread/resume', () =>
                this.rpc.request(
                  'thread/resume',
                  {
                    ...this.policy(task).thread,
                    threadId: task.thread_id ?? '',
                    excludeTurns: true,
                  },
                  threadResultSchema,
                ),
              );
              if (resumed.thread.id !== task.thread_id || resumed.thread.cwd !== task.cwd)
                throw new TaskError('恢复会话不匹配');
              assertThreadPolicy(
                executableProject(this.config.projects, task.project_key, task.cwd),
                task.cwd,
                resumed,
              );
              this.store.settleOperation(operation, 'known');
              this.subscribedThreads.add(task.thread_id);
              subscribed = true;
            } catch (error) {
              this.store.settleOperation(
                operation,
                error instanceof RpcRejectedError ? 'rejected' : 'unknown',
              );
              if (
                error instanceof RpcRejectedError &&
                error.code === -32600 &&
                error.remoteMessage.includes('thread-store conflict:') &&
                error.remoteMessage.includes(
                  `thread ${task.thread_id} already has an active writer`,
                )
              )
                unavailableReason = 'thread_writer_conflict';
            }
          }
        } catch {
          /* Permission revoked or directory gone: read history only. */
        }
        if (metadata.thread.historyMode === 'legacy') {
          const result = await this.rpc.request(
            'thread/read',
            { threadId: task.thread_id, includeTurns: true },
            threadResultSchema,
          );
          if (result.thread.id !== task.thread_id || result.thread.cwd !== task.cwd)
            throw new TaskError('会话快照不匹配');
          const turn = result.thread.turns.find((turn) => turn.id === task.turn_id);
          if (turn && (turn.status !== 'inProgress' || subscribed))
            this.store.reconcileTurn(task.task_id, turn);
          else this.store.unknown(task.task_id, unavailableReason);
        } else {
          let cursor: string | null = null;
          const seen = new Set<string>();
          let found = false;
          for (let page = 0; page < 100; page++) {
            const result: z.infer<typeof turnsPageSchema> = await this.rpc.request(
              'thread/turns/list',
              { threadId: task.thread_id, cursor, limit: 100, itemsView: 'full' },
              turnsPageSchema,
            );
            const turn = result.data.find((turn) => turn.id === task.turn_id);
            if (turn) {
              found = true;
              if (turn.status !== 'inProgress' || subscribed)
                this.store.reconcileTurn(task.task_id, turn);
              else this.store.unknown(task.task_id, unavailableReason);
              break;
            }
            if (!result.nextCursor || seen.has(result.nextCursor)) break;
            seen.add(result.nextCursor);
            cursor = result.nextCursor;
          }
          if (!found) this.store.unknown(task.task_id, 'turn_not_found');
        }
        if (subscribed || isTerminal(this.store.get(task.task_id).status))
          this.store.applyPending(task.task_id);
      } catch {
        this.store.unknown(task.task_id, 'reconciliation_unavailable');
      }
    }
  }
  async tickInteractions() {
    this.ensureReady();
    await this.interactions.tick();
    await this.controls.next(this.rpc, this.config, (id, method, call) =>
      this.mutating(id, method, call),
    );
  }
  stopDispatch() {
    this.stopping = true;
  }
  async interruptOwnedTasks(timeoutMs = 10_000) {
    this.stopping = true;
    for (const task of this.store.list(this.owner)) {
      if (task.status === 'queued') this.store.cancelQueued(task.task_id);
      if (task.status === 'running' && task.thread_id && task.turn_id && this.rpc.isReady) {
        this.store.ownedThread(task.thread_id, this.owner);
        this.controls.enqueue(
          `desktop-stop:${task.task_id}:${task.turn_id}`,
          task.task_id,
          'interrupt',
        );
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (
      this.rpc.isReady &&
      Date.now() < deadline &&
      this.store.list(this.owner).some((t) => t.status === 'running')
    ) {
      await this.controls.next(this.rpc, this.config, (id, method, call) =>
        this.mutating(id, method, call),
      );
      await delay(50);
    }
    for (const task of this.store.list(this.owner))
      if (['starting', 'running'].includes(task.status))
        this.store.unknown(task.task_id, 'desktop_stop_unconfirmed');
  }
  async waitForTask(id: string, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.rpc.isReady) {
      await this.tickInteractions();
      const task = this.store.get(id);
      if (isTerminal(task.status) || task.status === 'unknown') return task;
      await delay(100);
    }
    return this.store.get(id);
  }
}

export const taskSummary = (task: StoredTask) => ({
  taskId: task.task_id,
  projectKey: task.project_key,
  threadId: task.thread_id,
  turnId: task.turn_id,
  status: task.status,
  failurePhase: task.failure_phase,
  errorCode: task.error_code,
  waitingApproval: !!task.waiting_approval,
  waitingInput: !!task.waiting_input,
  version: task.version,
  createdAt: task.created_at,
  updatedAt: task.updated_at,
});
