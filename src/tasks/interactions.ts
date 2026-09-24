import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import type { CodexRpcClient, RpcNotification, RpcServerRequest } from '../codex/rpc-client.js';
import type { McpServerElicitationRequestResponse } from '../codex/generated/v2/McpServerElicitationRequestResponse.js';
import type { DynamicToolCallResponse } from '../codex/generated/v2/DynamicToolCallResponse.js';
import { isTerminal } from '../domain/model.js';
import { executableProject } from '../projects/store.js';
import { assertProjectInteraction } from './project-policy.js';
import type { TaskStore } from './store.js';
import { TaskError } from './types.js';
import {
  choices,
  decisionSchema,
  describeInteraction,
  interactionResponse,
  parseInteraction,
  withinRoot,
  fileChangesSchema,
  type Decision,
} from './interaction-policy.js';

const rowSchema = z.object({
  approval_id: z.string(),
  task_id: z.string(),
  thread_id: z.string(),
  turn_id: z.string(),
  connection_epoch: z.string(),
  rpc_id_json: z.string(),
  method: z.string(),
  state: z.enum(['pending', 'unsupported', 'expired', 'resolved']),
  payload: z.string().nullable(),
  decision: z.string().nullable(),
  answers: z.string(),
  response_state: z.enum(['none', 'intent', 'sent', 'unknown']),
  expires_at: z.number(),
  error_code: z.string().nullable(),
});
export type InteractionRow = z.infer<typeof rowSchema>;
export const pendingInteractions = (store: TaskStore, taskId: string) =>
  store.db
    .prepare(
      "SELECT * FROM approvals WHERE task_id=? AND state='pending' ORDER BY created_at,rowid",
    )
    .all(taskId)
    .map((r) => rowSchema.parse(r));

