import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { connectClient, journal, ProbeBlocked } from '../scripts/gates/probe-support.mjs';

describe('G2 probe regression coverage (fixture only)', () => {
  it('does not mark the successful connection disconnected after an earlier handshake retry', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let connections = 0;
    let client;
    wss.on('connection', (socket) => {
      connections++;
      if (connections === 1) return socket.terminate();
      socket.on('message', (data) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        const request = JSON.parse(bytes.toString('utf8'));
        if (request.method === 'initialize')
          socket.send(
            JSON.stringify({
              id: request.id,
              result: {
                userAgent: 'test',
                codexHome: '/test',
                platformFamily: 'unix',
                platformOs: 'macos',
              },
            }),
          );
        if (request.method === 'initialized')
          socket.send(JSON.stringify({ method: 'turn/completed', params: { marker: true } }));
      });
    });
    try {
      const listening = once(server, 'listening', { signal: AbortSignal.timeout(2_000) });
      server.listen(0, '127.0.0.1');
      await listening;
      const events = journal();
      client = await connectClient(
        { endpoint: `ws://127.0.0.1:${server.address().port}`, exited: () => false },
        events,
      );
      expect(connections).toBe(2);
      expect(await events.wait('turn/completed', (params) => params.marker, 1_000)).toEqual({
        marker: true,
      });
    } finally {
      client?.close();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      if (server.listening)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
  });

  it('does not lose an event delivered before the waiter starts, and excludes text deltas', async () => {
    const events = journal();
    events.onNotification({
      method: 'item/agentMessage/delta',
      params: { delta: 'private content' },
    });
    events.onNotification({ method: 'turn/completed', params: { marker: true } });
    expect(await events.wait('turn/completed', (params) => params.marker, 50)).toEqual({
      marker: true,
    });
    expect(events.entries).toHaveLength(1);
  });

  it('bounds a missing-event wait and detects a closed connection', async () => {
    const events = journal();
    await expect(events.wait('turn/completed', () => true, 10)).rejects.toBeInstanceOf(
      ProbeBlocked,
    );
    events.onDisconnect();
    await expect(events.wait('turn/completed', () => true, 50)).rejects.toThrow('Disconnected');
  });
});
