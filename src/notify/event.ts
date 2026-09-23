import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const MAX_NOTIFY_BYTES = 256 * 1024;
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
// Strip unknown fields, especially input-messages. Never infer identity from a body hash.
export const notifyEventSchema = z.object({
  type: z.literal('agent-turn-complete'),
  'thread-id': id,
  'turn-id': id,
  cwd: z.string().min(1).max(4096).refine(isAbsolute),
  'last-assistant-message': z.string().max(MAX_NOTIFY_BYTES).default(''),
});
export type NotifyEvent = z.infer<typeof notifyEventSchema>;
export function eventIdentity(event: NotifyEvent) {
  return createHash('sha256')
    .update(JSON.stringify([event.type, event['thread-id'], event['turn-id']]))
    .digest('hex');
}
