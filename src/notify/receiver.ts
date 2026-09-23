import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayConfig } from '../config/schema.js';
import { privateDirectory, readPrivate } from '../service/files.js';
import { TaskError } from '../tasks/types.js';
import { MAX_NOTIFY_BYTES, eventIdentity, notifyEventSchema } from './event.js';
import type { NotifyInbox } from './inbox.js';

export class NotifyReceiver {
  private server: Server | undefined;
  private nextDrain = 0;
  private errorCode: string | null = null;
  private readonly token: string;
  constructor(
    readonly policy: NonNullable<GatewayConfig['notify']>,
    readonly inbox: NotifyInbox,
  ) {
    this.token = readPrivate(policy.tokenFile, 256).trim();
    if (!/^[a-f0-9]{64}$/.test(this.token))
      throw new TaskError('notify token 必须为 32 字节随机 hex');
    privateDirectory(policy.spoolDir);
  }
  status() {
    return { listening: this.server?.listening ?? false, errorCode: this.errorCode };
  }
  async start() {
    const server = createServer((request, response) => {
      const reply = (status: number, value: object) => {
        response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify(value));
      };
      if (request.method !== 'POST' || request.url !== '/notify') {
        reply(404, { error: 'not-found' });
        return;
      }
      const authorization = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.token}`);
      if (
        request.headers.origin ||
        authorization.length !== expected.length ||
        !timingSafeEqual(authorization, expected)
      ) {
        reply(403, { error: 'denied' });
        return;
      }
      if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        reply(415, { error: 'json-required' });
        return;
      }
      let size = 0,
        rejected = false;
      const chunks: Buffer[] = [];
      const deadline = setTimeout(() => request.destroy(), 2000);
      request.once('close', () => clearTimeout(deadline));
      request.on('error', () => {
        /* A disconnected sender retains its spool file. */
      });
      request.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > MAX_NOTIFY_BYTES) {
          rejected = true;
          chunks.length = 0;
          reply(413, { error: 'too-large' });
        } else chunks.push(chunk);
      });
      request.once('end', () => {
        clearTimeout(deadline);
        if (rejected) return;
        let event;
        try {
          event = notifyEventSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reply(400, { error: 'invalid-event' });
          return;
        }
        try {
          const result = this.inbox.receive(event);
          // ACK means both inbox tombstone and outbox intent are committed, not remote delivery.
          const accepted = !['denied', 'disabled'].includes(result.outcome);
          reply(accepted ? 200 : 403, { ...result, identity: eventIdentity(event) });
        } catch {
          this.errorCode = 'notify-persist-failed';
          reply(503, { error: 'persist-failed' });
        }
      });
    });
    server.maxConnections = 16;
    server.headersTimeout = 3000;
    server.requestTimeout = 3000;
    server.on('clientError', (_error, socket) => socket.destroy());
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.policy.port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', () => {
          this.errorCode = 'notify-listener-failed';
        });
        resolve();
      });
    });
  }
  /** Invalid files are quarantined; transient storage failures retain files for the next tick. */
  drain(now = Date.now()) {
    if (now < this.nextDrain) return;
    this.nextDrain = now + 5000;
    try {
      privateDirectory(this.policy.spoolDir);
      const names = readdirSync(this.policy.spoolDir).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
      for (const name of names.slice(0, 50)) {
        const path = join(this.policy.spoolDir, name);
        let event;
        try {
          event = notifyEventSchema.parse(JSON.parse(readPrivate(path, MAX_NOTIFY_BYTES)));
          if (`${eventIdentity(event)}.json` !== name) throw new Error('identity-mismatch');
        } catch {
          // Rename the directory entry, never follow it. Bad files must not starve valid ones.
          renameSync(path, `${path}.${randomUUID()}.invalid`);
          this.errorCode = 'notify-spool-invalid';
          continue;
        }
        const result = this.inbox.receive(event);
        if (['denied', 'disabled'].includes(result.outcome)) {
          renameSync(path, `${path}.${randomUUID()}.denied`);
          this.errorCode = 'notify-spool-denied';
        } else unlinkSync(path);
      }
    } catch {
      this.errorCode = 'notify-spool-drain-failed';
    }
  }
  close() {
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
