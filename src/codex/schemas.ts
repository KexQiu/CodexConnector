import { z } from 'zod';

/** Validate only consumed fields. Additional protocol fields are deliberately discarded. */
export const turnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
  items: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
  error: z.object({ message: z.string() }).passthrough().nullable(),
});
export const threadSchema = z.object({
  id: z.string().min(1),
  cwd: z.string(),
  name: z.string().nullable().optional(),
  preview: z.string().optional(),
  updatedAt: z.number().finite().optional(),
  historyMode: z.enum(['legacy', 'paginated']),
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  status: z.object({ type: z.enum(['notLoaded', 'idle', 'active', 'systemError']) }),
  turns: z.array(turnSchema),
});
export const threadResultSchema = z.object({
  thread: threadSchema,
  approvalPolicy: z.unknown().optional(),
  sandbox: z.unknown().optional(),
});
export const threadListSchema = z.object({
  data: z.array(threadSchema),
  nextCursor: z.string().nullable(),
});
export const turnResultSchema = z.object({ turn: turnSchema });
export const turnsPageSchema = z.object({
  data: z.array(turnSchema),
  nextCursor: z.string().nullable(),
});
export const turnEventSchema = z.object({ threadId: z.string(), turn: turnSchema });
export const steerResultSchema = z.object({ turnId: z.string() });
export const emptyResultSchema = z.object({});
export const commandApprovalSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  command: z.string(),
  cwd: z.string(),
  availableDecisions: z.array(z.unknown()).nullish(),
});
