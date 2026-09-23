import { z } from 'zod';
import { TASK_STATUSES } from '../domain/model.js';

export class TaskError extends Error {
  override name = 'TaskError';
}
export const taskRowSchema = z.object({
  task_id: z.string(),
  request_key: z.string(),
  fingerprint: z.string(),
  owner_key: z.string(),
  owner_json: z.string(),
  project_key: z.string(),
  cwd: z.string(),
  prompt: z.string(),
  thread_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  failure_phase: z.enum(['thread_start', 'turn_start', 'execution']).nullable(),
  error_code: z.string().nullable(),
  version: z.number(),
  notification_message_id: z.string().nullable(),
  waiting_approval: z.number(),
  waiting_input: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type StoredTask = z.infer<typeof taskRowSchema>;
export const durableTurnSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['inProgress', 'completed', 'failed', 'interrupted']),
  error: z.object({ codexErrorInfo: z.unknown() }).nullable().optional(),
  items: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = z
        .object({
          type: z.literal('agentMessage'),
          id: z.string(),
          text: z.string().max(1_048_576),
        })
        .safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
});
export type DurableTurn = z.infer<typeof durableTurnSchema>;
export const durableEventSchema = z.object({ threadId: z.string(), turn: durableTurnSchema });
export const itemEventSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.literal('agentMessage'),
    id: z.string(),
    text: z.string().max(1_048_576),
  }),
});
