import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { CodexRpcClient, type RpcServerRequest } from '../src/codex/rpc-client.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

type Message = { id?: number | string; method?: string; result?: unknown; error?: unknown };
async function fixture(unix = false, initializeImmediately = true) {
  const directory = await mkdtemp('/private/tmp/cfg-rpc-test-');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const messages: Message[] = [];
  const connection = new Promise<WebSocket>((resolve) =>
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        const message = JSON.parse(bytes.toString('utf8')) as Message;
        messages.push(message);
        if (message.method === 'initialize' && initializeImmediately) initialize(ws, message.id);
      });
      resolve(ws);
    }),
  );
  // Register cleanup before listening so EPERM is also cleaned up.
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(directory, { recursive: true, force: true });
  });
  const listening = once(server, 'listening', { signal: AbortSignal.timeout(2_000) });
  if (unix) server.listen(join(directory, 'rpc.sock'));
  else server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address) throw new Error('No server address');
  const endpoint =
    typeof address === 'string' ? `unix://${address}` : `ws://127.0.0.1:${address.port}`;
  return { endpoint, connection, messages };
}

function initialize(socket: WebSocket, id: Message['id'] = 0) {
  socket.send(
    JSON.stringify({
      id,
      result: {
        userAgent: 'test',
        codexHome: '/test',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    }),
  );
}
async function waitFor(check: () => boolean) {
  await expect.poll(check, { timeout: 2_000, interval: 5 }).toBe(true);
}
function client(
  endpoint: string,
  options: Partial<ConstructorParameters<typeof CodexRpcClient>[0]> = {},
) {
  const rpc = new CodexRpcClient({ endpoint, timeoutMs: 2_000, ...options });
  cleanups.push(async () => {
    rpc.close();
    await Promise.resolve();
  });
  return rpc;
}

describe('Codex RPC wire contract (local fixture, not a real G2 pass)', () => {
  it.each([false, true])(
    'connects over ws/unix (%s), waits for initialize id 0 before initialized',
    async (unix) => {
      const f = await fixture(unix, false);
      const rpc = client(f.endpoint);
      await expect(rpc.request('thread/list', {}, z.unknown())).rejects.toMatchObject({
        outcome: 'not-sent',
      });
      const connected = rpc.connect();
      const socket = await f.connection;
      await waitFor(() => f.messages.length === 1);
      expect(f.messages).toMatchObject([{ id: 0, method: 'initialize' }]);
      expect(rpc.isReady).toBe(false);
      initialize(socket);
      await connected;
      await waitFor(() => f.messages.length === 2);
      expect(f.messages[1]).toEqual({ method: 'initialized' });
    },
  );

  it('routes out-of-order responses and events arriving before a request response', async () => {
    const f = await fixture();
    const notifications: string[] = [];
    const rpc = client(f.endpoint, {
      onNotification: (event) => {
        notifications.push(event.method);
      },
    });
    await rpc.connect();
    const socket = await f.connection;
    const first = rpc.request('thread/list', {}, z.object({ value: z.number() }));
    const second = rpc.request('thread/list', {}, z.object({ value: z.number() }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: {} }));
    socket.send(JSON.stringify({ id: 2, result: { value: 2 } }));
    socket.send(JSON.stringify({ id: 1, result: { value: 1 } }));
    expect(await second).toEqual({ value: 2 });
    expect(await first).toEqual({ value: 1 });
    expect(notifications).toEqual(['turn/completed']);
    expect(rpc.pendingRequestCount).toBe(0);
  });

  it('preserves numeric 0 vs string IDs, rejects double and stale approval replies', async () => {
    const f = await fixture();
    const requests: RpcServerRequest[] = [];
    const rpc = client(f.endpoint, {
      onServerRequest: (request) => {
        requests.push(request);
      },
    });
    await rpc.connect();
    const socket = await f.connection;
    for (const id of [0, '0', 1])
      socket.send(
        JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: {} }),
      );
    await waitFor(() => requests.length === 3);
    await rpc.respond(requests[0]!, { decision: 'decline' });
    await rpc.respond(requests[1]!, { decision: 'decline' });
    await expect(rpc.respond(requests[0]!, {})).rejects.toMatchObject({ outcome: 'not-sent' });
    await waitFor(() => f.messages.filter((m) => 'result' in m).length === 2);
    expect(f.messages.filter((m) => 'result' in m).map((m) => m.id)).toEqual([0, '0']);
    rpc.close();
    const next = client(f.endpoint);
    await next.connect();
    await expect(next.respond(requests[2]!, {})).rejects.toMatchObject({ outcome: 'not-sent' });
  });

  it('expires resolved server requests and explicitly rejects unsupported requests', async () => {
    const f = await fixture();
    const requests: RpcServerRequest[] = [];
    const rpc = client(f.endpoint, {
      onServerRequest: (request) => {
        requests.push(request);
      },
    });
    await rpc.connect();
    const socket = await f.connection;
    socket.send(JSON.stringify({ id: 4, method: 'item/tool/requestUserInput', params: {} }));
    socket.send(
      JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 4 } }),
    );
    await waitFor(() => requests.length === 1);
    await expect(rpc.respond(requests[0]!, {})).rejects.toMatchObject({ outcome: 'not-sent' });
    rpc.close();
    const other = await fixture();
    const defaultClient = client(other.endpoint);
    await defaultClient.connect();
    (await other.connection).send(
      JSON.stringify({ id: 'unsupported', method: 'item/tool/call', params: {} }),
    );
    await waitFor(() => other.messages.some((m) => m.id === 'unsupported'));
    expect(other.messages.find((m) => m.id === 'unsupported')).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('marks pending requests unknown on disconnect without replaying on a new connection', async () => {
    const f = await fixture();
    const rpc = client(f.endpoint);
    await rpc.connect();
    const pending = rpc.request('thread/list', {}, z.unknown()).catch((error: unknown) => error);
    await waitFor(() => f.messages.some((m) => m.method === 'thread/list'));
    (await f.connection).terminate();
    expect(await pending).toMatchObject({ outcome: 'unknown' });
    expect(rpc.pendingRequestCount).toBe(0);
    const next = client(f.endpoint);
    await next.connect();
    expect(next.connectionEpoch).not.toEqual(rpc.connectionEpoch);
    expect(f.messages.filter((m) => m.method === 'thread/list')).toHaveLength(1);
  });

  it('handles timeout and late response without consuming another response', async () => {
    const f = await fixture();
    const rpc = client(f.endpoint);
    await rpc.connect();
    await expect(rpc.request('thread/list', {}, z.unknown(), 20)).rejects.toMatchObject({
      outcome: 'unknown',
    });
    const pending = rpc.request('thread/list', {}, z.object({ value: z.number() }));
    const socket = await f.connection;
    socket.send(JSON.stringify({ id: 1, result: { value: -1 } }));
    socket.send(JSON.stringify({ id: 2, result: { value: 2 } }));
    expect(await pending).toEqual({ value: 2 });
  });

  it('distinguishes rejected RPC from an unknown result and does not log remote error text', async () => {
    const f = await fixture();
    const rpc = client(f.endpoint);
    await rpc.connect();
    const rejected = rpc.request('thread/list', {}, z.unknown()).catch((error: unknown) => error);
    (await f.connection).send(
      JSON.stringify({ id: 1, error: { code: -32602, message: 'secret input' } }),
    );
    const error: unknown = await rejected;
    expect(error).toMatchObject({ name: 'RpcRejectedError', code: -32602 });
    expect(String(error)).not.toContain('secret');
    const invalid = rpc
      .request('thread/list', {}, z.object({ data: z.array(z.unknown()) }))
      .catch((error: unknown) => error);
    (await f.connection).send(JSON.stringify({ id: 2, result: {} }));
    expect(await invalid).toMatchObject({ outcome: 'unknown' });
  });

  it.each(['not-json', '{"id":1}', '{"id":1,"result":{},"error":{"code":1,"message":"x"}}'])(
    'fails closed on invalid wire input %s',
    async (payload) => {
      const f = await fixture();
      const rpc = client(f.endpoint);
      await rpc.connect();
      const pending = rpc.request('thread/list', {}, z.unknown()).catch((error: unknown) => error);
      (await f.connection).send(payload);
      expect(await pending).toMatchObject({ outcome: 'unknown' });
      expect(rpc.isReady).toBe(false);
    },
  );
});
