import type { StatusMetrics } from '../tasks/status-metrics.js';
import { cardTime, type CardLayout, type CardSection } from './card-layout.js';

const amount = (value: number) => `${value.toLocaleString('en-US')} Token`;
const efforts: Record<string, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
  none: '关闭',
};

export function sessionSections(
  metrics: StatusMetrics,
  threadId: string | null,
  turnId: string | null,
  projectKey: string | null,
  cwd: string | undefined,
  details = false,
): CardSection[] {
  const row = metrics.session(threadId);
  const saved = threadId || !projectKey ? undefined : metrics.project(projectKey);
  const defaults = saved?.cwd === cwd ? saved : undefined;
  const model = threadId ? row?.model : defaults?.model;
  const effort = threadId ? row?.reasoningEffort : defaults?.reasoningEffort;
  const sections: CardSection[] = [
    {
      title: threadId ? '模型设置' : '新话题默认设置',
      fields: [
        { label: threadId ? '会话模型' : '默认模型', value: model ?? '尚未获取' },
        {
          label: threadId ? '思考强度' : '默认思考强度',
          value: effort ? (efforts[effort] ?? effort) : '默认或未提供',
        },
      ],
      notes: [
        ...(row?.routedTurn === turnId && row?.routedModel
          ? [`本轮路由模型：${row.routedModel}`]
          : []),
        ...(row?.metadataStale || defaults?.stale ? ['模型信息刷新失败，保留上次采样。'] : []),
        ...(defaults ? [`默认配置采样：${cardTime(defaults.observedAt)}（北京时间）`] : []),
        ...(details && row?.metadataAt
          ? [`模型信息采样：${cardTime(row.metadataAt)}（北京时间）`]
          : []),
      ],
    },
  ];
  const usage = row?.usage;
  sections.push(
    usage
      ? {
          title: '上下文与用量',
          fields: [
            { label: '最近请求输入', value: amount(usage.last.inputTokens) },
            {
              label: '模型窗口',
              value: usage.modelContextWindow ? amount(usage.modelContextWindow) : '未提供',
            },
            ...(details
              ? [
                  { label: '最近请求输出', value: amount(usage.last.outputTokens) },
                  { label: '最近缓存命中', value: amount(usage.last.cachedInputTokens) },
                  { label: '会话累计消耗', value: amount(usage.total.totalTokens) },
                ]
              : []),
          ],
          notes: [
            ...(row.usageAt
              ? [
                  `用量采样：${cardTime(row.usageAt)}（${row.usageSource === 'history' ? '历史快照' : '最近收到的统计'}）`,
                ]
              : []),
            '最近请求输入不等于实时上下文占用。' +
              (details ? '会话累计消耗也不等于上下文占用。' : ''),
            ...(details && row.compactedAt ? [`最近观察到压缩：${cardTime(row.compactedAt)}`] : []),
          ],
        }
      : {
          title: '上下文与用量',
          text: !threadId
            ? '尚未开始，首次执行后展示用量。'
            : row?.compactedAt
              ? '压缩后等待新统计。'
              : '上下文用量：尚未获取',
          notes: threadId
            ? [
                row?.historyStatus === 'empty'
                  ? '历史未记录 Token 用量。'
                  : row?.historyStatus === 'truncated'
                    ? '最近历史中没有统计。'
                    : row?.historyStatus === 'unsupported'
                      ? '历史格式暂不支持。'
                      : row?.historyStatus === 'unavailable'
                        ? '历史记录暂不可读。'
                        : '收到统计后自动更新。',
              ]
            : [],
        },
  );
  return sections;
}

export function quotaLayout(metrics: StatusMetrics, now = Date.now()): CardLayout {
  const record = metrics.account();
  const layout: CardLayout = {
    version: 1,
    eyebrow: '账号用量 · 全部任务共享',
    heading: record?.label ?? '账号剩余额度',
    theme: 'blue',
    alerts: [],
    sections: [],
    notes: [
      '数据来自当前 Gateway 登录账号；使用 /额度 刷新。',
      '时间均为北京时间；进度条表示剩余额度。',
    ],
  };
  if (!record?.limits || ['unavailable', 'signed_out', 'unsupported'].includes(record.status)) {
    layout.sections.push({ title: '额度状态', text: metrics.accountText(null, true, now) });
    return layout;
  }
  const stale = record.status !== 'ok' || !record.observedAt || now - record.observedAt > 180_000;
  if (stale) {
    layout.theme = 'orange';
    layout.alerts.push('旧数据，待刷新；以下为上次采样结果。');
  }
  if (record.limits.ordinaryUsageAllowed === false) {
    layout.theme = 'orange';
    layout.alerts.push('服务端当前不允许使用常规套餐额度。');
  }
  const buckets =
    record.limits.rateLimitsByLimitId != null
      ? Object.entries(record.limits.rateLimitsByLimitId)
      : [[record.limits.rateLimits.limitId ?? 'codex', record.limits.rateLimits] as const];
  for (const [id, bucket] of buckets.slice(0, 8)) {
    const meters = [];
    for (const [kind, w] of [
      ['主', bucket.primary],
      ['次', bucket.secondary],
    ] as const) {
      if (!w) continue;
      const m = w.windowDurationMins;
      const duration = m
        ? m % 1440 === 0
          ? `${m / 1440} 天`
          : m % 60 === 0
            ? `${m / 60} 小时`
            : `${m} 分钟`
        : `${kind}窗口`;
      meters.push({
        label: duration,
        remaining: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        reset: w.resetsAt
          ? w.resetsAt * 1000 <= now
            ? '重置时间已到，待服务端确认'
            : `${cardTime(w.resetsAt * 1000)} 重置`
          : '重置时间未提供',
      });
    }
    layout.sections.push({
      title: (bucket.limitName ?? id).slice(0, 60),
      meters,
      notes: [
        ...(!meters.length ? ['窗口数据未提供'] : []),
        ...(bucket.credits
          ? [
              `积分：${bucket.credits.unlimited ? '不限额' : (bucket.credits.balance ?? (bucket.credits.hasCredits ? '有可用积分，余额未提供' : '无可用积分'))}`,
            ]
          : []),
      ],
    });
  }
  if (!buckets.length) layout.sections.push({ title: '额度窗口', text: '服务端未提供额度窗口。' });
  if (buckets.length > 8) layout.notes.push('其他额度分组未展开。');
  if (record.observedAt) layout.notes.push(`额度采样：${cardTime(record.observedAt)}`);
  return layout;
}
