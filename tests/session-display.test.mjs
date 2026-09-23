import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore, ownerKey } from '../src/tasks/store.ts';
import { MetricsPoller, StatusMetrics } from '../src/tasks/status-metrics.ts';
import { readHistoricalUsage } from '../src/tasks/session-usage.ts';
import { FeishuInbox } from '../src/feishu/inbound.ts';
import { FeishuCommands } from '../src/feishu/commands.ts';

const at = Date.parse('2026-09-01T01:00:00Z');
const record = (type, payload, timestamp = at) =>
  JSON.stringify({ type, payload, timestamp: new Date(timestamp).toISOString() }) + '\n';
const tokens = {
  input_tokens: 1000,
  cached_input_tokens: 800,
  output_tokens: 200,
  reasoning_output_tokens: 50,
  total_tokens: 1200,
};
const token = (timestamp = at) =>
  record(
    'event_msg',
    {
      type: 'token_count',
      info: {
        last_token_usage: tokens,
        total_token_usage: { ...tokens, total_tokens: 990000 },
        model_context_window: 258400,
      },
      rate_limits: { secret: 'SECRET' },
    },
    timestamp,
  );
const owner = { tenantKey: 'tenant', appId: 'cli_fixture', openId: 'ou_user' };
const credentials = {
  ...owner,
  allowedOpenId: owner.openId,
  appSecret: 'fixture',
  testChatId: 'oc_fixture',
};