/** Durable intent plus a live, epoch-bound request handle. Handles are never reconstructed after restart. */
export class Interactions {
  private readonly live = new Map<string, RpcServerRequest>();
  constructor(
    readonly store: TaskStore,
    private readonly config: GatewayConfig,
    private readonly rpc: CodexRpcClient,
    private readonly owner: string,
  ) {}
  private waiting(taskId: string) {
    const pending = pendingInteractions(this.store, taskId);
    const approval = +pending.some((r) => r.method !== 'item/tool/requestUserInput');
    const input = +pending.some((r) => r.method === 'item/tool/requestUserInput');
    const task = this.store.get(taskId);
    if (task.waiting_approval !== approval || task.waiting_input !== input) {
      this.store.db
        .prepare('UPDATE tasks SET waiting_approval=?,waiting_input=? WHERE task_id=?')
        .run(approval, input, taskId);
      this.store.refresh(taskId);
    }
  }
  private end(row: InteractionRow, state: 'expired' | 'resolved', reason: string | null) {
    this.store.db
      .transaction(() => {
        this.store.db
          .prepare(
            "UPDATE approvals SET state=?,error_code=? WHERE approval_id=? AND state='pending'",
          )
          .run(state, reason, row.approval_id);
        this.waiting(row.task_id);
        this.store.refresh(row.task_id);
      })
      .immediate();
    this.live.delete(row.approval_id);
  }
  async receive(request: RpcServerRequest) {
    const ids = z.object({ threadId: z.string(), turnId: z.string() }).safeParse(request.params);
    const tasks = ids.success
      ? this.store
          .list(this.owner)
          .filter(
            (t) =>
              t.thread_id === ids.data.threadId &&
              (t.turn_id === ids.data.turnId || (!t.turn_id && t.status === 'starting')) &&
              !isTerminal(t.status),
          )
      : [];
    if (tasks.length !== 1) {
      await this.rpc.reject(request);
      return;
    }
    const task = tasks[0]!;
    let parsed;
    try {
      assertProjectInteraction(
        executableProject(this.config.projects, task.project_key, task.cwd),
        request.method,
      );
      parsed = parseInteraction(request.method, request.params, task.cwd);
      if (!choices(parsed).length) throw new TaskError('没有受支持的审批选项');
      if (parsed.method === 'item/fileChange/requestApproval') {
        const raw = this.store.db
          .prepare(
            'SELECT payload FROM tool_observations WHERE thread_id=? AND turn_id=? AND item_id=?',
          )
          .pluck()
          .get(parsed.params.threadId, parsed.params.turnId, parsed.params.itemId);
        if (typeof raw !== 'string') throw new TaskError('文件变更明细缺失');
        const item = z
          .object({
            changes: fileChangesSchema,
          })
          .parse(JSON.parse(raw));
        for (const change of item.changes)
          if (!withinRoot(task.cwd, change.path)) throw new TaskError('文件变更超出项目');
        if (Buffer.byteLength(raw) > 8000) throw new TaskError('文件变更超出卡片展示范围');
        parsed.params.gatewayChanges = item.changes;
        parsed = parseInteraction(parsed.method, parsed.params, task.cwd);
      }
      if (
        Buffer.byteLength(
          describeInteraction(parsed, '00000000-0000-0000-0000-000000000000', task.cwd),
        ) > 10000
      )
        throw new TaskError('审批信息无法完整展示');
    } catch {
      this.store.recordUnsupportedApproval(request);
      this.store.refresh(task.task_id);
      if (request.method === 'mcpServer/elicitation/request')
        await this.rpc.respond(request, {
          action: 'cancel',
          content: null,
          _meta: null,
        } satisfies McpServerElicitationRequestResponse);
      else if (request.method === 'item/tool/call')
        await this.rpc.respond(request, {
          success: false,
          contentItems: [
            { type: 'inputText', text: 'Gateway 不支持动态工具；请使用已启用的本地工具。' },
          ],
        } satisfies DynamicToolCallResponse);
      else await this.rpc.reject(request);
      return;
    }
    const approvalId = randomUUID(),
      now = Date.now();
    const timeout =
      parsed.method === 'item/tool/requestUserInput' && parsed.params.autoResolutionMs
        ? Math.min(900000, parsed.params.autoResolutionMs)
        : 900000;
    this.store.db
      .transaction(() => {
        this.store.db
          .prepare(
            `INSERT INTO approvals
        (approval_id,task_id,thread_id,turn_id,connection_epoch,rpc_id_json,method,state,expires_at,created_at,payload)
        VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`,
          )
          .run(
            approvalId,
            task.task_id,
            parsed.params.threadId,
            parsed.params.turnId,
            request.connectionEpoch,
            JSON.stringify(request.id),
            request.method,
            now + timeout,
            now,
            JSON.stringify(parsed.params),
          );
        this.waiting(task.task_id);
        this.store.refresh(task.task_id);
      })
      .immediate();
    this.live.set(approvalId, request);
  }
  notification(notification: RpcNotification) {
    if (notification.method === 'serverRequest/resolved') {
      const data = z
        .object({ requestId: z.union([z.string(), z.number().int()]), threadId: z.string() })
        .parse(notification.params);
      for (const row of this.rows())
        if (
          row.connection_epoch === notification.connectionEpoch &&
          row.rpc_id_json === JSON.stringify(data.requestId) &&
          row.thread_id === data.threadId
        )
          this.end(row, 'resolved', null);
    }
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const data = z
        .object({
          threadId: z.string(),
          turnId: z.string(),
          item: z.object({
            type: z.literal('fileChange'),
            id: z.string(),
            changes: z
              .array(z.object({ path: z.string(), kind: z.unknown(), diff: z.string() }))
              .max(100),
          }),
        })
        .safeParse(notification.params);
      if (
        data.success &&
        this.store
          .list(this.owner)
          .some((t) => t.thread_id === data.data.threadId && !isTerminal(t.status))
      ) {
        const payload = JSON.stringify(data.data.item);
        if (Buffer.byteLength(payload) <= 64000)
          this.store.db
            .prepare('INSERT OR REPLACE INTO tool_observations VALUES (?,?,?,?)')
            .run(data.data.threadId, data.data.turnId, data.data.item.id, payload);
      }
    }
    this.sweep();
  }
  private rows(): InteractionRow[] {
    return this.store.db
      .prepare(
        "SELECT a.* FROM approvals a JOIN tasks t USING(task_id) WHERE t.owner_key=? AND a.state='pending'",
      )
      .all(this.owner)
      .map((r) => rowSchema.parse(r));
  }
  disconnect() {
    for (const row of this.rows())
      if (row.connection_epoch === this.rpc.connectionEpoch) {
        this.store.db
          .prepare(
            "UPDATE approvals SET response_state='unknown' WHERE approval_id=? AND response_state IN ('intent','sent')",
          )
          .run(row.approval_id);
        this.end(row, 'expired', 'connection_lost');
      }
    this.live.clear();
  }
  sweep() {
    for (const row of this.rows()) {
      const task = this.store.get(row.task_id);
      if (isTerminal(task.status) || (task.turn_id && task.turn_id !== row.turn_id))
        this.end(row, 'expired', 'turn_ended');
    }
    // TaskStore also expires approvals inside its terminal transaction.
    for (const task of this.store.list(this.owner)) this.waiting(task.task_id);
    for (const id of this.live.keys()) {
      const state = this.store.db
        .prepare('SELECT state FROM approvals WHERE approval_id=?')
        .pluck()
        .get(id);
      if (state !== 'pending') this.live.delete(id);
    }
  }
  find(shortId: string): InteractionRow {
    if (shortId.length < 8) throw new TaskError('审批 ID 至少 8 位');
    const rows = this.rows().filter((r) => r.approval_id.startsWith(shortId));
    if (rows.length !== 1) throw new TaskError('审批不存在、已失效或短 ID 不唯一');
    const row = rows[0]!;
    if (
      row.expires_at <= Date.now() ||
      row.connection_epoch !== this.rpc.connectionEpoch ||
      !this.live.has(row.approval_id)
    )
      throw new TaskError('审批已失效，请等待新的请求');
    return row;
  }
  decide(shortId: string, value: Decision, taskId?: string) {
    const row = this.find(shortId);
    if (taskId && row.task_id !== taskId) throw new TaskError('审批与目标任务不一致');
    if (row.decision || row.response_state !== 'none')
      throw new TaskError('该请求已选择，不能重复提交');
    const task = this.store.get(row.task_id);
    const parsed = parseInteraction(row.method, JSON.parse(row.payload!), task.cwd);
    interactionResponse(
      parsed,
      value,
      z.record(z.string(), z.string()).parse(JSON.parse(row.answers)),
    );
    this.store.db
      .prepare(
        "UPDATE approvals SET decision=? WHERE approval_id=? AND decision IS NULL AND state='pending'",
      )
      .run(value, row.approval_id);
    this.store.refresh(row.task_id);
  }
  answer(shortId: string, question: number, text: string, taskId?: string) {
    const row = this.find(shortId);
    if (taskId && row.task_id !== taskId) throw new TaskError('回答与被回复任务不一致');
    if (row.decision) throw new TaskError('回答已经提交');
    const parsed = parseInteraction(
      row.method,
      JSON.parse(row.payload!),
      this.store.get(row.task_id).cwd,
    );
    if (parsed.method !== 'item/tool/requestUserInput') throw new TaskError('这不是补充输入请求');
    const q = parsed.params.questions[question - 1];
    if (!q || !Number.isSafeInteger(question) || !text.trim() || text.length > 4000)
      throw new TaskError('题号或答案无效');
    if (q.options?.length && !q.isOther && !q.options.some((o) => o.label === text))
      throw new TaskError('请填写选项原文');
    const answers = z.record(z.string(), z.string()).parse(JSON.parse(row.answers));
    answers[q.id] = text;
    this.store.db
      .transaction(() => {
        this.store.db
          .prepare('UPDATE approvals SET answers=? WHERE approval_id=?')
          .run(JSON.stringify(answers), row.approval_id);
        if (parsed.params.questions.every((q) => answers[q.id]))
          this.decide(row.approval_id, 'answer');
        this.store.refresh(row.task_id);
      })
      .immediate();
  }
  async tick() {
    this.sweep();
    for (const row of this.rows()) {
      const request = this.live.get(row.approval_id);
      if (!request || row.connection_epoch !== this.rpc.connectionEpoch || !this.rpc.isReady) {
        this.end(row, 'expired', 'connection_lost');
        continue;
      }
      if (row.expires_at <= Date.now()) {
        if (row.response_state === 'sent')
          this.store.db
            .prepare("UPDATE approvals SET response_state='unknown' WHERE approval_id=?")
            .run(row.approval_id);
        this.end(
          row,
          'expired',
          row.response_state === 'sent' ? 'response_outcome_unknown' : 'timeout',
        );
        if (this.rpc.hasServerRequest(request)) await this.rpc.reject(request, -32000);
        continue;
      }
      if (!row.decision || row.response_state !== 'none') continue;
      const task = this.store.get(row.task_id);
      if (!task.turn_id && task.status === 'starting') continue; // Early server request before turn/start response.
      if (
        task.status !== 'running' ||
        task.turn_id !== row.turn_id ||
        !this.rpc.hasServerRequest(request)
      ) {
        this.end(row, 'expired', 'turn_not_active');
        if (task.status === 'unknown' && this.rpc.hasServerRequest(request))
          await this.rpc.reject(request, -32000);
        continue;
      }
      let response;
      try {
        const choice = decisionSchema.parse(row.decision);
        if (!['decline', 'cancel'].includes(choice))
          assertProjectInteraction(
            executableProject(this.config.projects, task.project_key, task.cwd),
            row.method,
          );
        const parsed = parseInteraction(row.method, JSON.parse(row.payload!), task.cwd);
        response = interactionResponse(
          parsed,
          choice,
          z.record(z.string(), z.string()).parse(JSON.parse(row.answers)),
        );
      } catch {
        this.end(row, 'expired', 'permission_changed');
        if (this.rpc.hasServerRequest(request)) await this.rpc.reject(request, -32000);
        continue;
      }
      // Commit before sending a response. An ambiguous write is never retried.
      this.store.db
        .prepare(
          "UPDATE approvals SET response_state='intent' WHERE approval_id=? AND response_state='none'",
        )
        .run(row.approval_id);
      try {
        await this.rpc.respond(request, response);
        this.store.db
          .prepare("UPDATE approvals SET response_state='sent' WHERE approval_id=?")
          .run(row.approval_id);
        // A socket write is not server confirmation. Retire only on serverRequest/resolved
        // or a matching turn terminal event, and never re-send this response.
        this.store.refresh(row.task_id);
      } catch {
        this.store.db
          .prepare("UPDATE approvals SET response_state='unknown' WHERE approval_id=?")
          .run(row.approval_id);
        this.end(row, 'expired', 'response_outcome_unknown');
      }
    }
  }
}

export function interactionCard(store: TaskStore, row: InteractionRow) {
  const task = store.get(row.task_id);
  let parsed;
  try {
    parsed = parseInteraction(row.method, JSON.parse(row.payload!), task.cwd);
  } catch {
    return { text: '请求目录或权限条件已变化，不能批准；请在本机核对。', choices: [] };
  }
  let text = describeInteraction(parsed, row.approval_id, task.cwd);
  if (row.decision) text += '\n决定已记录，等待提交。';
  text += `\n有效至：${new Date(row.expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
  return { text, choices: row.decision || row.expires_at <= Date.now() ? [] : choices(parsed) };
}
