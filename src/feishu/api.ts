import { z } from 'zod';
import type { FeishuCredentials } from './credentials.js';

export type FailureOutcome = 'not-sent' | 'retryable-rejection' | 'permanent' | 'unknown';
export class FeishuApiError extends Error {
  override name = 'FeishuApiError';
  constructor(
    readonly outcome: FailureOutcome,
    readonly httpStatus = 0,
    readonly apiCode: number | null = null,
    readonly retryAfterMs = 0,
  ) {
    super(`Feishu ${outcome} (${httpStatus}/${apiCode ?? 'unavailable'})`);
  }
}
export const remoteMessageSchema = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  msg_type: z.string(),
  deleted: z.boolean().optional(),
  sender: z.object({
    id: z.string(),
    id_type: z.string(),
    sender_type: z.string(),
    tenant_key: z.string().optional(),
  }),
  body: z.object({ content: z.string() }),
  parent_id: z.string().optional(),
});
export type RemoteMessage = z.infer<typeof remoteMessageSchema>;
export class FeishuApi {
  private token: string | undefined;
  private expiresAt = 0;
  constructor(
    private readonly credentials: Pick<FeishuCredentials, 'appId' | 'appSecret'>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}
  private async request(
    path: string,
    method: string,
    data?: object,
    auth = true,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://open.feishu.cn/open-apis/${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
        redirect: 'error',
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
    } catch {
      throw new FeishuApiError(auth && method !== 'GET' ? 'unknown' : 'not-sent');
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new FeishuApiError(auth && method !== 'GET' ? 'unknown' : 'not-sent', response.status);
    }
    const parsed = z.object({ code: z.number().int() }).safeParse(raw);
    const code = parsed.success ? parsed.data.code : null;
    if (response.ok && code === 0) return raw;
    const reset = Number(
      response.headers.get('x-ogw-ratelimit-reset') ?? response.headers.get('retry-after') ?? 0,
    );
    const retryAfter = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 3600) * 1000 : 0;
    // Fixed SDK's high-level Channel helper misclassifies 99991400; use the documented frequency code.
    if (response.status === 429 || code === 99991400 || code === 230020)
      throw new FeishuApiError('retryable-rejection', response.status, code, retryAfter);
    if (response.status === 401 || response.status === 403) this.token = undefined;
    if (response.status >= 500 || code === null)
      throw new FeishuApiError(
        auth && method !== 'GET' ? 'unknown' : 'not-sent',
        response.status,
        code,
      );
    throw new FeishuApiError('permanent', response.status, code);
  }
  async prepare() {
    if (this.token && Date.now() < this.expiresAt) return;
    const result = z
      .object({ tenant_access_token: z.string().min(1), expire: z.number().positive() })
      .parse(
        await this.request(
          'auth/v3/tenant_access_token/internal',
          'POST',
          { app_id: this.credentials.appId, app_secret: this.credentials.appSecret },
          false,
        ),
      );
    this.token = result.tenant_access_token;
    this.expiresAt = Date.now() + Math.max(1, result.expire - 60) * 1000;
  }
  async create(chat: string, content: string, uuid: string): Promise<string> {
    // Caller prepares auth BEFORE marking the durable outbox entry as sending.
    const raw = await this.request('im/v1/messages?receive_id_type=chat_id', 'POST', {
      receive_id: chat,
      msg_type: 'interactive',
      content,
      uuid,
    });
    const parsed = z
      .object({ data: z.object({ message_id: z.string().regex(/^om_/) }) })
      .safeParse(raw);
    if (!parsed.success) throw new FeishuApiError('unknown');
    return parsed.data.data.message_id;
  }
  async update(message: string, content: string): Promise<string> {
    await this.request(`im/v1/messages/${encodeURIComponent(message)}`, 'PATCH', { content });
    return message;
  }
  async get(message: string): Promise<RemoteMessage> {
    await this.prepare();
    const raw = await this.request(
      `im/v1/messages/${encodeURIComponent(message)}?user_id_type=open_id`,
      'GET',
    );
    const items = z.object({ data: z.object({ items: z.array(remoteMessageSchema) }) }).parse(raw)
      .data.items;
    const match = items.find((item) => item.message_id === message);
    if (!match) throw new FeishuApiError('not-sent');
    return match;
  }
  async checkHistory(chat: string) {
    await this.prepare();
    const query = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chat,
      page_size: '1',
    });
    await this.request(`im/v1/messages?${query.toString()}`, 'GET');
  }
  async history(chat: string, since: number): Promise<RemoteMessage[]> {
    await this.prepare();
    const items: RemoteMessage[] = [],
      seen = new Set<string>();
    let cursor = '';
    const deadline = Date.now() + 20_000;
    for (let page = 0; page < 10; page++) {
      if (Date.now() >= deadline) throw new FeishuApiError('not-sent');
      const query = new URLSearchParams({
        container_id_type: 'chat',
        container_id: chat,
        start_time: String(Math.floor(since / 1000)),
        page_size: '50',
        sort_type: 'ByCreateTimeDesc',
        ...(cursor ? { page_token: cursor } : {}),
      });
      const result = z
        .object({
          data: z.object({
            items: z.array(remoteMessageSchema).default([]),
            has_more: z.boolean(),
            page_token: z.string().optional(),
          }),
        })
        .parse(await this.request(`im/v1/messages?${query.toString()}`, 'GET')).data;
      items.push(...result.items);
      if (!result.has_more) return items;
      if (!result.page_token || seen.has(result.page_token)) throw new FeishuApiError('not-sent');
      cursor = result.page_token;
      seen.add(cursor);
    }
    throw new FeishuApiError('not-sent'); // Do not turn a truncated scan into proof of absence.
  }
}
