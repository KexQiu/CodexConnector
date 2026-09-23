import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { WSClient } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase, openReadonlyDatabase } from '../src/persistence/database.ts';
import {
  attachFeishuProbe,
  FeishuProbeStore,
  loadFeishuCredentials,
  silentLogger,
} from '../scripts/gates/feishu-support.mjs';

const credentials = {
  appId: 'cli_0000000000000001',
  appSecret: 'fixture-secret-never-log',
  tenantKey: 'tenant-fixture',
  allowedOpenId: 'ou_fixture',
  testChatId: 'oc_fixture',
};
describe('G1 installed SDK ACK behavior with real SQLite (no network)', () => {
  let directory;
  let database;
  let store;
  let ws;
  let records;
  let frames;
  let observedCounts;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cfg-g1-test-'));
    database = openGatewayDatabase(join(directory, 'probe.sqlite'));
    store = new FeishuProbeStore(database, credentials, 'fixture-run');
    records = [];
    frames = [];
    observedCounts = [];
    ws = new WSClient({ ...credentials, logger: silentLogger });
    // Run the SDK's actual frame -> dispatcher -> ACK code, replacing only network send.
    ws.sendMessage = (frame) => {
      frames.push(JSON.parse(new TextDecoder().decode(frame.payload)));
      const observer = openReadonlyDatabase(join(directory, 'probe.sqlite'));
      observedCounts.push(observer.prepare('SELECT count(*) FROM g1_commands').pluck().get());
      observer.close();
    };
    ws.eventDispatcher = attachFeishuProbe(ws, store, (record) => records.push(record));
  });
  afterEach(() => {
    ws?.close({ force: true });
    if (database?.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const deliver = async (client, event) => {
    await client.handleEventData({
      headers: Object.entries({
        message_id: randomUUID(),
        sum: '1',
        seq: '0',
        type: 'event',
        trace_id: 'fixture-trace',
      }).map(([key, value]) => ({ key, value })),
      payload: new TextEncoder().encode(JSON.stringify(event)),
    });
  };
  function message(overrides = {}) {
    return {
      schema: '2.0',
      header: {
        event_id: randomUUID(),
        event_type: 'im.message.receive_v1',
        app_id: credentials.appId,
        tenant_key: credentials.tenantKey,
      },
      event: {
        sender: { sender_id: { open_id: credentials.allowedOpenId }, sender_type: 'user' },
        message: {
          message_id: 'om_incoming',
          chat_id: credentials.testChatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: store.challenge }),
        },
      },
      ...overrides,
    };
  }
  function card(kind = 'confirm', expiresAt) {
    const value = store.issueAction(kind, expiresAt);
    store.bindCard('om_card');
    return {
      schema: '2.0',
      header: {
        event_id: randomUUID(),
        event_type: 'card.action.trigger',
        app_id: credentials.appId,
        tenant_key: credentials.tenantKey,
      },
      event: {
        operator: { open_id: credentials.allowedOpenId },
        token: 'fixture-callback-token',
        context: { open_chat_id: credentials.testChatId, open_message_id: 'om_card' },
        action: { tag: 'button', value },
      },
    };
  }

  it('makes inbox and command visible to another connection BEFORE SDK success ACK', async () => {
    await deliver(ws, message());
    expect(frames[0].code).toBe(200);
    expect(observedCounts).toEqual([1]);
    expect(records[0]).toMatchObject({
      durable: true,
      outcome: 'accepted',
      commandKind: 'message',
    });
  });

  it('deduplicates the same event and the same message under a different event id', async () => {
    const event = message();
    await deliver(ws, event);
    await deliver(ws, event);
    await deliver(ws, message());
    expect(store.counts()).toEqual({ inbox: 2, commands: 1 });
    expect(records.map((r) => r.outcome)).toEqual([
      'accepted',
      'duplicate-event',
      'duplicate-command',
    ]);
    expect(observedCounts).toEqual([1, 1, 1]);
  });

  it('retains event and command deduplication after database reopen', async () => {
    const event = message();
    await deliver(ws, event);
    database.close();
    database = openGatewayDatabase(join(directory, 'probe.sqlite'));
    const reopened = new FeishuProbeStore(database, credentials, 'fixture-run');
    const result = reopened.process('message', { ...event.header, ...event.event });
    expect(result.outcome).toBe('duplicate-event');
    expect(reopened.counts()).toEqual({ inbox: 1, commands: 1 });
  });

  it.each(['app', 'tenant', 'actor', 'chat', 'message-source'])(
    'rejects unauthorized %s without creating commands',
    async (field) => {
      const event = message();
      if (field === 'app') event.header.app_id = 'wrong';
      if (field === 'tenant') event.header.tenant_key = 'wrong';
      if (field === 'actor') event.event.sender.sender_id.open_id = 'ou_wrong';
      if (field === 'chat') event.event.message.chat_id = 'oc_wrong';
      if (field === 'message-source') event.event.message.chat_type = 'group';
      await deliver(ws, event);
      expect(records[0]).toMatchObject({ outcome: 'denied', reason: field, ackCode: 200 });
      expect(store.counts()).toEqual({ inbox: 0, commands: 0 });
    },
  );

  it('returns toast data only after committing a card command, then rejects repeated clicks', async () => {
    const event = card();
    await deliver(ws, event);
    event.header.event_id = randomUUID();
    await deliver(ws, event);
    expect(records[0]).toMatchObject({
      ackCode: 200,
      durable: true,
      commandKind: 'confirm',
      ackData: { toast: { type: 'success' } },
    });
    expect(records[1].outcome).toBe('duplicate-command');
    expect(observedCounts).toEqual([1, 1]);
  });

  it('rejects expired buttons, forged nonces, and buttons copied to a different message', async () => {
    await deliver(ws, card('expired', Date.now() - 1000));
    const forged = card();
    forged.event.action.value.nonce = randomUUID();
    await deliver(ws, forged);
    const copied = card();
    copied.event.context.open_message_id = 'om_wrong';
    await deliver(ws, copied);
    expect(records.map((r) => r.outcome)).toEqual(['expired', 'invalid-action', 'invalid-action']);
    expect(store.counts().commands).toBe(0);
  });

  it('uses ACK 500 on SQLite write failure and commits exactly once on same-event retry', async () => {
    const event = card('storage-failure');
    await deliver(ws, event);
    expect(frames[0]).toEqual({ code: 500 });
    expect(store.counts()).toEqual({ inbox: 0, commands: 0 });
    expect(records[0].durable).toBe(false);
    await deliver(ws, event);
    await deliver(ws, event);
    expect(frames.map((f) => f.code)).toEqual([500, 200, 200]);
    expect(observedCounts).toEqual([0, 1, 1]);
    expect(store.counts()).toEqual({ inbox: 1, commands: 1 });
  });

  it('rolls back the inbox when command insertion fails', async () => {
    database.exec(
      "CREATE TRIGGER reject_commands BEFORE INSERT ON g1_commands BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    const event = message();
    await deliver(ws, event);
    expect(frames[0].code).toBe(500);
    expect(store.counts()).toEqual({ inbox: 0, commands: 0 });
    database.exec('DROP TRIGGER reject_commands');
    await deliver(ws, event);
    expect(store.counts()).toEqual({ inbox: 1, commands: 1 });
  });

  it('injects one failure for the retry challenge and accepts a redelivery with the same event id', async () => {
    const event = message();
    event.event.message.content = JSON.stringify({ text: `${store.challenge} retry` });
    await deliver(ws, event);
    await deliver(ws, event);
    expect(frames.map((f) => f.code)).toEqual([500, 200]);
    expect(records[0].key).toBe(records[1].key);
    expect(records[1]).toMatchObject({ commandKind: 'message-retry', durable: true });
    expect(store.counts()).toEqual({ inbox: 1, commands: 1 });
  });

  it('fails closed on missing event identity and omits credentials/tokens from samples', async () => {
    const event = message();
    delete event.header.event_id;
    await deliver(ws, event);
    expect(frames[0].code).toBe(500);
    await deliver(ws, card());
    const samples = JSON.stringify(records);
    for (const secret of [
      credentials.appSecret,
      credentials.allowedOpenId,
      credentials.testChatId,
      'fixture-callback-token',
    ])
      expect(samples).not.toContain(secret);
  });

  it('accepts only an owned private regular credential file and never includes input in errors', () => {
    const path = join(directory, 'feishu.local.json');
    writeFileSync(path, JSON.stringify(credentials), { mode: 0o600 });
    expect(loadFeishuCredentials(path)).toEqual(credentials);
    chmodSync(path, 0o644);
    expect(() => loadFeishuCredentials(path)).toThrow(/private/);
    chmodSync(path, 0o600);
    symlinkSync(path, join(directory, 'link.json'));
    expect(() => loadFeishuCredentials(join(directory, 'link.json'))).toThrow(/private/);
    writeFileSync(path, '{"secret": "fixture-secret-never-log"');
    try {
      loadFeishuCredentials(path);
    } catch (error) {
      expect(error.message).not.toContain('fixture-secret');
    }
    expect(readFileSync(path, 'utf8')).toContain('fixture-secret');
  });
});
