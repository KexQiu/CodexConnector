import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  canTransition,
  isTerminal,
  type OwnerIdentity,
  type TaskStatus,
  type FailurePhase,
} from '../domain/model.js';
import { migrate } from '../persistence/migrate.js';
import {
  durableEventSchema,
  durableTurnSchema,
  itemEventSchema,
  taskRowSchema,
  TaskError,
  type DurableTurn,
  type StoredTask,
} from './types.js';
import type { RpcNotification, RpcServerRequest } from '../codex/rpc-client.js';
import { maxConcurrentTasksSchema } from '../config/project-policy.js';
import { contains } from '../projects/store.js';
import { ConversationStore } from '../conversations/store.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const ownerKey = (owner: OwnerIdentity) =>
  hash(JSON.stringify([owner.tenantKey, owner.appId, owner.openId]));
const eventRow = z.object({ inbox_id: z.string(), method: z.string(), payload: z.string() });
const threadRow = z.object({
  thread_id: z.string(),
  owner_key: z.string(),
  project_key: z.string().nullable(),
  conversation_id: z.string(),
  cwd: z.string(),
});

export class TaskStore {
  readonly conversations: ConversationStore;
  constructor(readonly db: Database.Database) {
    migrate(db);
    this.conversations = new ConversationStore(db);
  }

