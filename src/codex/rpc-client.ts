import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { isPrivateEndpoint } from '../config/schema.js';
import type { ClientRequest, RequestId, RequestParams } from './protocol.js';

const requestId = z.union([z.string(), z.number().int().safe()]);
const envelope = z.object({
  id: requestId.optional(),
  method: z.string().min(1).optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string() }).optional(),
});
const initializeResult = z.object({
  userAgent: z.string(),
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
});

export interface RpcNotification {
  readonly connectionEpoch: string;
  readonly method: string;
  readonly params: unknown;
}

export interface RpcServerRequest extends RpcNotification {
  readonly id: RequestId;
}

/** `unknown` means bytes may have reached the server. Never blindly replay it. */
export class RpcTransportError extends Error {
  override name = 'RpcTransportError';
  constructor(
    message: string,
    readonly outcome: 'not-sent' | 'unknown',
  ) {
    super(message);
  }
}

export class RpcRejectedError extends Error {
  override name = 'RpcRejectedError';
  constructor(
    readonly method: string,
    readonly code: number,
    readonly remoteMessage: string,
  ) {
    // The remote message may contain prompts, paths or provider credentials.
    super(`RPC ${method} rejected (${code})`);
  }
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcClientOptions {
  endpoint: string;
  timeoutMs?: number;
  onNotification?: (notification: RpcNotification) => void;
  onServerRequest?: (request: RpcServerRequest) => void | Promise<void>;
  onDisconnect?: () => void;
  /** Synchronous durable intent hook. A failure prevents any bytes for this request. */
  beforeRequest?: (request: { method: string; id: RequestId; connectionEpoch: string }) => void;
}

/** One instance owns exactly one connection. Reconnect with a fresh instance/epoch.
 * This layer does not retry requests or decide approvals, and never owns the server.
 */
export class CodexRpcClient {
  readonly connectionEpoch = randomUUID();
  private socket: WebSocket | undefined;
  private state: 'new' | 'connecting' | 'ready' | 'closed' = 'new';
  /** Local fixed diagnostic only; never includes wire payloads or credentials. */
  disconnectReason: string | undefined;
  private sequence = 0;
  private readonly pending = new Map<RequestId, Pending>();
  private readonly serverRequests = new Map<RequestId, RpcServerRequest>();
  private readonly timeoutMs: number;

  constructor(private readonly options: RpcClientOptions) {
    if (!isPrivateEndpoint(options.endpoint)) throw new Error('RPC endpoint must be local');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Invalid RPC timeout');
    }
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  async connect(): Promise<z.infer<typeof initializeResult>> {
    if (this.state !== 'new') throw new Error('Create a new client for each connection');
    this.state = 'connecting';
    const endpoint = this.options.endpoint.startsWith('unix://')
      ? `ws+unix://${this.options.endpoint.slice('unix://'.length)}:/`
      : this.options.endpoint;
    try {
      const socket = new WebSocket(endpoint, {
        handshakeTimeout: this.timeoutMs,
        maxPayload: 16 * 1024 * 1024,
        followRedirects: false,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.on('message', (data, binary) => {
        if (binary) return this.fail('Unexpected binary RPC message');
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        this.receive(bytes.toString('utf8'));
      });
      socket.on('error', () => this.fail('RPC transport error'));
      socket.on('close', () => this.fail('RPC connection closed'));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () =>
          reject(new RpcTransportError('RPC connection failed', 'not-sent')),
        );
        socket.once('close', () =>
          reject(new RpcTransportError('RPC connection closed', 'not-sent')),
        );
      });
      const result = initializeResult.parse(
        await this.sendRequest(
          'initialize',
          {
            clientInfo: {
              name: 'codex_feishu_gateway',
              title: 'Codex Feishu Gateway',
              version: '0.0.0',
            },
            capabilities: { experimentalApi: true, requestAttestation: false },
          },
          this.timeoutMs,
        ),
      );
      // initialize is request 0. Do not send initialized until its response succeeded.
      await this.send({ method: 'initialized' });
      if (this.state !== 'connecting')
        throw new RpcTransportError('Handshake interrupted', 'unknown');
      this.state = 'ready';
      return result;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async request<Method extends Exclude<ClientRequest['method'], 'initialize'>, Result>(
    method: Method,
    params: RequestParams<Method>,
    schema: z.ZodType<Result>,
    timeoutMs = this.timeoutMs,
  ): Promise<Result> {
    if (this.state !== 'ready') throw new RpcTransportError('RPC is not initialized', 'not-sent');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid RPC timeout');
    const result = await this.sendRequest(method, params, timeoutMs);
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new RpcTransportError(`Invalid ${method} response`, 'unknown');
    return parsed.data;
  }

  async respond(request: RpcServerRequest, result: unknown): Promise<void> {
    this.consumeServerRequest(request);
    await this.send({ id: request.id, result });
  }
  hasServerRequest(request: RpcServerRequest): boolean {
    return (
      request.connectionEpoch === this.connectionEpoch &&
      this.state === 'ready' &&
      this.serverRequests.get(request.id) === request
    );
  }

  async reject(request: RpcServerRequest, code = -32601): Promise<void> {
    this.consumeServerRequest(request);
    await this.send({
      id: request.id,
      error: { code, message: 'Request not supported by this client' },
    });
  }

  private consumeServerRequest(request: RpcServerRequest): void {
    if (
      request.connectionEpoch !== this.connectionEpoch ||
      this.state === 'closed' ||
      this.serverRequests.get(request.id) !== request
    ) {
      throw new RpcTransportError('Server request is stale or already answered', 'not-sent');
    }
    this.serverRequests.delete(request.id);
  }

  close(): void {
    this.fail('RPC client closed');
  }

  private fail(message: string): void {
    if (this.state === 'closed') return;
    this.disconnectReason = message;
    this.state = 'closed';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcTransportError(message, 'unknown'));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.socket?.terminate();
    this.options.onDisconnect?.();
  }

