import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const count = z.number().int().nonnegative().safe();
const tokens = z.object({
  totalTokens: count,
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
  reasoningOutputTokens: count,
});
export const usageSchema = z.object({
  total: tokens,
  last: tokens,
  modelContextWindow: count.nullable(),
});
const diskTokens = z
  .object({
    total_tokens: count,
    input_tokens: count,
    cached_input_tokens: count,
    output_tokens: count,
    reasoning_output_tokens: count,
  })
  .transform((t) => ({
    totalTokens: t.total_tokens,
    inputTokens: t.input_tokens,
    cachedInputTokens: t.cached_input_tokens,
    outputTokens: t.output_tokens,
    reasoningOutputTokens: t.reasoning_output_tokens,
  }));
const diskUsage = z
  .object({
    total_token_usage: diskTokens,
    last_token_usage: diskTokens,
    model_context_window: count.nullable(),
  })
  .transform((u) => ({
    total: u.total_token_usage,
    last: u.last_token_usage,
    modelContextWindow: u.model_context_window,
  }));
export interface HistoricalUsage {
  status: 'ok' | 'empty' | 'unavailable' | 'unsupported' | 'truncated';
  usage?: z.infer<typeof usageSchema>;
  usageAt?: number;
  compactedAt?: number;
}
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;

/** Compatibility adapter for local rollouts. No transcript, path, or account data is returned.
 * Only call for an owned thread with its RPC-provided path and initialize-provided Codex home.
 * Reading a snapshot never resumes the thread or takes its writer lock.
 */
export async function readHistoricalUsage(
  codexHome: string | undefined,
  path: string | null | undefined,
  threadId: string,
  cwd: string,
): Promise<HistoricalUsage> {
  if (!codexHome || !path || !isAbsolute(path)) return { status: 'unavailable' };
  try {
    const home = await realpath(codexHome);
    const file = await realpath(path);
    if (file !== resolve(path) || !basename(file).endsWith(`-${threadId}.jsonl`))
      return { status: 'unavailable' };
    const parts = relative(home, file).split(sep);
    if (!['sessions', 'archived_sessions'].includes(parts[0] ?? '') || parts.includes('..'))
      return { status: 'unavailable' };
    // Reject a redirected sessions root as well as symlinked files/parents.
    if ((await realpath(join(home, parts[0]!))) !== join(home, parts[0]!))
      return { status: 'unavailable' };
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1)
        return { status: 'unavailable' };
      const head = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
      const first = await handle.read(head, 0, head.length, 0);
      const newline = head.subarray(0, first.bytesRead).indexOf(10);
      if (newline < 0) return { status: 'unsupported' };
      const meta = z
        .object({
          type: z.literal('session_meta'),
          payload: z.object({ id: z.literal(threadId), cwd: z.string() }),
        })
        .safeParse(JSON.parse(head.subarray(0, newline).toString('utf8')));
      if (!meta.success || (await realpath(meta.data.payload.cwd)) !== (await realpath(cwd)))
        return { status: 'unavailable' };
      const offset = Math.max(0, stat.size - TAIL_BYTES);
      const tail = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
      const read = await handle.read(tail, 0, tail.length, offset);
      if (read.bytesRead !== tail.length || (await handle.stat()).size < stat.size)
        return { status: 'unavailable' };
      const lines = tail.toString('utf8').split('\n');
      if (offset) lines.shift(); // The first/last line may have been cut during append.
      lines.pop();
      const result: HistoricalUsage = { status: offset ? 'truncated' : 'empty' };
      for (const line of lines) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          // A broken complete line may hide a compaction boundary. Do not reuse older usage.
          delete result.usage;
          delete result.usageAt;
          result.status = 'unsupported';
          continue;
        }
        const event = z
          .object({ timestamp: z.string(), type: z.string(), payload: z.unknown() })
          .safeParse(raw);
        if (!event.success) continue;
        const at = Date.parse(event.data.timestamp);
        if (!Number.isSafeInteger(at) || at < 0 || at > Date.now() + 60_000) continue;
        if (event.data.type === 'compacted') {
          result.compactedAt = Math.max(result.compactedAt ?? 0, at);
          if (at >= (result.usageAt ?? 0)) {
            delete result.usage;
            delete result.usageAt;
            result.status = 'empty';
          }
        } else if (event.data.type === 'event_msg') {
          const token = z
            .object({ type: z.literal('token_count'), info: z.unknown() })
            .safeParse(event.data.payload);
          if (!token.success || token.data.info == null) continue;
          const info = diskUsage.safeParse(token.data.info);
          if (!info.success) {
            delete result.usage;
            delete result.usageAt;
            result.status = 'unsupported';
          } else if (at > (result.compactedAt ?? 0) && at >= (result.usageAt ?? 0)) {
            result.usage = info.data;
            result.usageAt = at;
            result.status = 'ok';
          }
        }
      }
      return result;
    } finally {
      await handle.close();
    }
  } catch {
    return { status: 'unavailable' };
  }
}
