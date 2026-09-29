import { z } from 'zod';
import type { TaskStore } from '../tasks/store.js';
import { TaskError } from '../tasks/types.js';
import { noticeSchema, enqueueNotice } from './conversation-ui.js';

const rowSchema = z.object({
  outbox_id: z.string(),
  task_id: z.string().nullable(),
  panel_id: z.string().nullable(),
  view_id: z.string().nullable(),
  view_parent_id: z.string().nullable(),
  card_version: z.number(),
  message_id: z.string().nullable(),
  payload: z.string(),
  state: z.string(),
});
export type CardView = z.infer<typeof rowSchema>;
export type Notice = z.infer<typeof noticeSchema>;

/** A view is an outbox revision chain. Only confirmed delivery changes reply routing. */
export class CardViews {
  constructor(
    private readonly store: TaskStore,
    private readonly owner: string,
    private readonly chat: string,
  ) {}
  get(id: string | null | undefined): CardView | null {
    if (!id) return null;
    const row = this.store.db
      .prepare('SELECT * FROM outbox WHERE outbox_id=? AND owner_key=? AND chat_id=?')
      .get(id, this.owner, this.chat);
    return row ? rowSchema.parse(row) : null;
  }
  reusable(row: CardView | null): row is CardView {
    return !!row && !row.task_id && !row.panel_id && row.state === 'delivered' && !!row.message_id;
  }
  current(row: CardView) {
    return !this.store.db
      .prepare(
        `SELECT 1 FROM outbox WHERE view_id=? AND card_version>? AND state NOT IN ('failed','superseded')`,
      )
      .get(row.view_id ?? row.outbox_id, row.card_version);
  }
  queue(
    key: string,
    payload: Notice,
    source: CardView | null,
    mode: 'navigate' | 'replace' | 'back' = 'navigate',
  ) {
    const db = this.store.db;
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM outbox WHERE logical_key=?').get(`feishu:reply:${key}`)) return;
      let view;
      if (this.reusable(source)) {
        if (!this.current(source)) throw new TaskError('卡片正在更新或已变化，请使用最新卡片。');
        const id = source.view_id ?? source.outbox_id;
        // Adopt pre-v12 navigation cards on their first valid click; never adopt task/panel cards.
        db.prepare('UPDATE outbox SET view_id=? WHERE outbox_id=? AND view_id IS NULL').run(
          id,
          source.outbox_id,
        );
        const version =
          z
            .number()
            .parse(
              db.prepare('SELECT max(card_version) FROM outbox WHERE view_id=?').pluck().get(id),
            ) + 1;
        const previous = noticeSchema.parse(JSON.parse(source.payload));
        const samePage = previous.title === payload.title;
        let parent = mode === 'replace' || samePage ? source.view_parent_id : source.outbox_id;
        if (mode === 'back') parent = this.get(source.view_parent_id)?.view_parent_id ?? null;
        // Completed/cancelled flows must not offer a return to an actionable draft/name prompt.
        if (
          ['需求已取消', '需求已提交', '项目已创建', '已退出本次项目创建'].includes(payload.title)
        )
          parent = null;
        view = { id, version, parent, message: source.message_id };
      }
      enqueueNotice(this.store, this.owner, this.chat, key, payload, view);
    }).immediate();
  }
  visible(message: string) {
    const row = this.store.db
      .prepare(
        `SELECT * FROM outbox WHERE task_id IS NULL AND panel_id IS NULL AND (view_id IS NOT NULL OR logical_key LIKE 'feishu:reply:%') AND message_id=? AND owner_key=? AND chat_id=?
       AND state='delivered' ORDER BY card_version DESC LIMIT 1`,
      )
      .get(message, this.owner, this.chat);
    return row ? rowSchema.parse(row) : null;
  }
}