  private async send(payload: unknown): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.state === 'closed') {
      throw new RpcTransportError('RPC connection is not open', 'not-sent');
    }
    if (socket.bufferedAmount > 4 * 1024 * 1024) {
      throw new RpcTransportError('RPC send buffer full', 'not-sent');
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => {
        if (error) reject(new RpcTransportError('RPC send failed', 'unknown'));
        else resolve();
      });
    });
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.pending.size >= 128) {
      return Promise.reject(new RpcTransportError('Too many pending RPC requests', 'not-sent'));
    }
    const id = this.sequence++;
    try {
      this.options.beforeRequest?.({ method, id, connectionEpoch: this.connectionEpoch });
    } catch {
      return Promise.reject(new RpcTransportError('Request intent was not persisted', 'not-sent'));
    }
    return new Promise((resolve, reject: (error: Error) => void) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTransportError(`RPC ${method} timed out`, 'unknown'));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          error instanceof Error ? error : new RpcTransportError('RPC send failed', 'unknown'),
        );
      });
    });
  }

  private receive(text: string): void {
    if (this.state === 'closed') return;
    try {
      const parsed: unknown = JSON.parse(text);
      const message = envelope.parse(parsed);
      const hasId = Object.hasOwn(message, 'id');
      const hasResult = Object.hasOwn(message, 'result');
      const hasError = Object.hasOwn(message, 'error');
      if (message.method !== undefined) {
        if (hasResult || hasError) return this.fail('Invalid RPC method envelope');
        if (hasId && message.id !== undefined) {
          if (this.serverRequests.has(message.id) || this.serverRequests.size >= 128) {
            return this.fail('Duplicate or excessive server request');
          }
          const request = Object.freeze({
            connectionEpoch: this.connectionEpoch,
            id: message.id,
            method: message.method,
            params: message.params,
          });
          this.serverRequests.set(request.id, request);
          const handled = this.options.onServerRequest
            ? this.options.onServerRequest(request)
            : this.reject(request);
          Promise.resolve(handled).catch(() => this.fail('Server request handler failed'));
        } else {
          if (message.method === 'serverRequest/resolved') {
            const resolved = z.object({ requestId }).parse(message.params);
            this.serverRequests.delete(resolved.requestId);
          }
          this.options.onNotification?.({
            connectionEpoch: this.connectionEpoch,
            method: message.method,
            params: message.params,
          });
        }
        return;
      }
      if (!hasId || message.id === undefined || hasResult === hasError) {
        return this.fail('Invalid RPC response envelope');
      }
      const pending = this.pending.get(message.id);
      if (!pending) return; // Late response after timeout: never replay or mutate another request.
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new RpcRejectedError(pending.method, message.error.code, message.error.message),
        );
      else pending.resolve(message.result);
    } catch {
      this.fail('Invalid RPC message or event handler failure');
    }
  }
}
