import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { TaskStore, ownerKey } from '../src/tasks/store.ts';
import { StatusMetrics } from '../src/tasks/status-metrics.ts';
import { sessionSections, quotaLayout } from '../src/feishu/metrics-layout.ts';
import { renderLayout, buttonStyle } from '../src/feishu/card-layout.ts';
import { ContextPanel } from '../src/feishu/context-panel.ts';
import { queueNotice } from '../src/feishu/conversation-ui.ts';
import { FeishuSender, receiptMarker } from '../src/feishu/sender.ts';
import { FeishuApiError } from '../src/feishu/api.ts';
import { taskLayout } from '../src/feishu/task-layout.ts';

const owner = { appId: 'cli_fixture', tenantKey: 'tenant', openId: 'ou_user' };
const credentials = {
  ...owner,
  allowedOpenId: owner.openId,
  appSecret: 'fixture',
  testChatId: 'oc_chat',
};
const at = Date.now();
const usage = {
  inputTokens: 1234,
  cachedInputTokens: 999,
  outputTokens: 567,
  reasoningOutputTokens: 20,
  totalTokens: 1801,
};
function walk(value) {
  return value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(walk)] : [];
}
describe('native card hierarchy and durable delivery', () => {
  let dir, db, store, metrics, config, panel;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-layout-')));
    db = openGatewayDatabase(join(dir, 'gateway.sqlite'));
    store = new TaskStore(db);
    metrics = new StatusMetrics(store, ownerKey(owner));
    config = { projects: [{ key: 'p', root: dir, name: '测试项目', remoteWrite: true }] };
    panel = new ContextPanel(store, config, metrics.owner, credentials.testChatId);
    store.setContext(metrics.owner, 'p', null);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function running() {
    const { task } = store.submit({
      owner,
      requestKey: 'task',
      projectKey: 'p',
      cwd: dir,
      prompt: '测试话题',
    });
    store.claim(task.task_id, 'e');
    store.bindThread(task.task_id, 'thread', dir, 'e');
    store.bindTurn(task.task_id, { id: 'turn', status: 'inProgress', items: [] });
    store.setContext(metrics.owner, 'p', task.task_id);
    metrics.metadata('thread', { model: 'fixture', reasoningEffort: 'xhigh' }, at);
    metrics.notification(
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread',
          turnId: 'turn',
          tokenUsage: {
            last: usage,
            total: { ...usage, totalTokens: 990000 },
            modelContextWindow: 258400,
          },
        },
      },
      at,
    );
    return store.get(task.task_id);
  }
  it('keeps unknown new-topic usage absent and separates defaults from actual settings', () => {
    metrics.saveProject('p', {
      cwd: dir,
      model: 'default-model',
      reasoningEffort: 'high',
      observedAt: at,
    });
    const view = panel.snapshot().layout;
    expect(JSON.stringify(view)).toContain('默认模型');
    expect(JSON.stringify(view)).toContain('尚未开始');
    expect(JSON.stringify(view)).not.toContain('0 Token');
    expect(JSON.stringify(view)).not.toContain('排队');
    expect(JSON.stringify(sessionSections(metrics, null, null, 'p', '/wrong'))).not.toContain(
      'default-model',
    );
  });
  it('shows only summary usage on the panel, complete usage and identifiers in details, without quota', () => {
    const task = running();
    const summary = JSON.stringify(panel.snapshot().layout);
    expect(summary).toContain('1,234 Token');
    expect(summary).toContain('258,400 Token');
    expect(summary).not.toContain('990,000');
    expect(summary).not.toContain('最近缓存命中');
    expect(summary).not.toContain('账号额度');
    const details = JSON.stringify(taskLayout(store, task, '测试项目', true));
    expect(details).toContain('990,000 Token');
    expect(details).toContain('不等于上下文占用');
    expect(details).toContain(task.task_id);
    expect(details).toContain('最近缓存命中');
    expect(panel.snapshot().buttons[0].choice).toBe('details');
  });
  it('surfaces approvals and read-only constraints without hiding status', () => {
    const task = running();
    db.prepare('UPDATE tasks SET waiting_approval=1 WHERE task_id=?').run(task.task_id);
    config.projects[0].remoteWrite = false;
    const layout = panel.snapshot().layout;
    expect(layout.theme).toBe('orange');
    expect(layout.status).toBe('等待审批');
    expect(layout.alerts.join('\n')).toContain('未开放执行权限');
  });
  it('preserves exact approval scope next to equal-weight decisions and escapes injected markup', () => {
    const scope = 'echo <at id=all> `rm` **text** [x](https://evil.test)';
    const layout = {
      version: 1,
      eyebrow: scope,
      heading: scope,
      theme: 'orange',
      alerts: [],
      notes: [],
      sections: [
        { title: '审批', text: scope, approval: true },
        { title: '输出', text: 'RESULT' },
      ],
    };
    const nodes = renderLayout(layout, [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{ tag: 'button', text: { tag: 'plain_text', content: '拒绝' } }],
      },
    ]);
    const serialized = JSON.stringify(nodes);
    expect(serialized).not.toContain('<at id=all>');
    expect(serialized).not.toContain('[x]');
    const decision = nodes.findIndex((n) => n.tag === 'column_set');
    expect(nodes[decision - 1].content).toContain('echo');
    expect(nodes.findIndex((n) => n.content === '**输出**')).toBeGreaterThan(decision);
    expect(buttonStyle('approval', 'accept')).toBe(buttonStyle('approval', 'decline'));
    expect(buttonStyle('interrupt')).toBe('danger');
  });
  it('uses actual quota windows, clamps percentages and retains expired reset values', () => {
    metrics.saveAccount({
      status: 'stale',
      label: 'ChatGPT Pro',
      observedAt: at - 200000,
      limits: {
        ordinaryUsageAllowed: false,
        rateLimits: { primary: { usedPercent: 0 } },
        rateLimitsByLimitId: {
          custom: {
            limitName: '专用窗口',
            primary: {
              usedPercent: 32.54,
              windowDurationMins: 90,
              resetsAt: Math.floor(at / 1000) - 1,
            },
            secondary: { usedPercent: 120, windowDurationMins: 1440 },
          },
        },
      },
    });
    const layout = quotaLayout(metrics, at);
    expect(layout.alerts).toHaveLength(2);
    expect(layout.sections[0].meters[0]).toMatchObject({
      label: '90 分钟',
      remaining: 67.46000000000001,
      reset: '重置时间已到，待服务端确认',
    });
    expect(layout.sections[0].meters[1].remaining).toBe(0);
    const content = JSON.stringify(renderLayout(layout));
    expect(content).toContain('剩余 67.5%');
    expect(content).not.toContain('100%');
  });
  it('does not fabricate a meter or fall back to legacy limits for missing windows', () => {
    metrics.saveAccount({
      status: 'ok',
      observedAt: at,
      limits: { rateLimits: { primary: { usedPercent: 20 } }, rateLimitsByLimitId: {} },
    });
    expect(JSON.stringify(quotaLayout(metrics, at))).toContain('未提供额度窗口');
    expect(JSON.stringify(quotaLayout(metrics, at))).not.toContain('remaining');
    metrics.saveAccount({ status: 'signed_out' });
    expect(JSON.stringify(quotaLayout(metrics, at))).toContain('未登录');
    expect(JSON.stringify(quotaLayout(metrics, at))).not.toContain('remaining');
  });
  it('freezes a hierarchical card across a lost reply and reconciles its title-only preview without re-sending', async () => {
    running();
    const snapshot = panel.snapshot();
    queueNotice(
      store,
      metrics.owner,
      credentials.testChatId,
      'layout',
      snapshot.title,
      snapshot.text,
      snapshot.buttons,
      snapshot.layout,
    );
    let sent,
      creates = 0;
    const api = {
      prepare: async () => {},
      create: async (chat, wire) => {
        sent = JSON.parse(wire);
        creates++;
        throw new FeishuApiError('unknown');
      },
      history: async () => [
        {
          message_id: 'om_lost',
          chat_id: credentials.testChatId,
          msg_type: 'interactive',
          sender: { sender_type: 'app', id_type: 'app_id', id: credentials.appId },
          body: { content: sent.header.title.content },
        },
      ],
    };
    const sender = new FeishuSender(store, credentials, api, config.projects);
    await sender.flushOne();
    const row = db.prepare("SELECT * FROM outbox WHERE logical_key='feishu:reply:layout'").get();
    expect(row.state).toBe('unknown');
    expect(sent.header.title.content).toContain(receiptMarker(row.outbox_id));
    expect(
      walk(sent)
        .filter((x) => x.tag === 'column_set')
        .every((x) => x.columns.length <= 2),
    ).toBe(true);
    await sender.reconcileOne();
    expect(
      db.prepare('SELECT state FROM outbox WHERE outbox_id=?').pluck().get(row.outbox_id),
    ).toBe('delivered');
    expect(
      db.prepare('SELECT wire_content FROM outbox WHERE outbox_id=?').pluck().get(row.outbox_id),
    ).toBe(row.wire_content);
    expect(creates).toBe(1);
    expect(Buffer.byteLength(row.wire_content)).toBeLessThan(28000);
  });
  it('retains the old flat notice format when no layout was persisted', async () => {
    queueNotice(store, metrics.owner, credentials.testChatId, 'old', '旧通知', '旧的正文');
    let sent;
    const sender = new FeishuSender(store, credentials, {
      prepare: async () => {},
      create: async (_, wire) => {
        sent = JSON.parse(wire);
        return 'om_old';
      },
    });
    await sender.flushOne();
    expect(sent.body.elements[0]).toEqual({ tag: 'markdown', content: '旧的正文' });
  });
});
