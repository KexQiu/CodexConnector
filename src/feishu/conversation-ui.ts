import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TaskStore } from '../tasks/store.js';
import type { StoredTask } from '../tasks/types.js';
import { cardLayoutSchema, type CardLayout } from './card-layout.js';

export const uiActionSchema = z.enum([
  'refresh',
  'select',
  'approval',
  'interrupt',
  'new_topic',
  'details',
  'project',
  'projects',
  'cancel_draft',
  'panel',
  'sessions',
  'result',
  'copy_id',
  'tasks',
  'create_project',
  'cancel_project',
]);
export const noticeButtonSchema = z.object({
  label: z.string().min(1).max(80),
  action: z.enum([
    'project',
    'projects',
    'cancel_draft',
    'select',
    'new_topic',
    'details',
    'panel',
    'sessions',
    'result',
    'copy_id',
    'tasks',
    'create_project',
    'cancel_project',
  ]),
  choice: z
    .enum(['refresh', 'new_topic', 'details', 'gateway', 'desktop'])
    .nullable()
    .default(null),
  taskId: z.string().nullable().default(null),
  projectKey: z.string().nullable().default(null),
  draftId: z.string().nullable().default(null),
  page: z.number().int().min(0).nullable().default(null),
  expiresAt: z.number(),
});
export const noticeSchema = z.object({
  title: z.string(),
  text: z.string(),
  buttons: z.array(noticeButtonSchema).max(12).default([]),
  layout: cardLayoutSchema.optional(),
});
export type NoticeButton = z.input<typeof noticeButtonSchema>;
export const DRAFT_TTL = 24 * 3600_000;
export const PROJECT_PAGE_SIZE = 6;

export function shortText(text: string, limit = 60) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/** Stable topic title across turns; no model or extra RPC is needed. */
export function topicTitle(store: TaskStore, task: StoredTask) {
  const first = task.thread_id
    ? store.db
        .prepare(
          'SELECT prompt FROM tasks WHERE thread_id=? AND owner_key=? ORDER BY created_at,rowid LIMIT 1',
        )
        .pluck()
        .get(task.thread_id, task.owner_key)
    : null;
  return shortText(typeof first === 'string' ? first : task.prompt) || '未命名话题';
}

export function queueNotice(
  store: TaskStore,
  owner: string,
  chat: string,
  key: string,
  title: string,
  text: string,
  buttons: NoticeButton[] = [],
  layout?: CardLayout,
) {
  const payload = noticeSchema.parse({ title, text: text.slice(0, 5000), buttons, layout });
  store.db
    .prepare(
      `INSERT OR IGNORE INTO outbox
    (outbox_id,logical_key,task_id,card_version,payload,state,created_at,owner_key,chat_id)
    VALUES (?,?,NULL,1,?,'pending',?,?,?)`,
    )
    .run(randomUUID(), `feishu:reply:${key}`, JSON.stringify(payload), Date.now(), owner, chat);
}
