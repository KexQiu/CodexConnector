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
  'projectless_sessions',
  'projectless_new',
  'back',
  'quota',
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
    'projectless_sessions',
    'projectless_new',
    'back',
    'quota',
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
  feedbackError: z.string().optional(),
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
  const first = store.db
    .prepare(
      'SELECT prompt FROM tasks WHERE conversation_id=? AND owner_key=? ORDER BY created_at,rowid LIMIT 1',
    )
    .pluck()
    .get(task.conversation_id, task.owner_key);
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
  enqueueNotice(store, owner, chat, key, { title, text, buttons, layout });
}

export function enqueueNotice(
  store: TaskStore,
  owner: string,
  chat: string,
  key: string,
  input: z.input<typeof noticeSchema>,
  view?: { id: string; version: number; parent: string | null; message: string | null },
) {
  const payload = noticeSchema.parse({ ...input, text: input.text.slice(0, 5000) });
  const id = randomUUID();
  store.db
    .prepare(
      `INSERT OR IGNORE INTO outbox
    (outbox_id,logical_key,task_id,card_version,payload,state,created_at,owner_key,chat_id,view_id,view_parent_id,message_id)
    VALUES (?,?,NULL,?,?,'pending',?,?,?,?,?,?)`,
    )
    .run(
      id,
      `feishu:reply:${key}`,
      view?.version ?? 1,
      JSON.stringify(payload),
      Date.now(),
      owner,
      chat,
      view?.id ?? id,
      view?.parent ?? null,
      view?.message ?? null,
    );
}
