import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CodexRpcClient, RpcNotification } from '../codex/rpc-client.js';
import type { TaskStore } from './store.js';
import type { GatewayConfig } from '../config/schema.js';
import { canonicalDirectory } from '../projects/store.js';
import { readHistoricalUsage, usageSchema, type HistoricalUsage } from './session-usage.js';

export { usageSchema } from './session-usage.js';

const nullableText = z.string().max(256).nullable().optional();
const count = z.number().int().nonnegative().safe();
const windowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().positive().nullable().optional(),
  resetsAt: count.nullable().optional(),
});
const bucketSchema = z.object({
  limitId: nullableText,
  limitName: nullableText,
  normalModelSlug: nullableText,
  primary: windowSchema.nullable().optional(),
  secondary: windowSchema.nullable().optional(),
  credits: z
    .object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: nullableText })
    .nullable()
    .optional(),
});
export const rateLimitsSchema = z.object({
  accountId: nullableText,
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
  rateLimits: bucketSchema,
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullable().optional(),
});
const accountSchema = z.object({
  account: z.object({ type: z.string(), email: nullableText, planType: nullableText }).nullable(),
});
const metadataSchema = z.object({ model: nullableText, reasoningEffort: nullableText });
const sessionSchema = z.object({
  model: nullableText,
  reasoningEffort: nullableText,
  metadataAt: count.optional(),
  usage: usageSchema.optional(),
  usageAt: count.optional(),
  usageTurn: z.string().optional(),
  usageSource: z.enum(['live', 'history']).optional(),
  historyStatus: z.enum(['ok', 'empty', 'unavailable', 'unsupported', 'truncated']).optional(),
  metadataStale: z.boolean().optional(),
  compactedAt: count.optional(),
  compactedItem: z.string().optional(),
  routedModel: z.string().optional(),
  routedTurn: z.string().optional(),
});
const projectSchema = z.object({
  model: nullableText,
  reasoningEffort: nullableText,
  cwd: z.string(),
  observedAt: count,
  stale: z.boolean().optional(),
});
const accountRecordSchema = z.object({
  status: z.enum(['ok', 'stale', 'unavailable', 'signed_out', 'unsupported']),
  identity: z.string().optional(),
  label: z.string().optional(),
  observedAt: count.optional(),
  limits: rateLimitsSchema.optional(),
});
type AccountRecord = z.infer<typeof accountRecordSchema>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = (value: number) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const amount = (value: number) => value.toLocaleString('en-US');
const effortNames: Record<string, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
  none: '关闭',
};

