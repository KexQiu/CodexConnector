import { createHash, randomUUID } from 'node:crypto';
import type { GatewayConfig } from '../config/schema.js';
import type { FeishuCredentials } from '../feishu/credentials.js';
import { canonicalDirectory } from '../projects/store.js';
import { ownerKey, type TaskStore } from '../tasks/store.js';
import { eventIdentity, notifyEventSchema } from './event.js';

/** Uses the existing inbox/outbox transaction; GUI notifications never create tasks or RPCs. */
export class NotifyInbox {
  constructor(
    readonly store: TaskStore,
    readonly config: GatewayConfig,
    readonly credentials: FeishuCredentials,
  ) {}
  receive(value: unknown) {
    const event = notifyEventSchema.parse(value);
    const policy = this.config.notify;
    if (!policy?.verifiedEvents.includes(event.type)) return { outcome: 'disabled' as const };
    const cwd = canonicalDirectory(event.cwd);
    // Exact configured root only: nested roots/worktrees are not implicit notification consent.
    const projects = this.config.projects.filter(
      (p) => policy.projectKeys.includes(p.key) && canonicalDirectory(p.root) === cwd,
    );
    if (projects.length !== 1) return { outcome: 'denied' as const };
    const project = projects[0]!;
    const owner = ownerKey({
      appId: this.credentials.appId,
      tenantKey: this.credentials.tenantKey,
      openId: this.credentials.allowedOpenId,
    });
    const key = `gui-notify:${owner}:${eventIdentity(event)}`;
    const db = this.store.db;
    return db
      .transaction(() => {
        if (db.prepare('SELECT 1 FROM inbox WHERE event_key=?').get(key))
          return { outcome: 'duplicate' as const };
        // Gateway-owned threads already have RPC-driven cards, including unbound/early turns.
        const owned = !!db
          .prepare('SELECT 1 FROM threads WHERE thread_id=?')
          .get(event['thread-id']);
        const now = Date.now();
        db.prepare(
          `INSERT INTO inbox
        (inbox_id,event_key,source,method,thread_id,turn_id,payload,state,created_at,updated_at)
        VALUES (?,?,'gui-notify',?,?,?,?,'processed',?,?)`,
        ).run(
          randomUUID(),
          key,
          event.type,
          event['thread-id'],
          event['turn-id'],
          JSON.stringify({
            projectKey: project.key,
            outcome: owned ? 'suppressed-rpc-owned' : 'queued',
            payloadHash: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
          }),
          now,
          now,
        );
        if (owned) return { outcome: 'suppressed-rpc-owned' as const };
        db.prepare(
          `INSERT INTO outbox
        (outbox_id,logical_key,task_id,card_version,payload,state,created_at,owner_key,chat_id)
        VALUES (?,?,NULL,1,?,'pending',?,?,?)`,
        ).run(
          randomUUID(),
          key,
          JSON.stringify({
            title: `桌面回合已结束 · ${project.name}`,
            text: `来源：桌面通知\n项目：${project.key}\nthread：${event['thread-id']}\nturn：${event['turn-id']}\n本通知不代表需求已验收。请在桌面查看或继续该会话。\n\n${event['last-assistant-message'].slice(-1800)}`,
          }),
          now,
          owner,
          this.credentials.testChatId,
        );
        return { outcome: 'queued' as const };
      })
      .immediate();
  }
}