describe('project defaults, historical usage and independent quota command', () => {
  let dir, home, path, threadId, db, store, metrics, task, projects, calls, values, rpc, poller;
  const write = (body, id = threadId, cwd = dir) =>
    writeFileSync(path, record('session_meta', { id, cwd, instructions: 'SECRET' }) + body, {
      mode: 0o600,
    });
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-session-display-')));
    home = join(dir, 'codex');
    mkdirSync(join(home, 'sessions'), { recursive: true, mode: 0o700 });
    threadId = randomUUID();
    path = join(home, 'sessions', `rollout-${threadId}.jsonl`);
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    metrics = new StatusMetrics(store, ownerKey(owner));
    task = store.submit({
      owner,
      requestKey: 'fixture',
      projectKey: 'p',
      cwd: dir,
      prompt: 'fixture',
    }).task;
    store.claim(task.task_id, 'epoch');
    store.bindThread(task.task_id, threadId, dir, 'epoch');
    store.bindTurn(task.task_id, { id: 'turn', status: 'inProgress', items: [] });
    projects = [{ key: 'p', root: dir, name: 'fixture', remoteWrite: true }];
    calls = [];
    values = {
      'config/read': {
        config: { model: 'configured', model_reasoning_effort: 'xhigh', api_key: 'SECRET' },
        origins: {},
      },
      'configRequirements/read': { requirements: null },
      'model/list': {
        data: [{ model: 'catalog', isDefault: true, defaultReasoningEffort: 'medium' }],
      },
      'thread/read': {
        thread: { id: threadId, cwd: dir, path, model: 'actual', reasoningEffort: 'high' },
      },
      'account/read': {
        account: { type: 'chatgpt', email: 'private@example.test', planType: 'pro' },
      },
      'account/rateLimits/read': {
        rateLimits: {
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      },
    };
    rpc = {
      isReady: true,
      request: async (method, params, schema) => {
        calls.push({ method, params });
        const value = values[method];
        return schema.parse(typeof value === 'function' ? await value() : value);
      },
    };
    poller = new MetricsPoller(metrics, rpc, projects);
    poller.codexHome = home;
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('backfills a real bounded local snapshot through read-only RPC and retains only numeric usage', async () => {
    write(token());
    await poller.refreshSession(threadId, 'p');
    expect(calls.map((c) => c.method)).toEqual(['thread/read']);
    expect(metrics.session(threadId)).toMatchObject({
      model: 'actual',
      reasoningEffort: 'high',
      usageSource: 'history',
      usageAt: at,
    });
    expect(metrics.session(threadId).usage.last.inputTokens).toBe(1000);
    const text = metrics.sessionText(threadId, 'turn', true);
    expect(text).toContain('历史快照');
    expect(text).toContain('258,400');
    expect(text).toContain('990,000');
    expect(text).not.toContain('%');
    expect(JSON.stringify(metrics.session(threadId))).not.toMatch(
      /SECRET|rate_limits|instructions|rollout/,
    );
    expect(metrics.session(threadId).usageTurn).toBeUndefined();
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    metrics = new StatusMetrics(new TaskStore(db), ownerKey(owner));
    expect(metrics.sessionText(threadId, 'turn', true)).toBe(text);
  });
  it.each(['foreign-id', 'foreign-cwd', 'outside', 'symlink', 'hardlink'])(
    'rejects untrusted history: %s',
    async (mode) => {
      write(token());
      let readPath = path;
      if (mode === 'foreign-id') write(token(), randomUUID());
      if (mode === 'foreign-cwd') write(token(), threadId, home);
      if (mode === 'outside') {
        readPath = join(dir, `rollout-${threadId}.jsonl`);
        renameSync(path, readPath);
      }
      if (mode === 'symlink') {
        const original = path + '.original';
        renameSync(path, original);
        symlinkSync(original, path);
      }
      if (mode === 'hardlink') linkSync(path, path + '.linked');
      expect((await readHistoricalUsage(home, readPath, threadId, dir)).status).toBe('unavailable');
    },
  );
  it('does not inspect a foreign thread or accept a mismatched RPC cwd', async () => {
    await poller.refreshSession('foreign', 'p');
    expect(calls).toEqual([]);
    values['thread/read'].thread.cwd = home;
    await poller.refreshSession(threadId);
    expect(metrics.session(threadId).model).toBeUndefined();
    expect(metrics.session(threadId).metadataStale).toBe(true);
  });
  it('ignores partial append, null heartbeat and unrelated transcript records', async () => {
    write(
      token() +
        record('event_msg', { type: 'token_count', info: null }) +
        record('response_item', { text: 'PRIVATE' }),
    );
    appendFileSync(path, '{"type":"event_msg",');
    const snapshot = await readHistoricalUsage(home, path, threadId, dir);
    expect(snapshot.usageAt).toBe(at);
    expect(snapshot.status).toBe('ok');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });
  it('does not resurrect pre-compaction data and accepts subsequent statistics', async () => {
    write(token() + record('compacted', { message: 'PRIVATE' }, at + 1));
    await poller.refreshSession(threadId);
    expect(metrics.session(threadId).usage).toBeUndefined();
    expect(metrics.sessionText(threadId, 'turn')).toContain('压缩后');
    appendFileSync(path, token(at + 2));
    await poller.refreshSession(threadId);
    expect(metrics.session(threadId).usageAt).toBe(at + 2);
    metrics.notification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId,
          turnId: 'turn',
          tokenUsage: {
            ...metrics.session(threadId).usage,
            last: { ...metrics.session(threadId).usage.last, inputTokens: 12345 },
          },
        },
      },
      at + 5,
    );
    await poller.refreshSession(threadId);
    expect(metrics.session(threadId).usage.last.inputTokens).toBe(12345);
    expect(metrics.session(threadId).usageSource).toBe('live');
  });
  it('degrades malformed or unavailable files without exposing content or claiming zero', async () => {
    write(
      token() +
        record(
          'event_msg',
          { type: 'token_count', info: { ...tokens, secret: 'PRIVATE' } },
          at + 1,
        ),
    );
    await poller.refreshSession(threadId);
    expect(metrics.session(threadId).usage).toBeUndefined();
    expect(metrics.sessionText(threadId, 'turn')).toContain('历史格式暂不支持');
    rmSync(path);
    await poller.refreshSession(threadId);
    expect(metrics.sessionText(threadId, 'turn')).toContain('历史记录暂不可读');
  });
  it('bounds the tail and does not reuse usage outside the scanned range', async () => {
    write(token() + record('response_item', { text: 'x'.repeat(5 * 1024 * 1024) }));
    expect((await readHistoricalUsage(home, path, threadId, dir)).status).toBe('truncated');
    appendFileSync(path, token(at + 2));
    expect((await readHistoricalUsage(home, path, threadId, dir)).usageAt).toBe(at + 2);
  });
  it('shows effective project defaults before creation and persists them without secrets', async () => {
    await poller.refreshSession(null, 'p');
    expect(metrics.sessionText(null, null, false, 'p', dir)).toContain(
      '新话题默认模型：configured · 默认思考强度：极高',
    );
    expect(metrics.sessionText(null, null, false, 'p', dir)).toContain('尚未开始');
    expect(calls.some((c) => /thread\//.test(c.method))).toBe(false);
    expect(JSON.stringify(metrics.project('p'))).not.toContain('SECRET');
    expect(metrics.sessionText(null, null, false, 'p', home)).not.toContain('configured');
    expect(new StatusMetrics(store, 'foreign').project('p')).toBeUndefined();
  });
  it('uses managed defaults unless the model/effort origin is an explicit override', async () => {
    values['configRequirements/read'] = {
      requirements: { models: { newThread: { model: 'managed', modelReasoningEffort: 'low' } } },
    };
    await poller.refreshSession(null, 'p');
    expect(metrics.project('p')).toMatchObject({ model: 'managed', reasoningEffort: 'low' });
    values['config/read'].origins.model_reasoning_effort = { name: { type: 'sessionFlags' } };
    await poller.refreshSession(null, 'p');
    expect(metrics.project('p')).toMatchObject({ model: 'configured', reasoningEffort: 'xhigh' });
  });
  it('uses the catalog fallback only for matching models and labels failed refreshes', async () => {
    values['config/read'].config = {};
    await poller.refreshSession(null, 'p');
    expect(metrics.project('p')).toMatchObject({ model: 'catalog', reasoningEffort: 'medium' });
    values['config/read'].config = { model: 'custom' };
    await poller.refreshSession(null, 'p');
    expect(metrics.project('p').model).toBe('custom');
    expect(metrics.project('p').reasoningEffort).toBeUndefined();
    values['config/read'] = () => {
      throw Error('offline');
    };
    await poller.refreshSession(null, 'p');
    expect(metrics.sessionText(null, null, false, 'p', dir)).toContain('刷新失败');
  });
  it('does not let a slow quota query block or invalidate session reads', async () => {
    write(token());
    let release;
    values['account/read'] = () =>
      new Promise((r) => {
        release = r;
      });
    const account = poller.refreshAccount();
    await poller.refreshSession(threadId);
    expect(metrics.session(threadId).usageAt).toBe(at);
    poller.invalidateAccount();
    release({ account: null });
    await account;
    expect(metrics.account().status).toBe('unavailable');
    expect(metrics.session(threadId).usageAt).toBe(at);
  });
  it('waits for session data before /当前, isolates /额度 and preserves selection/deduplication', async () => {
    write(token());
    store.setContext(metrics.owner, 'p', task.task_id);
    const inbox = new FeishuInbox(store, credentials);
    const commands = new FeishuCommands(
      inbox,
      { projects },
      { catalog: async () => [], sessions: async () => ({ data: [] }) },
      {
        refreshMetrics: async (id) =>
          poller.refreshSession(store.get(id ?? task.task_id).thread_id, 'p'),
        refreshQuota: async () => poller.refreshAccount(),
      },
    );
    const send = async (text, id = randomUUID()) => {
      const event = {
        event_id: id,
        app_id: credentials.appId,
        tenant_key: credentials.tenantKey,
        sender: { sender_type: 'user', sender_id: { open_id: credentials.allowedOpenId } },
        message: {
          message_id: id,
          chat_id: credentials.testChatId,
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text }),
        },
      };
      inbox.receive('message', event);
      await commands.processNext();
      return id;
    };
    await send('/当前');
    let payload = JSON.parse(
      db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').pluck().get(),
    );
    expect(payload.text).toContain('actual');
    expect(payload.text).toContain('1,000');
    expect(payload.text).not.toContain('账号额度');
    expect(calls.some((c) => c.method.startsWith('account/'))).toBe(false);
    const quota = await send('/额度');
    payload = JSON.parse(
      db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').pluck().get(),
    );
    expect(payload.title).toBe('账号剩余额度');
    expect(payload.text).toContain('5 小时剩余 75%');
    expect(payload.text).not.toContain('会话模型');
    const count = db.prepare('SELECT count(*) FROM outbox').pluck().get();
    await send('/额度', quota);
    expect(db.prepare('SELECT count(*) FROM outbox').pluck().get()).toBe(count);
    expect(commands.panel.context().task_id).toBe(task.task_id);
    expect(store.list()).toHaveLength(1);
    await send(`/状态 ${task.task_id}`);
    payload = JSON.parse(
      db.prepare('SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1').pluck().get(),
    );
    expect(payload.text).toContain('990,000');
    expect(payload.text).not.toContain('账号额度');
  });
});
