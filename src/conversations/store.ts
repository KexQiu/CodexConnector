import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { TaskError } from '../tasks/types.js';

export type ConversationScope = { kind: 'project'; projectKey: string } | { kind: 'projectless' };
export const conversationSchema = z.object({
  conversation_id: z.string(),
  owner_key: z.string(),
  chat_id: z.string().nullable(),
  scope_kind: z.enum(['project', 'projectless']),
  project_key: z.string().nullable(),
  cwd: z.string(),
  directory_device: z.number().nullable(),
  directory_inode: z.number().nullable(),
  thread_id: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const contextSchema = z.object({
  owner_key: z.string(),
  chat_id: z.string(),
  scope_kind: z.enum(['project', 'projectless']),
  project_key: z.string().nullable(),
  conversation_id: z.string().nullable(),
  task_id: z.string().nullable(),
  updated_at: z.number(),
});
export type ConversationContext = z.infer<typeof contextSchema>;
export function conversationScope(
  conversation: Pick<Conversation, 'scope_kind' | 'project_key'>,
): ConversationScope {
  if (conversation.scope_kind === 'projectless' && conversation.project_key === null)
    return { kind: 'projectless' };
  if (conversation.scope_kind === 'project' && conversation.project_key)
    return { kind: 'project', projectKey: conversation.project_key };
  throw new TaskError('会话范围数据无效');
}
export class ConversationStore {
  constructor(readonly db: Database.Database) {}
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE conversation_id=?').get(id);
    if (!row) throw new TaskError('会话不存在');
    return conversationSchema.parse(row);
  }
  owned(id: string, owner: string, chat?: string) {
    const conversation = this.get(id);
    if (conversation.owner_key !== owner || (chat !== undefined && conversation.chat_id !== chat))
      throw new TaskError('会话归属不匹配，请重新选择会话');
    return conversation;
  }
  create(input: {
    id?: string;
    owner: string;
    chat?: string;
    scope: ConversationScope;
    cwd: string;
    identity?: { dev: number; ino: number };
  }) {
    const id = input.id ?? randomUUID(),
      now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations (conversation_id,owner_key,chat_id,scope_kind,project_key,cwd,directory_device,directory_inode,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.owner,
        input.chat ?? null,
        input.scope.kind,
        input.scope.kind === 'project' ? input.scope.projectKey : null,
        input.cwd,
        input.identity?.dev ?? null,
        input.identity?.ino ?? null,
        now,
        now,
      );
    return this.get(id);
  }
  list(owner: string, chat: string, scope: ConversationScope) {
    return this.db
      .prepare(
        'SELECT * FROM conversations WHERE owner_key=? AND chat_id=? AND scope_kind=? AND project_key IS ? ORDER BY updated_at DESC,conversation_id DESC',
      )
      .all(owner, chat, scope.kind, scope.kind === 'project' ? scope.projectKey : null)
      .map((row) => conversationSchema.parse(row));
  }
  context(owner: string, chat: string) {
    const row = this.db
      .prepare('SELECT * FROM user_context WHERE owner_key=? AND chat_id=?')
      .get(owner, chat);
    return row ? contextSchema.parse(row) : null;
  }
  select(
    owner: string,
    chat: string,
    scope: ConversationScope,
    conversationId: string | null,
    taskId: string | null = null,
  ) {
    if (conversationId) {
      const conversation = this.owned(conversationId, owner, chat || undefined);
      if (
        conversation.scope_kind !== scope.kind ||
        conversation.project_key !== (scope.kind === 'project' ? scope.projectKey : null)
      )
        throw new TaskError('会话范围不匹配');
    }
    if (taskId) {
      const task = this.db
        .prepare('SELECT owner_key,conversation_id FROM tasks WHERE task_id=?')
        .get(taskId) as { owner_key: string; conversation_id: string } | undefined;
      if (!task || task.owner_key !== owner || task.conversation_id !== conversationId)
        throw new TaskError('任务与选中会话不匹配');
    }
    this.db
      .prepare(
        `INSERT INTO user_context (owner_key,chat_id,scope_kind,project_key,conversation_id,task_id,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(owner_key,chat_id) DO UPDATE SET scope_kind=excluded.scope_kind,project_key=excluded.project_key,conversation_id=excluded.conversation_id,task_id=excluded.task_id,updated_at=excluded.updated_at`,
      )
      .run(
        owner,
        chat,
        scope.kind,
        scope.kind === 'project' ? scope.projectKey : null,
        conversationId,
        taskId,
        Date.now(),
      );
  }
}
