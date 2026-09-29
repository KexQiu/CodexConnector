import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import { RpcRejectedError, RpcTransportError, type CodexRpcClient } from '../codex/rpc-client.js';
import { executionTarget } from '../conversations/execution.js';
import type { StoredTask } from './types.js';
import type { TaskStore } from './store.js';
import { TaskError } from './types.js';

type Kind = 'steer' | 'interrupt';
const rowSchema = z.object({
  control_id: z.string(),
  task_id: z.string(),
  kind: z.enum(['steer', 'interrupt']),
  turn_id: z.string(),
  text: z.string(),
});
export class TaskControls {
  constructor(
    readonly store: TaskStore,
    readonly owner: string,
  ) {}
  enqueue(id: string, taskId: string, kind: Kind, text = '') {
    const task = this.store.get(taskId);
    if (task.owner_key !== this.owner) throw new TaskError('任务归属不匹配');
    const prior = this.store.db.prepare('SELECT * FROM task_controls WHERE control_id=?').get(id);
    if (prior) {
      const row = rowSchema.parse(prior);
      if (row.task_id !== taskId || row.kind !== kind || row.text !== text)
        throw new TaskError('控制请求标识冲突');
      return;
    }
    if (task.status !== 'running' || !task.thread_id || !task.turn_id)
      throw new TaskError('任务已结束或当前状态不可控制；不会新建 turn');
    if (kind === 'steer' && (!text.trim() || text.length > 100000))
      throw new TaskError('补充指令不能为空或过长');
    this.store.db
      .prepare(
        "INSERT INTO task_controls (control_id,task_id,owner_key,kind,turn_id,text,state,created_at) VALUES (?,?,?,?,?,?,'queued',?)",
      )
      .run(id, taskId, this.owner, kind, task.turn_id, text, Date.now());
    this.store.refresh(taskId);
  }
  recover(projectless?: boolean) {
    this.store.db
      .prepare(
        "UPDATE task_controls SET state='unknown',error_code='control_outcome_unknown' WHERE owner_key=? AND state='sending' AND (? IS NULL OR task_id IN (SELECT task_id FROM tasks WHERE (project_key IS NULL)=?))",
      )
      .run(
        this.owner,
        projectless === undefined ? null : +projectless,
        projectless === undefined ? null : +projectless,
      );
  }
  async next(
    connection: CodexRpcClient | ((task: StoredTask) => CodexRpcClient | undefined),
    config: GatewayConfig,
    wire: (
      id: string,
      method: 'turn/steer' | 'turn/interrupt',
      call: () => Promise<unknown>,
    ) => Promise<unknown>,
  ) {
    const raw = this.store.db
      .prepare(
        "SELECT * FROM task_controls WHERE owner_key=? AND state='queued' ORDER BY created_at,rowid",
      )
      .all(this.owner)
      .find((value) => {
        const candidate = rowSchema.parse(value);
        const rpc =
          typeof connection === 'function'
            ? connection(this.store.get(candidate.task_id))
            : connection;
        return rpc?.isReady;
      });
    if (!raw) return false;
    const row = rowSchema.parse(raw),
      task = this.store.get(row.task_id);
    const rpc = typeof connection === 'function' ? connection(task) : connection;
    if (!rpc?.isReady) return false;
    const finish = (state: string, error: string | null) =>
      this.store.db
        .transaction(() => {
          this.store.db
            .prepare('UPDATE task_controls SET state=?,error_code=? WHERE control_id=?')
            .run(state, error, row.control_id);
          this.store.refresh(task.task_id);
        })
        .immediate();
    if (task.status !== 'running' || task.turn_id !== row.turn_id || !task.thread_id) {
      finish('rejected', 'turn_ended_or_unavailable');
      return true;
    }
    try {
      this.store.ownedThread(task.thread_id, this.owner);
      if (row.kind === 'steer') executionTarget(this.store, config, task);
    } catch {
      finish('rejected', 'project_not_writable');
      return true;
    }
    const method = row.kind === 'steer' ? 'turn/steer' : 'turn/interrupt';
    const operation = this.store.db
      .transaction(() => {
        const op = this.store.operation(task, method, rpc.connectionEpoch, {
          threadId: task.thread_id,
          turnId: row.turn_id,
          controlId: row.control_id,
        });
        this.store.db
          .prepare("UPDATE task_controls SET state='sending' WHERE control_id=?")
          .run(row.control_id);
        return op;
      })
      .immediate();
    try {
      await wire(operation, method, () =>
        row.kind === 'steer'
          ? rpc.request(
              'turn/steer',
              {
                threadId: task.thread_id!,
                expectedTurnId: row.turn_id,
                clientUserMessageId: row.control_id,
                input: [{ type: 'text', text: row.text, text_elements: [] }],
              },
              z.object({ turnId: z.literal(row.turn_id) }),
            )
          : rpc.request(
              'turn/interrupt',
              { threadId: task.thread_id!, turnId: row.turn_id },
              z.object({}),
            ),
      );
      this.store.settleOperation(operation, 'known');
      finish('accepted', null); // Interrupt acknowledgement is not a terminal event.
    } catch (error) {
      const known =
        error instanceof RpcRejectedError ||
        (error instanceof RpcTransportError && error.outcome === 'not-sent');
      this.store.settleOperation(
        operation,
        known ? (error instanceof RpcRejectedError ? 'rejected' : 'not_sent') : 'unknown',
      );
      finish(
        known ? 'rejected' : 'unknown',
        known ? 'turn_ended_or_control_rejected' : 'control_outcome_unknown',
      );
    }
    return true;
  }
}