/** Sanitized display cache. Never controls dispatch, permissions, or account resets. */
export class StatusMetrics {
  constructor(
    readonly store: TaskStore,
    readonly owner: string,
  ) {}
  private owned(threadId: string) {
    return !!this.store.db
      .prepare('SELECT 1 FROM threads WHERE thread_id=? AND owner_key=?')
      .get(threadId, this.owner);
  }
  session(threadId: string | null) {
    if (!threadId || !this.owned(threadId)) return undefined;
    const payload = this.store.db
      .prepare('SELECT payload FROM session_metrics WHERE thread_id=?')
      .pluck()
      .get(threadId);
    return typeof payload === 'string' ? sessionSchema.parse(JSON.parse(payload)) : undefined;
  }
  private saveSession(threadId: string, value: z.infer<typeof sessionSchema>) {
    this.store.db
      .prepare(
        'INSERT INTO session_metrics VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET payload=excluded.payload',
      )
      .run(threadId, JSON.stringify(sessionSchema.parse(value)));
  }
  metadata(threadId: string, data: unknown, now = Date.now()) {
    if (!this.owned(threadId)) return;
    const parsed = metadataSchema.safeParse(data);
    if (!parsed.success) return;
    this.saveSession(threadId, {
      ...this.session(threadId),
      ...parsed.data,
      metadataAt: now,
      metadataStale: false,
    });
  }
  metadataUnavailable(threadId: string) {
    if (this.owned(threadId))
      this.saveSession(threadId, { ...this.session(threadId), metadataStale: true });
  }
  history(threadId: string, snapshot: HistoricalUsage) {
    if (!this.owned(threadId)) return;
    const row = { ...this.session(threadId), historyStatus: snapshot.status };
    if (snapshot.compactedAt && snapshot.compactedAt > (row.compactedAt ?? 0)) {
      row.compactedAt = snapshot.compactedAt;
      if (snapshot.compactedAt >= (row.usageAt ?? 0)) {
        row.usage = undefined;
        row.usageAt = undefined;
        row.usageTurn = undefined;
      }
    }
    if (
      snapshot.usage &&
      snapshot.usageAt &&
      snapshot.usageAt > (row.usageAt ?? 0) &&
      snapshot.usageAt > (row.compactedAt ?? 0)
    ) {
      row.usage = snapshot.usage;
      row.usageAt = snapshot.usageAt;
      row.usageSource = 'history';
      // Disk records can replay an inherited count on resume; never attribute it to a turn.
      row.usageTurn = undefined;
    }
    this.saveSession(threadId, row);
  }
  project(projectKey: string) {
    const payload = this.store.db
      .prepare('SELECT payload FROM project_metrics WHERE owner_key=? AND project_key=?')
      .pluck()
      .get(this.owner, projectKey);
    return typeof payload === 'string' ? projectSchema.parse(JSON.parse(payload)) : undefined;
  }
  saveProject(projectKey: string | null, value: z.infer<typeof projectSchema>) {
    this.store.db
      .prepare(
        'INSERT INTO project_metrics VALUES (?,?,?) ON CONFLICT(owner_key,project_key) DO UPDATE SET payload=excluded.payload',
      )
      .run(this.owner, projectKey, JSON.stringify(projectSchema.parse(value)));
  }
  notification(event: RpcNotification, now = Date.now()) {
    if (
      ![
        'thread/settings/updated',
        'thread/tokenUsage/updated',
        'model/rerouted',
        'item/completed',
      ].includes(event.method)
    )
      return;
    const base = z
      .object({ threadId: z.string(), turnId: z.string().optional() })
      .safeParse(event.params);
    if (!base.success || !this.owned(base.data.threadId)) return;
    const { threadId, turnId } = base.data;
    const previous = this.session(threadId) ?? {};
    if (event.method === 'thread/settings/updated') {
      const settings = z
        .object({ threadSettings: z.object({ model: nullableText, effort: nullableText }) })
        .safeParse(event.params);
      if (settings.success)
        this.metadata(
          threadId,
          {
            model: settings.data.threadSettings.model,
            reasoningEffort: settings.data.threadSettings.effort,
          },
          now,
        );
      return;
    }
    // A late update from an older turn must not overwrite a newer turn's usage.
    if (!turnId) return;
    const incoming = this.store.db
      .prepare(
        "SELECT created_at FROM tasks WHERE thread_id=? AND (turn_id=? OR (turn_id IS NULL AND status IN ('starting','unknown'))) AND owner_key=? ORDER BY created_at DESC LIMIT 1",
      )
      .pluck()
      .get(threadId, turnId, this.owner);
    if (typeof incoming !== 'number') return;
    const saved = previous.usageTurn
      ? this.store.db
          .prepare('SELECT created_at FROM tasks WHERE thread_id=? AND turn_id=?')
          .pluck()
          .get(threadId, previous.usageTurn)
      : undefined;
    if (typeof saved === 'number' && saved > incoming) return;
    if (event.method === 'thread/tokenUsage/updated') {
      const parsed = z.object({ tokenUsage: usageSchema }).safeParse(event.params);
      if (parsed.success)
        this.saveSession(threadId, {
          ...previous,
          usage: parsed.data.tokenUsage,
          usageAt: now,
          usageTurn: turnId,
          usageSource: 'live',
        });
    } else if (event.method === 'model/rerouted') {
      const parsed = z.object({ toModel: z.string().max(256) }).safeParse(event.params);
      if (parsed.success)
        this.saveSession(threadId, {
          ...previous,
          routedModel: parsed.data.toModel,
          routedTurn: turnId,
        });
    } else if (event.method === 'item/completed') {
      const parsed = z
        .object({ item: z.object({ type: z.literal('contextCompaction'), id: z.string() }) })
        .safeParse(event.params);
      if (parsed.success && previous.compactedItem !== parsed.data.item.id)
        this.saveSession(threadId, {
          ...previous,
          usage: undefined,
          usageAt: undefined,
          usageTurn: turnId,
          compactedAt: now,
          compactedItem: parsed.data.item.id,
        });
    }
  }
  account() {
    const raw = this.store.db
      .prepare('SELECT payload FROM account_metrics WHERE owner_key=?')
      .pluck()
      .get(this.owner);
    return typeof raw === 'string' ? accountRecordSchema.parse(JSON.parse(raw)) : undefined;
  }
  saveAccount(record: AccountRecord) {
    this.store.db
      .prepare(
        'INSERT INTO account_metrics VALUES (?,?) ON CONFLICT(owner_key) DO UPDATE SET payload=excluded.payload',
      )
      .run(this.owner, JSON.stringify(accountRecordSchema.parse(record)));
  }
  stale() {
    const current = this.account();
    this.saveAccount(current?.limits ? { ...current, status: 'stale' } : { status: 'unavailable' });
  }
  sessionText(
    threadId: string | null,
    turnId: string | null,
    details = false,
    projectKey?: string | null,
    cwd?: string,
  ) {
    const row = this.session(threadId);
    if (!threadId) {
      const defaults = projectKey ? this.project(projectKey) : undefined;
      const current = defaults?.cwd === cwd ? defaults : undefined;
      return (
        `新话题默认模型：${current?.model ?? '尚未获取'} · 默认思考强度：${current?.reasoningEffort ? (effortNames[current.reasoningEffort] ?? current.reasoningEffort) : '未提供'}\n上下文：尚未开始，首次执行后展示用量` +
        (current
          ? `\n默认配置采样：${time(current.observedAt)}${current.stale ? '（刷新失败，保留旧数据）' : ''}`
          : '')
      );
    }
    let text = `会话模型：${row?.model ?? '尚未获取'} · 思考强度：${row?.reasoningEffort ? (effortNames[row.reasoningEffort] ?? row.reasoningEffort) : '默认或未提供'}`;
    if (row?.routedTurn === turnId && row.routedModel) text += `\n本轮路由模型：${row.routedModel}`;
    const usage = row?.usage;
    text += usage
      ? `\n最近请求输入：${amount(usage.last.inputTokens)} Token · 模型窗口：${usage.modelContextWindow ? amount(usage.modelContextWindow) : '未提供'}`
      : '\n上下文用量：尚未获取' +
        (row?.compactedAt
          ? '（压缩后等待新统计）'
          : row?.historyStatus === 'empty'
            ? '（历史未记录 Token 用量）'
            : row?.historyStatus === 'truncated'
              ? '（最近历史中没有统计）'
              : row?.historyStatus === 'unsupported'
                ? '（历史格式暂不支持）'
                : row?.historyStatus === 'unavailable'
                  ? '（历史记录暂不可读）'
                  : '');
    if (details && usage)
      text += `\n最近请求输出：${amount(usage.last.outputTokens)} Token\n最近缓存命中：${amount(usage.last.cachedInputTokens)} Token\n会话累计消耗：${amount(usage.total.totalTokens)} Token（不等于上下文占用）`;
    if (row?.usageAt)
      text += `\n用量采样：${time(row.usageAt)}（${row.usageSource === 'history' ? '历史快照' : '最近收到的统计'}）`;
    if (row?.metadataStale) text += '\n模型信息刷新失败，保留上次采样。';
    if (details && row?.metadataAt) text += `\n模型信息采样：${time(row.metadataAt)}`;
    if (details && row?.compactedAt) text += `\n最近观察到压缩：${time(row.compactedAt)}`;
    return text;
  }
  accountText(model?: string | null, details = false, now = Date.now()) {
    const record = this.account();
    if (!record || record.status === 'unavailable') return '账号额度：暂未获取';
    if (record.status === 'signed_out') return '账号额度：未登录';
    if (record.status === 'unsupported') return '账号额度：当前登录方式未提供 ChatGPT 套餐额度';
    if (!record.limits) return '账号额度：暂未获取';
    const limits = record.limits;
    const buckets =
      limits.rateLimitsByLimitId !== null && limits.rateLimitsByLimitId !== undefined
        ? Object.entries(limits.rateLimitsByLimitId)
        : [[limits.rateLimits.limitId ?? 'codex', limits.rateLimits] as const];
    const relevant = details
      ? buckets
      : buckets.filter(
          ([id, bucket]) => id === 'codex' || (!!model && bucket.normalModelSlug === model),
        );
    const stale = record.status !== 'ok' || !record.observedAt || now - record.observedAt > 180_000;
    const lines = [
      `账号额度：${record.label ?? 'ChatGPT'} · 账号共享${stale ? '（旧数据，待刷新）' : ''}`,
    ];
    if (!relevant.length) lines.push('未提供通用或当前模型的额度窗口');
    for (const [id, bucket] of relevant.slice(0, details ? 8 : 3)) {
      const label = (bucket.limitName ?? id).slice(0, 60);
      let windows = 0;
      for (const [kind, w] of [
        ['主', bucket.primary],
        ['次', bucket.secondary],
      ] as const) {
        if (!w) continue;
        windows++;
        const minutes = w.windowDurationMins;
        const duration = minutes
          ? minutes % 1440 === 0
            ? `${minutes / 1440} 天`
            : minutes % 60 === 0
              ? `${minutes / 60} 小时`
              : `${minutes} 分钟`
          : `${kind}窗口`;
        const remaining = Math.max(0, Math.min(100, 100 - w.usedPercent));
        const reset = w.resetsAt
          ? w.resetsAt * 1000 <= now
            ? '重置时间已到，待服务端确认'
            : `${time(w.resetsAt * 1000)} 重置`
          : '重置时间未提供';
        lines.push(`${label} · ${duration}剩余 ${Math.round(remaining * 10) / 10}% · ${reset}`);
      }
      if (!windows) lines.push(`${label}：窗口数据未提供`);
      if (details && bucket.credits)
        lines.push(
          `${label} 积分：${bucket.credits.unlimited ? '不限额' : (bucket.credits.balance ?? (bucket.credits.hasCredits ? '有可用积分，余额未提供' : '无可用积分'))}`,
        );
    }
    if (relevant.length > (details ? 8 : 3)) lines.push('其他额度分组未展开');
    if (limits.ordinaryUsageAllowed === false) lines.push('服务端当前不允许使用常规套餐额度。');
    if (record.observedAt) lines.push(`额度采样：${time(record.observedAt)}`);
    return lines.join('\n');
  }
}

