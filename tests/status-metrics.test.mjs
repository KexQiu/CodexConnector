import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore, ownerKey } from '../src/tasks/store.ts';
import { MetricsPoller, StatusMetrics } from '../src/tasks/status-metrics.ts';
import { ContextPanel } from '../src/feishu/context-panel.ts';
import { migrationSources, migrate, SCHEMA_VERSION } from '../src/persistence/migrate.ts';

describe('session metadata and account quota projection (real SQLite, simulated RPC)', () => {
  let dir, db, store, metrics, task, owner, ownerId;
  const now = 1800000000000;
  const window = (used = 61, mins = 10080) => ({
    usedPercent: used,
    windowDurationMins: mins,
    resetsAt: Math.floor(now / 1000) + 3600,
  });
  const limits = (primary = window()) => ({
    ordinaryUsageAllowed: true,
    accountId: 'account-a',
    rateLimits: { limitId: 'codex', primary, secondary: null },
    rateLimitsByLimitId: null,
  });
  const usage = () => ({
    last: {
      totalTokens: 1200,
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 200,
      reasoningOutputTokens: 100,
    },
    total: {
      totalTokens: 900000,
      inputTokens: 700000,
      cachedInputTokens: 300000,
      outputTokens: 200000,
      reasoningOutputTokens: 100000,
    },
    modelContextWindow: 100000,
  });
  const event = (method, params) => ({ method, params, connectionEpoch: 'epoch' });
  function saveQuota(value = limits()) {
    metrics.saveAccount({
      status: 'ok',
      identity: 'fixture',
      label: 'ChatGPT pro',
      observedAt: now,
      limits: value,
    });
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-metrics-'));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    owner = { tenantKey: 'tenant', appId: 'cli_fixture', openId: 'ou_user' };
    ownerId = ownerKey(owner);
    metrics = new StatusMetrics(store, ownerId);
    task = store.submit({
      chatId: 'oc_chat',
      owner,
      requestKey: 'first',
      projectKey: 'p',
      cwd: dir,
      prompt: 'fixture',
    }).task;
    store.claim(task.task_id, 'epoch');
    store.bindThread(task.task_id, 'thread', dir, 'epoch');
    store.bindTurn(task.task_id, { id: 'turn', status: 'inProgress', items: [] });
    store.setContext(ownerId, 'p', task.task_id, 'oc_chat');
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('uses the actual window, computes remaining usage, and never invents a five-hour window', () => {
    saveQuota();
    const text = metrics.accountText(null, false, now);
    expect(text).toContain('7 天剩余 39%');
    expect(text).toContain('账号共享');
    expect(text).not.toContain('5 小时');
    expect(text).toContain('重置');
  });
  it('prefers multi-bucket data, preserves model buckets, and clamps invalid percentages', () => {
    const multi = {
      ...limits(window(99)),
      rateLimitsByLimitId: {
        codex: { primary: window(120, 300) },
        special: {
          limitName: '模型专用',
          normalModelSlug: 'model-special',
          primary: window(-1, 60),
        },
      },
    };
    saveQuota(multi);
    const text = metrics.accountText('model-special', false, now);
    expect(text).toContain('5 小时剩余 0%');
    expect(text).toContain('1 小时剩余 100%');
    expect(text).not.toContain('剩余 1%');
    saveQuota({ ...multi, rateLimitsByLimitId: {} });
    expect(metrics.accountText(null, false, now)).toContain('未提供通用');
  });
  it('does not turn null windows, elapsed reset times, or missing authorization into available quota', () => {
    saveQuota(limits(null));
    expect(metrics.accountText(null, false, now)).toContain('窗口数据未提供');
    expect(metrics.accountText(null, false, now)).not.toContain('100%');
    saveQuota({ ...limits({ ...window(100), resetsAt: 1 }), ordinaryUsageAllowed: false });
    expect(metrics.accountText(null, false, now)).toContain('待服务端确认');
    expect(metrics.accountText(null, false, now)).toContain('不允许使用常规套餐额度');
    expect(metrics.accountText(null, false, now)).toContain('剩余 0%');
  });
  it('labels stale observations and persists them across database reopening', () => {
    saveQuota();
    expect(metrics.accountText(null, false, now + 180001)).toContain('旧数据');
    metrics.stale();
    db.close();
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    metrics = new StatusMetrics(store, ownerId);
    expect(metrics.accountText(null, false, now)).toContain('旧数据');
    expect(metrics.accountText(null, false, now)).toContain('39%');
  });
  it('keeps cumulative consumption separate from recent input and avoids guessing context percentage', () => {
    metrics.metadata('thread', { model: 'fixture-model', reasoningEffort: 'xhigh' }, now);
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: usage(),
      }),
      now,
    );
    const text = metrics.sessionText('thread', 'turn');
    expect(text).toContain('fixture-model');
    expect(text).toContain('极高');
    expect(text).toContain('最近请求输入：1,000');
    expect(text).toContain('模型窗口：100,000');
    expect(text).not.toContain('900,000');
    expect(text).not.toContain('%');
    expect(metrics.sessionText('thread', 'turn', true)).toContain('累计消耗：900,000');
  });
  it('isolates models by turn and invalidates pre-compaction usage until a new observation', () => {
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: usage(),
      }),
      now,
    );
    metrics.notification(
      event('model/rerouted', { threadId: 'thread', turnId: 'turn', toModel: 'routed-model' }),
      now,
    );
    expect(metrics.sessionText('thread', 'other-turn')).not.toContain('routed-model');
    expect(metrics.sessionText('thread', 'turn')).toContain('routed-model');
    const compact = event('item/completed', {
      threadId: 'thread',
      turnId: 'turn',
      item: { type: 'contextCompaction', id: 'compact' },
    });
    metrics.notification(compact, now + 1);
    metrics.notification(compact, now + 2);
    expect(metrics.session('thread').compactedAt).toBe(now + 1);
    expect(metrics.sessionText('thread', 'turn')).toContain('压缩后等待新统计');
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: usage(),
      }),
      now + 3,
    );
    expect(metrics.sessionText('thread', 'turn')).toContain('1,000');
  });
  it('retains an early usage event before the turn response has bound its ID', () => {
    db.prepare("UPDATE tasks SET turn_id=NULL,status='starting' WHERE task_id=?").run(task.task_id);
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'early-turn',
        tokenUsage: usage(),
      }),
      now,
    );
    expect(metrics.session('thread').usageTurn).toBe('early-turn');
  });
  it('ignores malformed metrics and another owner without affecting task state', () => {
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: { ...usage(), last: { ...usage().last, inputTokens: -1 } },
      }),
      now,
    );
    expect(metrics.session('thread')).toBeUndefined();
    const foreign = new StatusMetrics(store, 'foreign');
    foreign.metadata('thread', { model: 'bad' });
    expect(foreign.session('thread')).toBeUndefined();
    expect(store.get(task.task_id).status).toBe('running');
  });
  it('rejects late usage from an older turn after the next turn has reported usage', () => {
    store.applyTurn(task.task_id, { id: 'turn', status: 'completed', items: [] });
    const next = store.submit({
      chatId: 'oc_chat',
      owner,
      requestKey: 'next',
      projectKey: 'p',
      cwd: dir,
      prompt: 'next',
      threadId: 'thread',
    }).task;
    db.prepare('UPDATE tasks SET created_at=? WHERE task_id=?').run(
      task.created_at + 1000,
      next.task_id,
    );
    store.claim(next.task_id, 'epoch');
    store.bindThread(next.task_id, 'thread', dir, 'epoch');
    store.bindTurn(next.task_id, { id: 'turn-next', status: 'inProgress', items: [] });
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'turn-next',
        tokenUsage: usage(),
      }),
      now,
    );
    metrics.notification(
      event('thread/tokenUsage/updated', {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: usage(),
      }),
      now + 1,
    );
    expect(metrics.session('thread').usageTurn).toBe('turn-next');
  });
  it('polls read-only methods, throttles, and strips email and unknown auth fields', async () => {
    const calls = [];
    const rpc = {
      isReady: true,
      request: async (method, params, schema) => {
        calls.push([method, params]);
        return schema.parse(
          method === 'account/read'
            ? {
                account: {
                  type: 'chatgpt',
                  email: 'secret@example.test',
                  planType: 'pro',
                  token: 'SECRET',
                },
              }
            : method === 'account/rateLimits/read'
              ? { ...limits(), accessToken: 'SECRET' }
              : { thread: { id: 'thread', cwd: dir, model: 'fixture', reasoningEffort: 'high' } },
        );
      },
    };
    const poller = new MetricsPoller(metrics, rpc);
    await poller.poll('thread', now);
    await poller.poll('thread', now + 1);
    expect(calls.map((c) => c[0])).toEqual([
      'account/read',
      'thread/read',
      'account/rateLimits/read',
    ]);
    expect(calls[1][1]).toEqual({ threadId: 'thread', includeTurns: false });
    expect(JSON.stringify(metrics.account())).not.toContain('SECRET');
    expect(JSON.stringify(metrics.account())).not.toContain('secret@example');
    expect(metrics.session('thread').model).toBe('fixture');
  });
  it('discards in-flight data after account changes and permits the subsequent read', async () => {
    let resolve,
      held = true;
    const rpc = {
      isReady: true,
      request: async (method, params, schema) => {
        if (method === 'account/read')
          return schema.parse({ account: { type: 'chatgpt', email: 'a@test', planType: 'pro' } });
        if (held)
          return new Promise((r) => {
            resolve = r;
          });
        return schema.parse(limits(window(20)));
      },
    };
    const poller = new MetricsPoller(metrics, rpc),
      pending = poller.poll(null, now);
    await Promise.resolve();
    poller.invalidateAccount();
    resolve(limits());
    await pending;
    expect(metrics.account().status).toBe('unavailable');
    expect(metrics.account().limits).toBeUndefined();
    held = false;
    await poller.poll(null, now + 10001);
    expect(metrics.account().limits.rateLimits.primary.usedPercent).toBe(20);
  });
  it.each([null, { type: 'apiKey' }])(
    'clears old quota for unsupported or logged-out accounts: %j',
    async (account) => {
      saveQuota();
      const poller = new MetricsPoller(metrics, {
        isReady: true,
        request: async (method, params, schema) => schema.parse({ account }),
      });
      await poller.poll(null, now);
      expect(metrics.account().limits).toBeUndefined();
      expect(metrics.account().status).toBe(account ? 'unsupported' : 'signed_out');
    },
  );
  it('bounds read failures and preserves old data explicitly as stale', async () => {
    saveQuota();
    const rpc = {
        isReady: true,
        request: async () => {
          throw Error('offline');
        },
      },
      poller = new MetricsPoller(metrics, rpc);
    await poller.poll(null, now);
    expect(metrics.account().status).toBe('stale');
    expect(metrics.account().limits).toBeDefined();
    poller.close();
    await poller.poll(null, now + 60000);
    expect(metrics.account().status).toBe('stale');
  });
  it('throttles display-only changes but displays task terminal changes immediately', () => {
    const panel = new ContextPanel(
      store,
      { projects: [{ key: 'p', name: 'fixture', root: dir, remoteWrite: true }] },
      ownerId,
      'oc_chat',
    );
    saveQuota();
    panel.sync(now);
    saveQuota(limits(window(70)));
    expect(panel.sync(now + 15000)).toBe(false);
    expect(panel.snapshot().text).not.toContain('额度');
    metrics.metadata('thread', { model: 'changed' });
    expect(panel.sync(now + 1)).toBe(false);
    expect(panel.sync(now + 15000)).toBe(true);
    store.applyTurn(task.task_id, { id: 'turn', status: 'completed', items: [] });
    expect(panel.sync(now + 15001)).toBe(true);
    expect(panel.snapshot(now + 15001).text).toContain('执行完成');
  });
  it('migrates v5 with existing panel bindings and keeps the original rows', () => {
    const copy = openGatewayDatabase(join(dir, 'v5.sqlite'));
    try {
      for (const m of migrationSources().slice(0, 5)) {
        copy.exec(m.sql);
        copy.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(m.version, m.checksum);
        copy.pragma(`user_version=${m.version}`);
      }
      copy
        .prepare(
          'INSERT INTO feishu_panels (panel_id,owner_key,chat_id,message_id,version) VALUES (?,?,?,?,?)',
        )
        .run('panel', 'owner', 'chat', 'message', 7);
      migrate(copy);
      expect(copy.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(copy.prepare('SELECT * FROM feishu_panels').get()).toMatchObject({
        panel_id: 'panel',
        message_id: 'message',
        version: 7,
        core_hash: null,
        last_rendered_at: 0,
      });
      expect(copy.pragma('foreign_key_check')).toEqual([]);
    } finally {
      copy.close();
    }
  });
});
