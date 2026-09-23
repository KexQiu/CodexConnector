import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';

export const silentLogger = Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((key) => [key, () => {}]),
);
const nonempty = z.string().trim().min(1).max(256);
const credentialsSchema = z.object({
  appId: z.string().regex(/^cli_[0-9a-fA-F]{16}$/),
  appSecret: nonempty,
  tenantKey: nonempty,
  allowedOpenId: z.string().regex(/^ou_[a-zA-Z0-9]+$/),
  testChatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
});

export function loadFeishuCredentials(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('private-file-required');
    }
    if (stat.size > 16_384) throw new Error('file-too-large');
    const result = credentialsSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!result.success) throw new Error('invalid-fields');
    return result.data;
  } catch {
    // Neither JSON parser messages nor validation input may expose the secret.
    throw new Error('Feishu config must be a private, owned JSON file with five valid fields');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export const digest = (value) => createHash('sha256').update(value).digest('hex');
const toast = (content, type = 'info') => ({ toast: { type, content } });

/** Probe-only tables in a NEW private database; not the M2 production inbox. */
export class FeishuProbeStore {
  constructor(database, credentials, runId) {
    this.db = database;
    this.credentials = credentials;
    this.runId = runId;
    this.challenge = `G1 ${runId.slice(0, 8)}`;
    this.failedOnce = new Set();
    database.exec(`
      CREATE TABLE IF NOT EXISTS g1_inbox (
        event_key TEXT PRIMARY KEY, kind TEXT NOT NULL, outcome TEXT NOT NULL,
        sample TEXT NOT NULL, committed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS g1_commands (
        business_key TEXT PRIMARY KEY, event_key TEXT NOT NULL REFERENCES g1_inbox(event_key),
        kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS g1_actions (
        nonce TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL,
        message_id TEXT
      );
      CREATE TABLE IF NOT EXISTS g1_outbound (
        uuid TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
        message_id TEXT
      );
    `);
  }

  issueAction(kind, expiresAt = Date.now() + 15 * 60_000) {
    if (!['confirm', 'expired', 'storage-failure'].includes(kind))
      throw new Error('Invalid action');
    const nonce = randomUUID();
    this.db.prepare('INSERT INTO g1_actions VALUES (?, ?, ?, NULL)').run(nonce, kind, expiresAt);
    return { probe: this.runId, nonce };
  }

  bindCard(messageId) {
    this.db.prepare('UPDATE g1_actions SET message_id = ? WHERE message_id IS NULL').run(messageId);
  }

  counts() {
    return {
      inbox: this.db.prepare('SELECT count(*) FROM g1_inbox').pluck().get(),
      commands: this.db.prepare('SELECT count(*) FROM g1_commands').pluck().get(),
    };
  }

  hasEvent(key) {
    return Boolean(this.db.prepare('SELECT 1 FROM g1_inbox WHERE event_key = ?').get(key));
  }

  process(kind, data) {
    const c = this.credentials;
    const message = kind === 'message';
    const tenant = data.tenant_key;
    const actor = message ? data.sender?.sender_id?.open_id : data.operator?.open_id;
    const chat = message ? data.message?.chat_id : data.context?.open_chat_id;
    const reason =
      data.app_id !== c.appId
        ? 'app'
        : tenant !== c.tenantKey
          ? 'tenant'
          : actor !== c.allowedOpenId
            ? 'actor'
            : chat !== c.testChatId
              ? 'chat'
              : message &&
                  (data.message?.chat_type !== 'p2p' || data.sender?.sender_type !== 'user')
                ? 'message-source'
                : undefined;
    if (reason)
      return {
        outcome: 'denied',
        reason,
        response: message ? undefined : toast('不允许此操作', 'error'),
      };

    if (typeof data.event_id !== 'string' || !data.event_id) {
      // Never ACK an authorized command that has no usable event identity.
      throw new Error('Missing event identity');
    }
    const key = digest(`${kind}:${data.event_id}`);
    let businessKey;
    let commandKind;
    let outcome = 'ignored';
    let action;
    if (message && data.message.message_type === 'text') {
      let text;
      try {
        text = JSON.parse(data.message.content).text;
      } catch {
        /* ignored */
      }
      if (
        [this.challenge, `${this.challenge} reconnect`, `${this.challenge} retry`].includes(text)
      ) {
        if (typeof data.message.message_id !== 'string' || !data.message.message_id) {
          throw new Error('Missing message identity');
        }
        businessKey = `message:${data.message.message_id}`;
        commandKind =
          text === this.challenge
            ? 'message'
            : text === `${this.challenge} reconnect`
              ? 'reconnect-message'
              : 'message-retry';
        outcome = 'accepted';
      }
    } else if (!message) {
      const value = data.action?.value;
      if (value?.probe === this.runId && typeof value.nonce === 'string') {
        action = this.db.prepare('SELECT * FROM g1_actions WHERE nonce = ?').get(value.nonce);
      }
      if (!action || !action.message_id || data.context?.open_message_id !== action.message_id) {
        outcome = 'invalid-action';
      } else if (action.expires_at <= Date.now()) {
        outcome = 'expired';
      } else {
        outcome = 'accepted';
        businessKey = `action:${action.nonce}`;
        commandKind = action.kind;
      }
    }

    const sample = {
      event_type: data.event_type,
      event_id_hash: key,
      app_matches: true,
      tenant_matches: true,
      actor_matches: true,
      chat_matches: true,
      shape: {
        sender: Boolean(data.sender),
        operator: Boolean(data.operator),
        context: Boolean(data.context),
        token_present: typeof data.token === 'string',
      },
      commandKind,
    };
    // One REAL SQLite failure per issued button / exact retry challenge, scoped to this run.
    const failureKey =
      commandKind === 'storage-failure'
        ? action.nonce
        : commandKind === 'message-retry'
          ? 'message-retry'
          : undefined;
    const injectFailure = failureKey !== undefined && !this.failedOnce.has(failureKey);
    if (injectFailure) {
      this.failedOnce.add(failureKey);
      this.db.pragma('query_only = ON');
    }
    try {
      return this.db.transaction(() => {
        if (this.hasEvent(key)) {
          return {
            key,
            kind,
            commandKind,
            outcome: 'duplicate-event',
            response: message ? undefined : toast('重复事件已去重'),
          };
        }
        this.db
          .prepare('INSERT INTO g1_inbox VALUES (?, ?, ?, ?, ?)')
          .run(key, kind, outcome, JSON.stringify(sample), Date.now());
        if (businessKey) {
          const result = this.db
            .prepare('INSERT OR IGNORE INTO g1_commands VALUES (?, ?, ?)')
            .run(businessKey, key, commandKind);
          if (result.changes === 0) outcome = 'duplicate-command';
          this.db.prepare('UPDATE g1_inbox SET outcome = ? WHERE event_key = ?').run(outcome, key);
        }
        const response = message
          ? undefined
          : toast(
              outcome === 'accepted'
                ? '测试操作已持久化'
                : outcome.startsWith('duplicate')
                  ? '重复操作已去重'
                  : outcome === 'expired'
                    ? '测试按钮已过期'
                    : '无效的测试按钮',
              outcome === 'accepted' ? 'success' : 'info',
            );
        return { key, kind, commandKind, outcome, response, sample };
      })();
    } finally {
      if (injectFailure) this.db.pragma('query_only = OFF');
    }
  }
}

/** Observe the installed SDK's handler/ACK ordering. Only used in this gate. */
export function attachFeishuProbe(ws, store, onAck) {
  if (typeof ws.handleEventData !== 'function' || typeof ws.sendMessage !== 'function') {
    throw new Error('SDK probe instrumentation incompatible; rerun SDK review');
  }
  const context = new AsyncLocalStorage();
  const handle = ws.handleEventData.bind(ws);
  ws.handleEventData = (frame) => context.run({ started: performance.now() }, () => handle(frame));
  const send = ws.sendMessage.bind(ws);
  ws.sendMessage = (frame) => {
    const active = context.getStore();
    if (active) {
      const payload = JSON.parse(new TextDecoder().decode(frame.payload));
      const result = active.result;
      const record = {
        ...result,
        response: undefined,
        ackCode: payload.code,
        ackData: payload.data
          ? JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8'))
          : undefined,
        durable: result?.key ? store.hasEvent(result.key) : false,
        elapsedMs: Math.round((performance.now() - active.started) * 1000) / 1000,
        boundary: 'sdk-send-attempt',
        ...store.counts(),
      };
      send(frame);
      onAck(record);
      return;
    }
    send(frame);
  };
  const handler = (kind) => async (data) => {
    const active = context.getStore();
    if (active)
      active.result = {
        kind,
        key: typeof data.event_id === 'string' ? digest(`${kind}:${data.event_id}`) : undefined,
        outcome: 'storage-or-handler-failure',
      };
    const result = store.process(kind, data);
    if (active) active.result = result;
    return result.response;
  };
  return new EventDispatcher({ logger: silentLogger }).register({
    'im.message.receive_v1': handler('message'),
    'card.action.trigger': handler('card'),
  });
}

export function testCard(runId, actions, completed = false) {
  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: `G1 飞书联调 ${runId.slice(0, 8)}` },
      template: completed ? 'green' : 'blue',
    },
    body: {
      elements: completed
        ? [
            {
              tag: 'markdown',
              content: '本轮交互测试已结束。测试按钮已移除，具体结论见本机门禁报告。',
            },
          ]
        : [
            {
              tag: 'markdown',
              content:
                '仅验证飞书传输与本地持久化，不执行 Codex 任务。\n1. 点击「确认」两次，验证去重。\n2. 点击「过期按钮」，应提示过期。\n3. 点击「存储失败」；首次故意失败，稍后再点一次验证恢复。',
            },
            {
              tag: 'column_set',
              flex_mode: 'none',
              columns: actions.map(({ label, value }) => ({
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [
                  {
                    tag: 'button',
                    text: { tag: 'plain_text', content: label },
                    type: 'default',
                    behaviors: [{ type: 'callback', value }],
                  },
                ],
              })),
            },
          ],
    },
  };
}