/** Independent read-only lanes: a slow quota request never delays the session snapshot. */
export class MetricsPoller {
  private revision = 0;
  private closed = false;
  private nextRead = 0;
  private nextAllowed = 0;
  private accountReading: Promise<void> | undefined;
  private readonly sessions = new Map<string, { nextRead: number; reading?: Promise<void> }>();
  codexHome: string | undefined;
  constructor(
    readonly metrics: StatusMetrics,
    private readonly rpc: CodexRpcClient,
    private readonly projects: GatewayConfig['projects'] = [],
  ) {}
  invalidateAccount() {
    this.revision++;
    this.nextRead = 0;
    this.metrics.saveAccount({ status: 'unavailable' });
  }
  request() {
    this.nextRead = 0;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.revision++;
    this.metrics.stale();
  }
  async poll(threadId: string | null, now = Date.now(), projectKey?: string) {
    await Promise.all([
      this.refreshAccount(false, now),
      this.refreshSession(threadId, projectKey, false, now),
    ]);
  }
  async refreshAccount(force = true, now = Date.now()) {
    if (this.closed || !this.rpc.isReady) return;
    if (this.accountReading) return this.accountReading;
    if (now < this.nextAllowed || (!force && now < this.nextRead)) return;
    this.nextAllowed = now + 10_000;
    this.nextRead = now + 60_000;
    this.accountReading = this.readAccount().finally(() => {
      this.accountReading = undefined;
    });
    return this.accountReading;
  }
  async refreshSession(
    threadId: string | null,
    projectKey?: string | null,
    force = true,
    now = Date.now(),
  ) {
    if (this.closed || !this.rpc.isReady || (!threadId && !projectKey)) return;
    // Validate ownership before ANY RPC or local history read.
    if (threadId) {
      try {
        this.metrics.store.ownedThread(threadId, this.metrics.owner);
      } catch {
        return;
      }
    } else if (!this.projects.some((p) => p.key === projectKey)) return;
    const key = threadId ? `thread:${threadId}` : `project:${projectKey}`;
    const existing = this.sessions.get(key);
    if (existing?.reading) return existing.reading;
    if (!force && existing && now < existing.nextRead) return;
    if (this.sessions.size >= 16) {
      const idle = [...this.sessions].find(([, v]) => !v.reading);
      if (idle) this.sessions.delete(idle[0]);
      else return;
    }
    const state: { nextRead: number; reading?: Promise<void> } = { nextRead: now + 60_000 };
    this.sessions.set(key, state);
    state.reading = (threadId ? this.readSession(threadId) : this.readProject(projectKey!)).finally(
      () => {
        delete state.reading;
      },
    );
    return state.reading;
  }
  private async readSession(threadId: string) {
    const beforeRead = this.metrics.session(threadId)?.metadataAt;
    try {
      const owned = this.metrics.store.ownedThread(threadId, this.metrics.owner);
      const { thread } = await this.rpc.request(
        'thread/read',
        { threadId, includeTurns: false },
        z.object({
          thread: metadataSchema.extend({
            id: z.literal(threadId),
            cwd: z.string(),
            path: z.string().nullable().optional(),
          }),
        }),
        5000,
      );
      if (this.closed || !this.rpc.isReady) return;
      if (canonicalDirectory(thread.cwd) !== canonicalDirectory(owned.cwd))
        throw Error('cwd mismatch');
      if (this.metrics.session(threadId)?.metadataAt === beforeRead)
        this.metrics.metadata(threadId, thread);
      const history = await readHistoricalUsage(this.codexHome, thread.path, threadId, owned.cwd);
      if (!this.closed && this.rpc.isReady) this.metrics.history(threadId, history);
    } catch {
      if (!this.closed && this.metrics.session(threadId)?.metadataAt === beforeRead)
        this.metrics.metadataUnavailable(threadId);
    }
  }
  private async readProject(projectKey: string) {
    const project = this.projects.find((p) => p.key === projectKey);
    if (!project) return;
    try {
      const cwd = canonicalDirectory(project.root);
      const [response, managed] = await Promise.all([
        this.rpc.request(
          'config/read',
          { cwd, includeLayers: false },
          z.object({
            config: z.object({ model: nullableText, model_reasoning_effort: nullableText }),
            origins: z
              .record(
                z.string(),
                z.object({
                  name: z.object({
                    type: z.string(),
                    profile: nullableText,
                  }),
                }),
              )
              .optional(),
          }),
          5000,
        ),
        this.rpc.request(
          'configRequirements/read',
          undefined,
          z.object({
            requirements: z
              .object({
                models: z
                  .object({
                    newThread: z
                      .object({
                        model: nullableText,
                        modelReasoningEffort: nullableText,
                      })
                      .nullish(),
                  })
                  .nullish(),
              })
              .nullable(),
          }),
          5000,
        ),
      ]);
      if (this.closed || !this.rpc.isReady) return;
      const explicit = ['model', 'model_reasoning_effort'].some((key) => {
        const origin = response.origins?.[key]?.name;
        return origin?.type === 'sessionFlags' || !!origin?.profile;
      });
      const defaults = explicit ? undefined : managed.requirements?.models?.newThread;
      let model = defaults?.model ?? response.config.model;
      let effort = defaults?.modelReasoningEffort ?? response.config.model_reasoning_effort;
      if (!model || !effort) {
        try {
          const models = await this.rpc.request(
            'model/list',
            { limit: 100, includeHidden: true },
            z.object({
              data: z.array(
                z.object({
                  model: z.string(),
                  isDefault: z.boolean(),
                  defaultReasoningEffort: nullableText,
                }),
              ),
            }),
            5000,
          );
          const match = model
            ? models.data.find((m) => m.model === model)
            : models.data.find((m) => m.isDefault);
          model ??= match?.model;
          effort ??= match?.defaultReasoningEffort;
        } catch {
          /* Keep explicit config values; never guess an unknown model's effort. */
        }
      }
      if (!this.closed && this.rpc.isReady)
        this.metrics.saveProject(projectKey, {
          cwd,
          model,
          reasoningEffort: effort,
          observedAt: Date.now(),
        });
    } catch {
      if (!this.closed) {
        const old = this.metrics.project(projectKey);
        if (old) this.metrics.saveProject(projectKey, { ...old, stale: true });
      }
    }
  }
  private async readAccount() {
    const revision = this.revision;
    const current = () => !this.closed && revision === this.revision && this.rpc.isReady;
    try {
      const { account } = await this.rpc.request(
        'account/read',
        { refreshToken: false },
        accountSchema,
        5000,
      );
      if (!current()) return;
      if (!account) this.metrics.saveAccount({ status: 'signed_out' });
      else if (account.type !== 'chatgpt') this.metrics.saveAccount({ status: 'unsupported' });
      else {
        const identity = hash([account.type, account.email, account.planType]);
        if (this.metrics.account()?.identity !== identity)
          this.metrics.saveAccount({ status: 'unavailable', identity });
        const limits = await this.rpc.request(
          'account/rateLimits/read',
          { excludeResetCreditDetails: true },
          rateLimitsSchema,
          5000,
        );
        if (!current()) return;
        this.metrics.saveAccount({
          status: 'ok',
          identity,
          label: `ChatGPT${account.planType ? ' ' + account.planType : ''}`,
          limits,
          observedAt: Date.now(),
        });
      }
    } catch {
      if (current()) this.metrics.stale();
    }
  }
}