  get(id: string): StoredTask {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id);
    if (!row) throw new TaskError('任务不存在');
    return taskRowSchema.parse(row);
  }
  list(owner?: string): StoredTask[] {
    const rows = owner
      ? this.db
          .prepare('SELECT * FROM tasks WHERE owner_key = ? ORDER BY created_at DESC, task_id DESC')
          .all(owner)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at, task_id').all();
    return rows.map((row) => taskRowSchema.parse(row));
  }
  result(id: string): string {
    return this.db
      .prepare('SELECT text FROM task_items WHERE task_id = ? ORDER BY rowid')
      .pluck()
      .all(id)
      .join('\n');
  }
  ownedThread(id: string, owner: string) {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE thread_id = ? AND owner_key = ?')
      .get(id, owner);
    if (!row) throw new TaskError('只能继续当前用户拥有的 Gateway 会话');
    return threadRow.parse(row);
  }
  queued(owner: string) {
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t WHERE t.owner_key=? AND t.status='queued'
      ORDER BY coalesce((SELECT min(f.created_at) FROM feishu_commands f WHERE f.task_id=t.task_id AND f.target_conversation_id=t.conversation_id),t.created_at),
      coalesce((SELECT min(f.rowid) FROM feishu_commands f WHERE f.task_id=t.task_id AND f.target_conversation_id=t.conversation_id),t.rowid),t.task_id`,
      )
      .all(owner)
      .map((row) => taskRowSchema.parse(row));
  }

  request(owner: string, requestKey: string) {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE request_key=? AND owner_key=?')
      .get(hash(JSON.stringify([owner, 'local', requestKey])), owner);
    return row ? taskRowSchema.parse(row) : null;
  }
  submit(input: {
    owner: OwnerIdentity;
    requestKey: string;
    projectKey: string | null;
    conversationId?: string;
    chatId?: string;
    cwd: string;
    prompt: string;
    threadId?: string;
  }) {
    if (
      !input.requestKey.trim() ||
      input.requestKey.length > 256 ||
      !input.prompt.trim() ||
      input.prompt.length > 100_000
    )
      throw new TaskError('请求标识或任务内容无效');
    const owner = ownerKey(input.owner);
    const key = hash(JSON.stringify([owner, 'local', input.requestKey]));
    const legacyFingerprint = hash(
      JSON.stringify([input.projectKey, input.cwd, input.prompt, input.threadId ?? null]),
    );
    const fingerprint = input.conversationId
      ? hash(
          JSON.stringify([
            'conversation-v2',
            input.conversationId,
            input.projectKey,
            input.cwd,
            input.prompt,
          ]),
        )
      : legacyFingerprint;
    return this.db
      .transaction(() => {
        const existing = this.db.prepare('SELECT * FROM tasks WHERE request_key = ?').get(key);
        if (existing) {
          const task = taskRowSchema.parse(existing);
          const legacyBoundRetry =
            task.fingerprint_version === 1 &&
            input.conversationId === task.conversation_id &&
            task.project_key === input.projectKey &&
            task.cwd === input.cwd &&
            task.prompt === input.prompt &&
            (!input.threadId || input.threadId === task.thread_id) &&
            [null, task.thread_id].some(
              (thread) =>
                task.fingerprint ===
                hash(JSON.stringify([task.project_key, task.cwd, task.prompt, thread])),
            );
          if (input.conversationId)
            this.conversations.owned(input.conversationId, owner, input.chatId);
          if (
            !legacyBoundRetry &&
            task.fingerprint !== (task.fingerprint_version === 1 ? legacyFingerprint : fingerprint)
          )
            throw new TaskError('同一 request-key 不能用于不同任务');
          return { task, duplicate: true };
        }
        if (input.threadId) {
          const thread = this.ownedThread(input.threadId, owner);
          if (thread.cwd !== input.cwd || thread.project_key !== input.projectKey)
            throw new TaskError('会话执行目录或项目不匹配');
        }
        const conversation = input.conversationId
          ? this.conversations.owned(input.conversationId, owner, input.chatId)
          : input.threadId
            ? this.conversations.owned(
                this.ownedThread(input.threadId, owner).conversation_id,
                owner,
                input.chatId,
              )
            : input.projectKey !== null
              ? this.conversations.create({
                  owner,
                  ...(input.chatId ? { chat: input.chatId } : {}),
                  scope: { kind: 'project', projectKey: input.projectKey },
                  cwd: input.cwd,
                })
              : null;
        if (
          !conversation ||
          conversation.cwd !== input.cwd ||
          conversation.project_key !== input.projectKey ||
          (input.threadId && conversation.thread_id !== input.threadId)
        )
          throw new TaskError('任务与会话范围不匹配');
        const taskId = randomUUID(),
          inboxId = randomUUID(),
          now = Date.now();
        this.db
          .prepare(
            `INSERT INTO inbox (inbox_id,event_key,source,method,payload,state,created_at,updated_at) VALUES (?,?,'local','submit',?,'received',?,?)`,
          )
          .run(inboxId, key, JSON.stringify({ taskId }), now, now);
        this.db
          .prepare(
            `INSERT INTO tasks (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,thread_id,status,created_at,updated_at,conversation_id,fingerprint_version) VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`,
          )
          .run(
            taskId,
            key,
            fingerprint,
            owner,
            JSON.stringify(input.owner),
            input.projectKey,
            input.cwd,
            input.prompt,
            input.threadId ?? null,
            now,
            now,
            conversation.conversation_id,
            input.conversationId ? 2 : 1,
          );
        this.db
          .prepare("INSERT INTO commands VALUES (?, ?, ?, 'queued')")
          .run(randomUUID(), inboxId, taskId);
        this.db
          .prepare('UPDATE conversations SET updated_at=? WHERE conversation_id=?')
          .run(now, conversation.conversation_id);
        this.snapshot(this.get(taskId));
        return { task: this.get(taskId), duplicate: false };
      })
      .immediate();
  }

  private snapshot(task: StoredTask) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (outbox_id,logical_key,task_id,card_version,payload,state,created_at) VALUES (?,?,?,?,?,'pending',?)`,
      )
      .run(
        randomUUID(),
        `${task.task_id}:snapshot:${task.version}`,
        task.task_id,
        task.version,
        JSON.stringify({
          taskId: task.task_id,
          status: task.status,
          version: task.version,
          failurePhase: task.failure_phase,
        }),
        Date.now(),
      );
    this.db
      .prepare(
        `UPDATE outbox SET owner_key = (SELECT owner_key FROM task_destinations WHERE task_id = ?),
      chat_id = (SELECT chat_id FROM task_destinations WHERE task_id = ?) WHERE task_id = ? AND state = 'pending'`,
      )
      .run(task.task_id, task.task_id, task.task_id);
  }
  refresh(id: string) {
    this.db
      .transaction(() => {
        this.db
          .prepare('UPDATE tasks SET version = version + 1, updated_at = ? WHERE task_id = ?')
          .run(Date.now(), id);
        this.snapshot(this.get(id));
      })
      .immediate();
  }
  cancelQueued(id: string) {
    this.db
      .transaction(() => {
        if (this.get(id).status === 'queued')
          this.transition(id, 'interrupted', null, 'desktop_stopped');
      })
      .immediate();
  }
  private transition(
    id: string,
    status: TaskStatus,
    phase: FailurePhase | null = null,
    errorCode: string | null = null,
  ) {
    const previous = this.get(id);
    if (
      !canTransition(previous.status, status) ||
      (isTerminal(previous.status) && previous.status !== status)
    )
      return;
    if (previous.status !== status || previous.error_code !== errorCode) {
      this.db
        .prepare(
          'UPDATE tasks SET status = ?, failure_phase = ?, error_code = ?, version = version + 1, updated_at = ? WHERE task_id = ?',
        )
        .run(status, phase, errorCode, Date.now(), id);
      this.snapshot(this.get(id));
    }
    if (isTerminal(status)) {
      this.db
        .prepare('UPDATE tasks SET waiting_approval=0,waiting_input=0 WHERE task_id=?')
        .run(id);
      this.db.prepare('DELETE FROM execution_locks WHERE task_id = ?').run(id);
      this.db
        .prepare('UPDATE commands SET state = ? WHERE task_id = ?')
        .run(status === 'failed' ? 'failed' : 'done', id);
      this.db
        .prepare("UPDATE approvals SET state = 'expired' WHERE task_id = ? AND state = 'pending'")
        .run(id);
    }
  }
  operation(task: StoredTask, method: string, epoch: string, intent: object): string {
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        `INSERT INTO rpc_operations (operation_id,task_id,method,connection_epoch,intent,state,created_at,updated_at) VALUES (?,?,?,?,?,'intent',?,?)`,
      )
      .run(id, task.task_id, method, epoch, JSON.stringify(intent), now, now);
    return id;
  }
  recoveryOperation(id: string, epoch: string): string {
    const task = this.get(id);
    return this.operation(task, 'thread/resume', epoch, {
      purpose: 'restore-subscription',
      threadId: task.thread_id,
      cwd: task.cwd,
    });
  }
  claim(
    id: string,
    epoch: string,
    options: { maxConcurrentTasks?: number; checkoutRoot?: string } = {},
  ): string | null {
    const limit = maxConcurrentTasksSchema.parse(options.maxConcurrentTasks);
    return this.db
      .transaction(() => {
        let task = this.get(id);
        const conversation = this.conversations.owned(task.conversation_id, task.owner_key);
        if (task.status === 'queued' && !task.thread_id && conversation.thread_id) {
          this.db
            .prepare('UPDATE tasks SET thread_id=? WHERE task_id=?')
            .run(conversation.thread_id, id);
          task = this.get(id);
        }
        const occupied = this.db
          .prepare("SELECT count(*) FROM tasks WHERE status IN ('starting','running','unknown')")
          .pluck()
          .get() as number;
        if (task.status !== 'queued' || occupied >= limit) return null;
        if (
          this.queued(task.owner_key).find(
            (candidate) => candidate.conversation_id === task.conversation_id,
          )?.task_id !== id
        )
          return null;
        // A prior message whose target was committed but submission needs retry
        // must not be overtaken by a later task in the same conversation.
        if (
          this.db
            .prepare(
              "SELECT 1 FROM feishu_commands WHERE target_conversation_id=? AND state!='processed' AND task_id IS NULL AND created_at<=? LIMIT 1",
            )
            .get(task.conversation_id, task.created_at)
        )
          return null;
        const root = options.checkoutRoot ?? task.cwd;
        const locks = z
          .array(z.object({ lock_key: z.string() }))
          .parse(this.db.prepare('SELECT lock_key FROM execution_locks').all());
        if (
          locks.some(
            ({ lock_key: key }) =>
              key === `thread:${task.thread_id}` ||
              key === `conversation:${task.conversation_id}` ||
              (key.startsWith('checkout:') &&
                (contains(root, key.slice(9)) || contains(key.slice(9), root))),
          )
        )
          return null;
        for (const key of [
          `checkout:${root}`,
          `conversation:${task.conversation_id}`,
          ...(task.thread_id ? [`thread:${task.thread_id}`] : []),
        ]) {
          this.db.prepare('INSERT INTO execution_locks VALUES (?, ?, ?)').run(key, id, Date.now());
        }
        this.transition(id, 'starting');
        this.db.prepare("UPDATE commands SET state = 'processing' WHERE task_id = ?").run(id);
        this.db
          .prepare(
            "UPDATE inbox SET state = 'processed', attempts = attempts + 1, updated_at = ? WHERE inbox_id = (SELECT inbox_id FROM commands WHERE task_id = ?)",
          )
          .run(Date.now(), id);
        return this.operation(task, task.thread_id ? 'thread/resume' : 'thread/start', epoch, {
          cwd: task.cwd,
          threadId: task.thread_id,
        });
      })
      .immediate();
  }
  beforeWire(operationId: string, epoch: string, rpcId: string | number) {
    const changed = this.db
      .prepare(
        "UPDATE rpc_operations SET state = 'sent', rpc_id_json = ?, updated_at = ? WHERE operation_id = ? AND connection_epoch = ? AND state = 'intent'",
      )
      .run(JSON.stringify(rpcId), Date.now(), operationId, epoch).changes;
    if (changed !== 1) throw new TaskError('RPC 执行意图不存在或已发送');
  }
  settleOperation(
    id: string,
    state: 'known' | 'not_sent' | 'rejected' | 'unknown',
    result: object = {},
  ) {
    this.db
      .prepare(
        "UPDATE rpc_operations SET state = ?, result = ?, updated_at = ? WHERE operation_id = ? AND state NOT IN ('known','rejected','not_sent')",
      )
      .run(state, JSON.stringify(result), Date.now(), id);
  }
  bindThread(id: string, threadId: string, cwd: string, epoch: string): string {
    return this.db
      .transaction(() => {
        const task = this.get(id);
        const conversation = this.conversations.owned(task.conversation_id, task.owner_key);
        if (cwd !== task.cwd || (task.thread_id && task.thread_id !== threadId))
          throw new TaskError('RPC 会话目录或 ID 不匹配');
        if (conversation.thread_id && conversation.thread_id !== threadId)
          throw new TaskError('会话已经绑定其他 Codex 线程');
        const existing = this.db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId);
        if (existing) {
          const thread = threadRow.parse(existing);
          if (
            !task.thread_id ||
            thread.owner_key !== task.owner_key ||
            thread.cwd !== cwd ||
            thread.conversation_id !== task.conversation_id
          )
            throw new TaskError('RPC 会话归属冲突');
        } else {
          this.db
            .prepare(
              "INSERT INTO threads (thread_id,owner_key,owner_json,project_key,cwd,origin,created_at,conversation_id) VALUES (?, ?, ?, ?, ?, 'gateway', ?, ?)",
            )
            .run(
              threadId,
              task.owner_key,
              task.owner_json,
              task.project_key,
              cwd,
              Date.now(),
              task.conversation_id,
            );
        }
        this.db
          .prepare('UPDATE conversations SET thread_id=?,updated_at=? WHERE conversation_id=?')
          .run(threadId, Date.now(), task.conversation_id);
        this.db
          .prepare('INSERT OR IGNORE INTO execution_locks VALUES (?, ?, ?)')
          .run(`thread:${threadId}`, id, Date.now());
        if (
          this.db
            .prepare('SELECT task_id FROM execution_locks WHERE lock_key = ?')
            .pluck()
            .get(`thread:${threadId}`) !== id
        )
          throw new TaskError('会话已被另一任务占用');
        this.db
          .prepare('UPDATE tasks SET thread_id = ?, updated_at = ? WHERE task_id = ?')
          .run(threadId, Date.now(), id);
        return this.operation(this.get(id), 'turn/start', epoch, {
          threadId,
          clientUserMessageId: id,
        });
      })
      .immediate();
  }
  bindTurn(id: string, turn: DurableTurn) {
    this.db
      .transaction(() => {
        const task = this.get(id);
        if (task.turn_id && task.turn_id !== turn.id) throw new TaskError('RPC turn ID 冲突');
        this.db
          .prepare('UPDATE tasks SET turn_id = ?, updated_at = ? WHERE task_id = ?')
          .run(turn.id, Date.now(), id);
        this.applyTurn(id, turn);
        this.applyPending(id);
      })
      .immediate();
  }
  private applyTurn(id: string, turn: DurableTurn) {
    const task = this.get(id);
    if (task.turn_id !== turn.id) throw new TaskError('turn 不属于此任务');
    for (const item of turn.items) this.saveItem(id, item.id, item.text);
    const status = turn.status === 'inProgress' ? 'running' : turn.status;
    this.transition(
      id,
      status,
      status === 'failed' ? 'execution' : null,
      status === 'failed'
        ? ['cyberPolicy', 'misalignmentPolicyViolation'].includes(
            String(turn.error?.codexErrorInfo),
          )
          ? 'model_refused'
          : 'turn_failed'
        : null,
    );
  }
  private saveItem(id: string, itemId: string, text: string) {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO task_items VALUES (?, ?, ?)')
      .run(id, itemId, text);
    if (result.changes) {
      this.db
        .prepare('UPDATE tasks SET version = version + 1, updated_at = ? WHERE task_id = ?')
        .run(Date.now(), id);
      this.snapshot(this.get(id));
    }
  }
  recordEvent(notification: RpcNotification) {
    const { method, params } = notification;
    if (!['turn/started', 'turn/completed', 'item/completed'].includes(method)) return;
    const parsed =
      method === 'item/completed'
        ? itemEventSchema.safeParse(params)
        : durableEventSchema.safeParse(params);
    if (!parsed.success) {
      if (method === 'item/completed') return; // Only assistant output is retained, no tool arguments.
      throw new TaskError('RPC 生命周期事件结构不兼容');
    }
    const data = parsed.data;
    const threadId = data.threadId;
    if (!this.db.prepare('SELECT 1 FROM threads WHERE thread_id = ?').get(threadId)) return;
    const turnId = 'turn' in data ? data.turn.id : data.turnId;
    const key = `${method}:${threadId}:${turnId}:${'item' in data ? data.item.id : ''}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox (inbox_id,event_key,source,method,thread_id,turn_id,payload,state,created_at,updated_at) VALUES (?,?,'rpc',?,?,?,?,'received',?,?)`,
      )
      .run(randomUUID(), key, method, threadId, turnId, JSON.stringify(data), now, now);
    const taskId = this.db
      .prepare('SELECT task_id FROM tasks WHERE thread_id = ? AND turn_id = ?')
      .pluck()
      .get(threadId, turnId);
    if (typeof taskId === 'string') this.applyPending(taskId);
  }
  applyPending(id: string) {
    const task = this.get(id);
    if (!task.thread_id || !task.turn_id) return;
    const events = this.db
      .prepare(
        "SELECT inbox_id, method, payload FROM inbox WHERE source = 'rpc' AND thread_id = ? AND turn_id = ? AND state != 'processed' ORDER BY created_at, rowid",
      )
      .all(task.thread_id, task.turn_id)
      .map((row) => eventRow.parse(row));
    for (const event of events) {
      try {
        this.db.transaction(() => {
          const payload: unknown = JSON.parse(event.payload);
          if (event.method === 'item/completed') {
            const { item } = itemEventSchema.parse(payload);
            this.saveItem(id, item.id, item.text);
          } else this.applyTurn(id, durableEventSchema.parse(payload).turn);
          this.db
            .prepare(
              "UPDATE inbox SET state = 'processed', attempts = attempts + 1, error_code = NULL, updated_at = ? WHERE inbox_id = ?",
            )
            .run(Date.now(), event.inbox_id);
        })();
      } catch {
        this.db
          .prepare(
            "UPDATE inbox SET state = 'failed', attempts = attempts + 1, error_code = 'apply_failed', updated_at = ? WHERE inbox_id = ?",
          )
          .run(Date.now(), event.inbox_id);
        throw new TaskError('持久事件处理失败，保留待重试记录');
      }
    }
  }
  fail(id: string, phase: FailurePhase, code: string) {
    this.db.transaction(() => this.transition(id, 'failed', phase, code)).immediate();
  }
  unknown(id: string, code: string) {
    this.db
      .transaction(() => {
        if (isTerminal(this.get(id).status)) return;
        this.transition(id, 'unknown', null, code);
        this.db
          .prepare(
            "UPDATE rpc_operations SET state = 'unknown', updated_at = ? WHERE task_id = ? AND state IN ('intent','sent')",
          )
          .run(Date.now(), id);
      })
      .immediate();
  }
  reconcileTurn(id: string, turn: unknown) {
    this.db
      .transaction(() => {
        this.applyTurn(id, durableTurnSchema.parse(turn));
        this.applyPending(id);
      })
      .immediate();
  }
  acquireWorker(): string {
    return this.db
      .transaction(() => {
        const current = this.db
          .prepare('SELECT pid FROM worker_lease WHERE singleton = 1')
          .pluck()
          .get();
        if (typeof current === 'number') {
          try {
            process.kill(current, 0);
            throw new TaskError('已有任务 worker 存活');
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
              throw new TaskError('已有 worker 或无法确认其已退出');
          }
        }
        const token = randomUUID();
        this.db
          .prepare('INSERT OR REPLACE INTO worker_lease VALUES (1, ?, ?)')
          .run(token, process.pid);
        return token;
      })
      .immediate();
  }
  releaseWorker(token: string) {
    this.db.prepare('DELETE FROM worker_lease WHERE token = ?').run(token);
  }
  recoverLocal(epoch: string) {
    this.db
      .transaction(() => {
        for (const task of this.list())
          if (['starting', 'running'].includes(task.status))
            this.unknown(task.task_id, 'worker_restarted');
        this.db
          .prepare(
            "UPDATE approvals SET state = 'expired' WHERE connection_epoch != ? AND state = 'pending'",
          )
          .run(epoch);
        this.db
          .prepare(
            "UPDATE approvals SET response_state='unknown' WHERE response_state IN ('intent','sent') AND state='expired' AND connection_epoch!=?",
          )
          .run(epoch);
        this.db
          .prepare(
            "UPDATE task_controls SET state='unknown',error_code='control_outcome_unknown' WHERE state='sending'",
          )
          .run();
        for (const task of this.list()) {
          if (task.waiting_approval || task.waiting_input) {
            this.db
              .prepare('UPDATE tasks SET waiting_approval=0,waiting_input=0 WHERE task_id=?')
              .run(task.task_id);
            this.refresh(task.task_id);
          }
        }
      })
      .immediate();
  }
  recordUnsupportedApproval(request: RpcServerRequest) {
    const params = z
      .object({ threadId: z.string(), turnId: z.string().nullish() })
      .safeParse(request.params);
    if (!params.success) return;
    const taskId = this.db
      .prepare(
        "SELECT task_id FROM tasks WHERE thread_id = ? AND (turn_id = ? OR turn_id IS NULL) AND status IN ('starting','running','unknown')",
      )
      .pluck()
      .get(params.data.threadId, params.data.turnId ?? null);
    if (typeof taskId !== 'string') return;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO approvals (approval_id,task_id,thread_id,turn_id,connection_epoch,rpc_id_json,method,state,decision,expires_at,created_at,error_code) VALUES (?, ?, ?, ?, ?, ?, ?, 'unsupported', NULL, ?, ?, 'unsupported_or_unsafe_request')",
      )
      .run(
        randomUUID(),
        taskId,
        params.data.threadId,
        params.data.turnId ?? null,
        request.connectionEpoch,
        JSON.stringify(request.id),
        request.method,
        Date.now(),
        Date.now(),
      );
  }
  setContext(
    owner: string,
    projectKey: string | null,
    taskId: string | null,
    chat = '',
    conversationId?: string | null,
  ) {
    if (
      taskId &&
      (this.get(taskId).owner_key !== owner || this.get(taskId).project_key !== projectKey)
    )
      throw new TaskError('上下文归属不匹配');
    const conversation = conversationId ?? (taskId ? this.get(taskId).conversation_id : null);
    this.conversations.select(
      owner,
      chat,
      projectKey === null ? { kind: 'projectless' } : { kind: 'project', projectKey },
      conversation,
      taskId,
    );
  }
  diagnostics() {
    return {
      schemaVersion: this.db.pragma('user_version', { simple: true }),
      integrity: this.db.pragma('quick_check', { simple: true }),
      statuses: this.db
        .prepare('SELECT status, count(*) AS count FROM tasks GROUP BY status')
        .all(),
      locks: this.db.prepare('SELECT count(*) FROM execution_locks').pluck().get(),
      failedEvents: this.db
        .prepare("SELECT count(*) FROM inbox WHERE state = 'failed'")
        .pluck()
        .get(),
      pendingEvents: this.db
        .prepare("SELECT count(*) FROM inbox WHERE source = 'rpc' AND state = 'received'")
        .pluck()
        .get(),
      outbox: this.db.prepare('SELECT state, count(*) AS count FROM outbox GROUP BY state').all(),
      outboxErrors: this.db
        .prepare(
          'SELECT error_code, count(*) AS count FROM outbox WHERE error_code IS NOT NULL GROUP BY error_code',
        )
        .all(),
      feishuCommands: this.db
        .prepare('SELECT state, count(*) AS count FROM feishu_commands GROUP BY state')
        .all(),
      approvals: this.db
        .prepare(
          'SELECT state,response_state,count(*) AS count FROM approvals GROUP BY state,response_state',
        )
        .all(),
      controls: this.db
        .prepare('SELECT state,count(*) AS count FROM task_controls GROUP BY state')
        .all(),
    };
  }
}
