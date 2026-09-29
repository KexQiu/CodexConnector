import { createHash, randomUUID } from 'node:crypto';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { TaskStore } from '../tasks/store.js';
import { ownerKey } from '../tasks/store.js';
import { TaskError } from '../tasks/types.js';
import { silentLogger, type FeishuCredentials } from './credentials.js';
import { CardViews } from './card-views.js';
import { uiActionSchema } from './conversation-ui.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const id = z.string().min(1).max(256);
export const inboundPayload = z.object({
  kind: z.enum(['message', 'action', 'menu']),
  sourceOutboxId: id.nullable().optional(),
  replyOutboxId: id.nullable().optional(),
  replyCardPending: z.boolean().optional(),
  text: z.string().max(100_000),
  messageId: id,
  replyTo: id.nullable(),
  taskId: id.nullable(),
  action: uiActionSchema.nullable(),
  projectKey: id.nullable().default(null),
  draftId: id.nullable().default(null),
  page: z.number().int().min(0).nullable().default(null),
  approvalId: id.nullable().default(null),
  choice: z.string().nullable().default(null),
});
export type InboundPayload = z.infer<typeof inboundPayload>;
const messageSchema = z.object({
  event_id: id,
  app_id: id,
  tenant_key: id,
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: id }) }),
  message: z.object({
    message_id: id,
    chat_id: id,
    chat_type: z.string(),
    message_type: z.string(),
    content: z.string().max(150_000),
    parent_id: id.optional(),
  }),
});
const actionSchema = z.object({
  event_id: id,
  app_id: id,
  tenant_key: id,
  operator: z.object({ open_id: id }),
  context: z.object({ open_chat_id: id, open_message_id: id }),
  action: z.object({ value: z.object({ gatewayNonce: id }) }),
});
export const BOT_MENU_COMMANDS: Readonly<Record<string, string>> = {
  codex_current_context: '/当前',
  codex_switch_project: '/项目',
  codex_new_topic: '/新话题',
};
const menuSchema = z.object({
  event_id: id,
  app_id: id,
  tenant_key: id,
  operator: z.object({ operator_id: z.object({ open_id: id }) }),
  event_key: z.string(),
});
const actionRow = z.object({
  outbox_id: id,
  task_id: id.nullable(),
  owner_key: id,
  chat_id: id,
  message_id: id.nullable(),
  action: uiActionSchema,
  project_key: id.nullable(),
  draft_id: id.nullable(),
  page: z.number().int().min(0).nullable(),
  approval_id: id.nullable(),
  choice: z.string().nullable(),
  expires_at: z.number(),
  panel_id: z.string().nullable().default(null),
  panel_message_id: z.string().nullable().default(null),
});
export class FeishuInbox {
  readonly owner: string;
  constructor(
    readonly store: TaskStore,
    readonly credentials: FeishuCredentials,
    readonly prefix = '',
  ) {
    this.owner = ownerKey({
      tenantKey: credentials.tenantKey,
      appId: credentials.appId,
      openId: credentials.allowedOpenId,
    });
  }
  private allowed(app: string, tenant: string, actor: string, chat: string) {
    const c = this.credentials;
    return (
      app === c.appId &&
      tenant === c.tenantKey &&
      actor === c.allowedOpenId &&
      chat === c.testChatId
    );
  }
  receive(kind: 'message' | 'action' | 'menu', value: unknown) {
    let eventId: string, businessKey: string, payload: InboundPayload;
    if (kind === 'menu') {
      const parsed = menuSchema.safeParse(value);
      if (!parsed.success) return { outcome: 'denied' };
      const data = parsed.data;
      if (
        !this.allowed(
          data.app_id,
          data.tenant_key,
          data.operator.operator_id.open_id,
          this.credentials.testChatId,
        )
      )
        return { outcome: 'denied' };
      const text = Object.hasOwn(BOT_MENU_COMMANDS, data.event_key)
        ? BOT_MENU_COMMANDS[data.event_key]
        : undefined;
      if (!text || this.prefix) return { outcome: 'ignored' };
      eventId = data.event_id;
      businessKey = `menu:${eventId}`;
      payload = inboundPayload.parse({
        kind,
        text,
        messageId: eventId,
        replyTo: null,
        taskId: null,
        action: null,
      });
    } else if (kind === 'message') {
      const data = messageSchema.parse(value);
      const m = data.message;
      if (
        !this.allowed(data.app_id, data.tenant_key, data.sender.sender_id.open_id, m.chat_id) ||
        m.chat_type !== 'p2p' ||
        data.sender.sender_type !== 'user'
      )
        return { outcome: 'denied' };
      if (m.message_type !== 'text') return { outcome: 'ignored' };
      const content = z.object({ text: z.string().max(100_000) }).parse(JSON.parse(m.content));
      if (this.prefix && !content.text.startsWith(this.prefix)) return { outcome: 'ignored' };
      const views = new CardViews(this.store, this.owner, this.credentials.testChatId);
      const quoted = m.parent_id ? views.visible(m.parent_id) : null;
      payload = {
        kind,
        replyOutboxId: quoted?.outbox_id ?? null,
        replyCardPending: quoted ? !views.current(quoted) : false,
        text: content.text.slice(this.prefix.length).trim(),
        messageId: m.message_id,
        replyTo: m.parent_id ?? null,
        taskId: null,
        action: null,
        approvalId: null,
        choice: null,
        projectKey: null,
        draftId: null,
        page: null,
      };
      eventId = data.event_id;
      businessKey = `message:${m.message_id}`;
    } else {
      const parsed = actionSchema.safeParse(value);
      if (!parsed.success) return { outcome: 'denied' };
      const data = parsed.data;
      if (
        !this.allowed(
          data.app_id,
          data.tenant_key,
          data.operator.open_id,
          data.context.open_chat_id,
        )
      )
        return { outcome: 'denied' };
      const action = actionRow.safeParse(
        this.store.db
          .prepare(
            `SELECT a.*,o.panel_id,p.message_id AS panel_message_id FROM feishu_actions a
            JOIN outbox o USING(outbox_id) LEFT JOIN feishu_panels p USING(panel_id) WHERE a.nonce = ?`,
          )
          .get(data.action.value.gatewayNonce),
      );
      // Event redelivery remains a duplicate even after its card revision is retired.
      const duplicate = this.store.db
        .prepare(
          `SELECT command_id FROM feishu_commands
        WHERE owner_key=? AND chat_id=? AND inbox_id IN (SELECT inbox_id FROM inbox WHERE event_key=?)`,
        )
        .get(
          this.owner,
          this.credentials.testChatId,
          digest(`${this.owner}:feishu:action:${data.event_id}`),
        );
      if (duplicate) return { outcome: 'duplicate' };
      if (
        !action.success ||
        action.data.owner_key !== this.owner ||
        action.data.chat_id !== this.credentials.testChatId ||
        action.data.message_id !== data.context.open_message_id ||
        (action.data.panel_id !== null &&
          action.data.panel_message_id !== data.context.open_message_id) ||
        action.data.expires_at <= Date.now()
      )
        return { outcome: 'expired-or-invalid' };
      const views = new CardViews(this.store, this.owner, this.credentials.testChatId);
      const source = views.get(action.data.outbox_id);
      if (source && !views.current(source))
        return { outcome: 'expired-or-invalid', reason: 'card-updating' };
      if (action.data.action === 'approval') {
        const active = this.store.db
          .prepare(
            "SELECT 1 FROM approvals WHERE approval_id=? AND task_id=? AND state='pending' AND expires_at>?",
          )
          .get(action.data.approval_id, action.data.task_id, Date.now());
        if (!active) return { outcome: 'expired-or-invalid' };
      }
      payload = {
        kind,
        text: '',
        sourceOutboxId: action.data.outbox_id,
        messageId: data.context.open_message_id,
        replyTo: null,
        taskId: action.data.task_id,
        action: action.data.action,
        approvalId: action.data.approval_id,
        choice: action.data.choice,
        projectKey: action.data.project_key,
        draftId: action.data.draft_id,
        page: action.data.page,
      };
      eventId = data.event_id;
      // Panel navigation is reusable; only redelivery of the same event is a duplicate.
      businessKey =
        action.data.panel_id ||
        [
          'panel',
          'projects',
          'tasks',
          'sessions',
          'result',
          'copy_id',
          'details',
          'select',
          'create_project',
          'projectless_sessions',
          'projectless_new',
          'back',
          'quota',
        ].includes(action.data.action)
          ? `panel-action:${eventId}`
          : `action:${data.action.value.gatewayNonce}`;
    }
    const db = this.store.db;
    return db
      .transaction(() => {
        const eventKey = digest(`${this.owner}:feishu:${kind}:${eventId}`);
        const now = Date.now();
        db.prepare(
          `INSERT OR IGNORE INTO inbox (inbox_id,event_key,source,method,payload,state,created_at,updated_at)
        VALUES (?,?,'feishu',?,?,'received',?,?)`,
        ).run(randomUUID(), eventKey, kind, JSON.stringify(payload), now, now);
        const inboxId = z
          .string()
          .parse(
            db.prepare('SELECT inbox_id FROM inbox WHERE event_key = ?').pluck().get(eventKey),
          );
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO feishu_commands
        (command_id,business_key,inbox_id,owner_key,chat_id,payload,state,created_at) VALUES (?,?,?,?,?,?,'received',?)`,
          )
          .run(
            randomUUID(),
            digest(`${this.owner}:${businessKey}`),
            inboxId,
            this.owner,
            this.credentials.testChatId,
            JSON.stringify(payload),
            now,
          );
        if (!inserted.changes)
          db.prepare(
            "UPDATE inbox SET state = 'processed' WHERE inbox_id = ? AND inbox_id NOT IN (SELECT inbox_id FROM feishu_commands WHERE state != 'processed')",
          ).run(inboxId);
        const commandId = z.string().parse(
          db
            .prepare('SELECT command_id FROM feishu_commands WHERE business_key = ?')
            .pluck()
            .get(digest(`${this.owner}:${businessKey}`)),
        );
        return { outcome: inserted.changes ? 'accepted' : 'duplicate', inboxId, commandId };
      })
      .immediate();
  }
  dispatcher() {
    return new EventDispatcher({ logger: silentLogger }).register({
      'application.bot.menu_v6': (data: unknown) => {
        this.receive('menu', data);
        return Promise.resolve();
      },
      'im.message.receive_v1': (data) => {
        this.receive('message', data);
        return Promise.resolve();
      },
      'card.action.trigger': (data: unknown) => {
        const result = this.receive('action', data);
        return Promise.resolve({
          toast: {
            type: result.outcome === 'accepted' ? 'success' : 'info',
            content:
              result.outcome === 'accepted'
                ? '操作已入队'
                : result.outcome === 'duplicate'
                  ? '操作已接收，请勿重复点击'
                  : 'reason' in result && result.reason === 'card-updating'
                    ? '卡片正在更新或核对中，请稍后再试'
                    : '按钮已失效或无权限',
          },
        });
      },
    });
  }
  recoverMessage(message: unknown) {
    const data = z
      .object({
        message_id: id,
        chat_id: id,
        msg_type: z.literal('text'),
        deleted: z.boolean().optional(),
        parent_id: id.optional(),
        sender: z.object({
          id,
          id_type: z.literal('open_id'),
          sender_type: z.literal('user'),
          tenant_key: id,
        }),
        body: z.object({ content: z.string() }),
      })
      .parse(message);
    if (
      data.deleted ||
      data.chat_id !== this.credentials.testChatId ||
      data.sender.id !== this.credentials.allowedOpenId ||
      data.sender.tenant_key !== this.credentials.tenantKey
    )
      throw new TaskError('补收消息身份不匹配');
    return this.receive('message', {
      event_id: `recovered:${data.message_id}`,
      app_id: this.credentials.appId,
      tenant_key: data.sender.tenant_key,
      sender: { sender_type: 'user', sender_id: { open_id: data.sender.id } },
      message: { ...data, message_type: 'text', chat_type: 'p2p', content: data.body.content },
    });
  }
}
