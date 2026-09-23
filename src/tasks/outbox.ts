import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { TaskError } from './types.js';

const rowSchema = z.object({
  outbox_id: z.string(),
  task_id: z.string().nullable(),
  panel_id: z.string().nullable().default(null),
  card_version: z.number(),
  payload: z.string(),
  state: z.enum(['pending', 'claimed', 'sending', 'delivered', 'failed', 'unknown', 'superseded']),
  message_id: z.string().nullable(),
  operation: z.enum(['send', 'update']).nullable(),
  claim_token: z.string().nullable(),
  lease_until: z.number().nullable(),
  attempts: z.number(),
  owner_key: z.string().nullable(),
  chat_id: z.string().nullable(),
  wire_content: z.string().nullable(),
  sent_at: z.number().nullable(),
  reconcile_at: z.number(),
  created_at: z.number(),
});
export type OutboxClaim = z.infer<typeof rowSchema>;

/** Transport-free in M2. A sender must markSending BEFORE its network mutation. */
export class OutboxStore {
  constructor(private readonly db: Database.Database) {}
  recoverExpired(now = Date.now()) {
    this.db
      .transaction(() => {
        this.db
          .prepare(
            "UPDATE outbox SET state = 'pending', claim_token = NULL, lease_until = NULL WHERE state = 'claimed' AND lease_until <= ?",
          )
          .run(now);
        this.db
          .prepare(
            "UPDATE outbox SET state = 'unknown', error_code = 'send_outcome_unknown', claim_token = NULL, lease_until = NULL WHERE state = 'sending' AND lease_until <= ?",
          )
          .run(now);
      })
      .immediate();
  }
  claim(
    now = Date.now(),
    leaseMs = 30_000,
    scope?: { owner: string; chat: string },
  ): OutboxClaim | null {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TaskError('无效 outbox 租约');
    return this.db
      .transaction(() => {
        this.recoverExpired(now);
        this.db
          .prepare(
            `UPDATE outbox AS older SET state = 'superseded' WHERE state = 'pending' AND EXISTS
        (SELECT 1 FROM outbox AS newer WHERE newer.task_id = older.task_id AND newer.card_version > older.card_version)`,
          )
          .run();
        const candidate = this.db
          .prepare(
            `SELECT * FROM outbox AS candidate WHERE state = 'pending' AND next_retry_at <= ? AND (? IS NULL OR (owner_key = ? AND chat_id = ?)) AND NOT EXISTS
        (SELECT 1 FROM outbox AS active WHERE (active.task_id = candidate.task_id OR active.panel_id = candidate.panel_id) AND active.state IN ('claimed','sending','unknown'))
        ORDER BY created_at, rowid LIMIT 1`,
          )
          .get(now, scope?.owner ?? null, scope?.owner ?? null, scope?.chat ?? null);
        if (!candidate) return null;
        const row = rowSchema.parse(candidate);
        const messageId = row.panel_id
          ? row.message_id
          : this.db
              .prepare('SELECT notification_message_id FROM tasks WHERE task_id = ?')
              .pluck()
              .get(row.task_id);
        const token = randomUUID();
        this.db
          .prepare(
            "UPDATE outbox SET state = 'claimed', claim_token = ?, lease_until = ?, attempts = attempts + 1, message_id = ?, operation = ? WHERE outbox_id = ?",
          )
          .run(
            token,
            now + leaseMs,
            typeof messageId === 'string' ? messageId : null,
            typeof messageId === 'string' ? 'update' : 'send',
            row.outbox_id,
          );
        return rowSchema.parse(
          this.db.prepare('SELECT * FROM outbox WHERE outbox_id = ?').get(row.outbox_id),
        );
      })
      .immediate();
  }
  private completePanel(row: OutboxClaim, messageId: string) {
    if (!row.panel_id) return;
    this.db
      .prepare(
        `UPDATE feishu_panels SET message_id=?,
      message_created_at=CASE WHEN ?='send' THEN ? ELSE message_created_at END
      WHERE panel_id=? AND owner_key=? AND chat_id=?`,
      )
      .run(
        messageId,
        row.operation,
        row.sent_at ?? Date.now(),
        row.panel_id,
        row.owner_key,
        row.chat_id,
      );
    this.db
      .prepare(
        `UPDATE feishu_actions SET expires_at=0 WHERE outbox_id IN
      (SELECT outbox_id FROM outbox WHERE panel_id=?) AND message_id IS NOT NULL AND message_id!=?`,
      )
      .run(row.panel_id, messageId);
  }
  markSending(token: string, now = Date.now()) {
    const changed = this.db
      .prepare(
        "UPDATE outbox SET state = 'sending', sent_at = COALESCE(sent_at, ?) WHERE claim_token = ? AND state = 'claimed' AND lease_until > ?",
      )
      .run(now, token, now).changes;
    if (changed !== 1) throw new TaskError('outbox claim 已失效');
  }
  complete(token: string, messageId: string) {
    if (!messageId) throw new TaskError('必须提供已确认的远端消息 ID');
    this.db
      .transaction(() => {
        const row = rowSchema.parse(
          this.db
            .prepare("SELECT * FROM outbox WHERE claim_token = ? AND state = 'sending'")
            .get(token),
        );
        if (row.operation === 'update' && row.message_id !== messageId)
          throw new TaskError('远端消息 ID 不匹配');
        this.db
          .prepare(
            "UPDATE outbox SET state = 'delivered', message_id = ?, claim_token = NULL, lease_until = NULL WHERE outbox_id = ?",
          )
          .run(messageId, row.outbox_id);
        this.db
          .prepare('UPDATE tasks SET notification_message_id = ? WHERE task_id = ?')
          .run(messageId, row.task_id);
        this.db
          .prepare('UPDATE feishu_actions SET message_id = ? WHERE outbox_id = ?')
          .run(messageId, row.outbox_id);
        this.completePanel(row, messageId);
      })
      .immediate();
  }
  fail(
    token: string,
    outcome: 'not-sent' | 'retryable-rejection' | 'permanent' | 'unknown',
    now = Date.now(),
    retryAfterMs = 0,
  ) {
    this.db
      .transaction(() => {
        const row = rowSchema.parse(
          this.db
            .prepare(
              "SELECT * FROM outbox WHERE claim_token = ? AND state IN ('claimed','sending')",
            )
            .get(token),
        );
        const state =
          outcome === 'unknown' ? 'unknown' : outcome === 'permanent' ? 'failed' : 'pending';
        const retryAt =
          now + Math.max(retryAfterMs, Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6)));
        this.db
          .prepare(
            'UPDATE outbox SET state = ?, error_code = ?, next_retry_at = ?, claim_token = NULL, lease_until = NULL WHERE outbox_id = ?',
          )
          .run(state, outcome, retryAt, row.outbox_id);
      })
      .immediate();
  }
  /** Only after the transport adapter independently verifies the remote receipt. */
  recordVerifiedReceipt(id: string, messageId: string) {
    if (!messageId) throw new TaskError('缺少远端核对结果');
    this.db
      .transaction(() => {
        const row = rowSchema.parse(
          this.db.prepare("SELECT * FROM outbox WHERE outbox_id = ? AND state = 'unknown'").get(id),
        );
        if (row.operation === 'update' && row.message_id !== messageId)
          throw new TaskError('远端核对消息不匹配');
        this.db
          .prepare(
            "UPDATE outbox SET state = 'delivered', message_id = ?, error_code = NULL WHERE outbox_id = ?",
          )
          .run(messageId, id);
        this.db
          .prepare('UPDATE tasks SET notification_message_id = ? WHERE task_id = ?')
          .run(messageId, row.task_id);
        this.db
          .prepare('UPDATE feishu_actions SET message_id = ? WHERE outbox_id = ?')
          .run(messageId, id);
        this.completePanel(row, messageId);
      })
      .immediate();
  }
}
