import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { OutboxStore, type OutboxClaim } from '../tasks/outbox.js';
import type { TaskStore } from '../tasks/store.js';
import { ownerKey } from '../tasks/store.js';
import { taskFailureDescription } from '../tasks/presentation.js';
import { pendingInteractions, interactionCard } from '../tasks/interactions.js';
import { FeishuApiError, type FeishuApi, type RemoteMessage } from './api.js';
import type { FeishuCredentials } from './credentials.js';
import { noticeSchema, shortText, type NoticeButton } from './conversation-ui.js';
import {
  buttonRows,
  buttonStyle,
  escapeCardText,
  renderLayout,
  type CardLayout,
} from './card-layout.js';
import { taskLayout } from './task-layout.js';
import { sameConversation } from './session-cards.js';
import { resultPages } from './result-pages.js';

export const receiptMarker = (id: string) => `GW-${id}`;
export const terminalNoticeKey = (taskId: string) => `feishu:terminal-fallback:${taskId}`;
const stateNames = {
  queued: '排队中',
  starting: '启动中',
  running: '执行中',
  completed: '执行完成',
  failed: '执行失败',
  interrupted: '已打断',
  unknown: '结果待核对',
};
export class FeishuSender {
  readonly outbox: OutboxStore;
  readonly owner: string;
  constructor(
    readonly store: TaskStore,
    readonly credentials: FeishuCredentials,
    private readonly api: Pick<FeishuApi, 'prepare' | 'create' | 'update' | 'get' | 'history'>,
    private readonly projects: { key: string; name: string }[] = [],
  ) {
    this.outbox = new OutboxStore(store.db);
    this.owner = ownerKey({
      appId: credentials.appId,
      tenantKey: credentials.tenantKey,
      openId: credentials.allowedOpenId,
    });
  }
  private freeze(row: OutboxClaim): string {
    if (row.wire_content) return row.wire_content;
    return this.store.db
      .transaction(() => {
        let title: string,
          text = '',
          template = 'blue';
        let layout: CardLayout | undefined;
        const buttons: object[] = [];
        const approvalButtons: object[] = [];
        let primaryAssigned = false;
        const addButton = (
          action: string,
          label: string,
          taskId: string | null,
          options: {
            approvalId?: string | null;
            choice?: string | null;
            expiresAt?: number;
            projectKey?: string | null;
            draftId?: string | null;
            page?: number | null;
          } = {},
        ) => {
          const nonce = randomUUID();
          let style = buttonStyle(action, options.choice);
          if (style === 'primary') {
            if (primaryAssigned) style = 'default';
            primaryAssigned = true;
          }
          this.store.db
            .prepare(
              `INSERT INTO feishu_actions
            (nonce,outbox_id,task_id,owner_key,chat_id,message_id,action,expires_at,approval_id,choice,project_key,draft_id,page)
            VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
            )
            .run(
              nonce,
              row.outbox_id,
              taskId,
              this.owner,
              this.credentials.testChatId,
              action,
              options.expiresAt ?? Date.now() + 24 * 3600_000,
              options.approvalId ?? null,
              options.choice ?? null,
              options.projectKey ?? null,
              options.draftId ?? null,
              options.page ?? null,
            );
          (action === 'approval' ? approvalButtons : buttons).push({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: label },
                type: style,
                width: 'fill',
                behaviors: [{ type: 'callback', value: { gatewayNonce: nonce } }],
              },
            ],
          });
        };
        if (row.task_id) {
          const task = this.store.get(row.task_id);
          if (task.owner_key !== this.owner) throw new Error('Outbox ownership mismatch');
          const projectName =
            this.projects.find((p) => p.key === task.project_key)?.name ??
            task.project_key ??
            '无项目';
          title = `${stateNames[task.status]} · ${shortText(projectName, 40)}`;
          layout = taskLayout(this.store, task, projectName);
          const pending = pendingInteractions(this.store, task.task_id);
          const approval = pending[0];
          if (approval) {
            const card = interactionCard(this.store, approval);
            layout.sections.unshift({
              title: '待处理请求',
              text: card.text,
              notes: [`待处理请求数：${pending.length}`],
              approval: true,
            });
            for (const choice of card.choices)
              addButton('approval', choice.label, task.task_id, {
                approvalId: approval.approval_id,
                choice: choice.value,
                expiresAt: approval.expires_at,
              });
          }
          const control = this.store.db
            .prepare(
              'SELECT kind,state FROM task_controls WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
            )
            .get(task.task_id);
          if (control) {
            const c = z
              .object({
                kind: z.enum(['steer', 'interrupt']),
                state: z.enum(['queued', 'sending', 'accepted', 'rejected', 'unknown']),
              })
              .parse(control);
            const labels = {
              queued: '已排队',
              sending: '提交中',
              accepted: c.kind === 'interrupt' ? '已请求打断，等待终态' : '已送入当前 turn',
              rejected: '已结束、权限变化或请求被拒绝；未创建新 turn',
              unknown: '结果不确定，不会自动重发',
            };
            layout.alerts.push(
              `${c.kind === 'interrupt' ? '打断' : '补充指令'}：${labels[c.state]}`,
            );
          }
          const unsupported = this.store.db
            .prepare("SELECT 1 FROM approvals WHERE task_id=? AND state='unsupported' LIMIT 1")
            .get(task.task_id);
          if (unsupported)
            layout.alerts.push(
              '存在不支持或不满足目录/展示约束的交互请求，已明确拒绝，未自动授权。',
            );
          const selectedId = this.store.db
            .prepare('SELECT task_id FROM user_context WHERE owner_key=? AND chat_id=?')
            .pluck()
            .get(this.owner, this.credentials.testChatId);
          const selected = typeof selectedId === 'string' ? this.store.get(selectedId) : null;
          if (!sameConversation(task, selected)) addButton('select', '接着聊', task.task_id);
          if (resultPages(this.store.result(task.task_id)).length > 1)
            addButton('result', '查看完整内容', task.task_id, { page: 0 });
          addButton('details', '查看详情', task.task_id);
          if (['queued', 'starting', 'running', 'unknown'].includes(task.status))
            addButton('refresh', '刷新状态', task.task_id);
          if (task.status === 'running') addButton('interrupt', '停止任务', task.task_id);
        } else {
          const notice = noticeSchema.parse(JSON.parse(row.payload));
          title = notice.title;
          text = notice.text;
          layout = notice.layout;
          for (const button of notice.buttons) {
            if (button.taskId && this.store.get(button.taskId).owner_key !== this.owner)
              throw new Error('Notice task ownership mismatch');
            addButton(button.action, button.label, button.taskId, button satisfies NoticeButton);
          }
        }
        if (row.view_parent_id) addButton('back', '返回上一层', null);
        const inlineIndexes = new Set(
          layout?.sections.flatMap((section) => section.actions ?? []) ?? [],
        );
        if ([...inlineIndexes].some((i) => i >= buttons.length))
          throw new Error('Invalid inline action index');
        const footerButtons = buttons.filter((_, i) => !inlineIndexes.has(i));
        template = layout?.theme ?? template;
        const content = JSON.stringify({
          schema: '2.0',
          config: { update_multi: true },
          // IM GET/LIST reduce JSON 2.0 cards to a preview and may omit every body element.
          // The title survives that projection; keep the durable receipt there as well.
          header: {
            title: { tag: 'plain_text', content: `${title} · ${receiptMarker(row.outbox_id)}` },
            template,
          },
          body: {
            elements: [
              ...(layout
                ? renderLayout(layout, approvalButtons, buttons)
                : [{ tag: 'markdown', content: escapeCardText(text) }]),
              ...(footerButtons.length ? [{ tag: 'hr' }, ...buttonRows(footerButtons)] : []),
              { tag: 'markdown', content: `回执：${receiptMarker(row.outbox_id)}` },
            ],
          },
        });
        if (Buffer.byteLength(content) > 28_000) throw new Error('Card too large');
        this.store.db
          .prepare('UPDATE outbox SET wire_content = ? WHERE outbox_id = ?')
          .run(content, row.outbox_id);
        return content;
      })
      .immediate();
  }
  async flushOne(now = Date.now()) {
    const row = this.outbox.claim(now, 60_000, {
      owner: this.owner,
      chat: this.credentials.testChatId,
    });
    if (!row?.claim_token) return false;
    let sending = false;
    try {
      const content = this.freeze(row);
      await this.api.prepare();
      this.outbox.markSending(row.claim_token);
      sending = true;
      const message =
        row.operation === 'update' && row.message_id
          ? await this.api.update(row.message_id, content)
          : await this.api.create(this.credentials.testChatId, content, row.outbox_id);
      this.outbox.complete(row.claim_token, message);
    } catch (error) {
      const outcome =
        error instanceof FeishuApiError
          ? sending
            ? error.outcome
            : error.outcome === 'permanent'
              ? 'permanent'
              : 'not-sent'
          : sending
            ? 'unknown'
            : 'permanent';
      this.outbox.fail(
        row.claim_token,
        outcome,
        Date.now(),
        error instanceof FeishuApiError ? error.retryAfterMs : 0,
      );
      if (error instanceof FeishuApiError)
        this.store.db
          .prepare('UPDATE outbox SET error_code = ? WHERE outbox_id = ?')
          .run(`feishu_${error.httpStatus}_${error.apiCode ?? outcome}`, row.outbox_id);
    }
    return true;
  }
  private matches(message: RemoteMessage, marker: string) {
    return (
      !message.deleted &&
      message.chat_id === this.credentials.testChatId &&
      message.msg_type === 'interactive' &&
      message.sender.sender_type === 'app' &&
      message.sender.id_type === 'app_id' &&
      message.sender.id === this.credentials.appId &&
      (!message.sender.tenant_key || message.sender.tenant_key === this.credentials.tenantKey) &&
      message.body.content.includes(marker)
    );
  }
  /** A separate, immutable notice cannot be overwritten by a late PATCH of the old card. */
  private queueTerminalNotice(now: number) {
    this.store.db
      .transaction(() => {
        const blocked = z
          .object({ task_id: z.string(), outbox_id: z.string(), message_id: z.string() })
          .optional()
          .parse(
            this.store.db
              .prepare(
                `SELECT o.task_id,o.outbox_id,o.message_id FROM outbox o
                JOIN tasks t ON t.task_id=o.task_id
                JOIN task_destinations d ON d.task_id=t.task_id
                WHERE o.owner_key=? AND o.chat_id=? AND t.owner_key=o.owner_key
                  AND d.owner_key=o.owner_key AND d.chat_id=o.chat_id
                  AND o.state='unknown' AND o.operation='update' AND o.sent_at<=?
                  AND o.message_id=t.notification_message_id
                  AND t.status IN ('completed','failed','interrupted')
                  AND NOT EXISTS (SELECT 1 FROM outbox n WHERE n.logical_key='feishu:terminal-fallback:'||t.task_id)
                ORDER BY o.created_at LIMIT 1`,
              )
              .get(this.owner, this.credentials.testChatId, now - 60_000),
          );
        if (!blocked) return;
        const task = this.store.get(blocked.task_id);
        const text =
          '原任务卡更新结果仍待核对，旧卡可能显示过时状态。以下是已确认的最终结果。\n' +
          `任务：${task.task_id}\n状态：${stateNames[task.status]}\n项目：${task.project_key}\n` +
          `目录：${task.cwd}\nthread：${task.thread_id ?? '未绑定'}\nturn：${task.turn_id ?? '未绑定'}\n` +
          (taskFailureDescription(task) ? `${taskFailureDescription(task)}\n` : '') +
          (task.status === 'completed' ? '模型执行已结束，需求是否满足仍需验收。\n' : '') +
          this.store.result(task.task_id).slice(-1800) +
          `\n查看任务请发送：/状态 ${task.task_id}`;
        // task_id=NULL uses the existing independent-notice delivery lane. The source
        // identifiers remain in payload for audit; never replace the original card binding.
        this.store.db
          .prepare(
            `INSERT INTO outbox
            (outbox_id,logical_key,task_id,card_version,payload,state,created_at,owner_key,chat_id)
            VALUES (?,?,NULL,1,?,'pending',?,?,?)`,
          )
          .run(
            randomUUID(),
            terminalNoticeKey(task.task_id),
            JSON.stringify({
              title: `补充通知 · ${stateNames[task.status]} · ${task.project_key}`,
              text,
              sourceTaskId: task.task_id,
              sourceOutboxId: blocked.outbox_id,
              sourceMessageId: blocked.message_id,
              sourceCardVersion: task.version,
            }),
            now,
            this.owner,
            this.credentials.testChatId,
          );
      })
      .immediate();
  }
  async reconcileOne(now = Date.now()) {
    this.outbox.recoverExpired(now);
    const row = z
      .object({
        outbox_id: z.string(),
        message_id: z.string().nullable(),
        sent_at: z.number().nullable(),
      })
      .optional()
      .parse(
        this.store.db
          .prepare(
            "SELECT * FROM outbox WHERE owner_key = ? AND chat_id = ? AND state = 'unknown' AND reconcile_at <= ? ORDER BY created_at LIMIT 1",
          )
          .get(this.owner, this.credentials.testChatId, now),
      );
    if (!row) {
      this.queueTerminalNotice(now);
      return false;
    }
    this.store.db
      .prepare('UPDATE outbox SET reconcile_at = ? WHERE outbox_id = ?')
      .run(now + 30_000, row.outbox_id);
    try {
      const messages = row.message_id
        ? [await this.api.get(row.message_id)]
        : await this.api.history(this.credentials.testChatId, (row.sent_at ?? now) - 5000);
      const matches = messages.filter((m) => this.matches(m, receiptMarker(row.outbox_id)));
      if (matches.length === 1)
        this.outbox.recordVerifiedReceipt(row.outbox_id, matches[0]!.message_id);
      // No match is never evidence that POST/PATCH did not happen. Keep unknown; never resend.
    } catch {
      /* A failed read does not grant permission to send again. */
    }
    this.queueTerminalNotice(now);
    return true;
  }
}
