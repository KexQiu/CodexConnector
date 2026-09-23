import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../../src/config/schema.ts';
import { readManifest, validateManifest } from '../../src/service/plan.ts';
import { roles, readHealth } from '../../src/service/state.ts';
import { readPrivate, servicePaths, writeJson } from '../../src/service/files.ts';
import { inspectTaskDatabase } from '../../src/cli/doctor.ts';

const manualCases = [
  'user-login-autostart',
  'network-switch',
  'lock-screen',
  'sleep-wake',
  'task-terminal-and-outbox-review',
];

const { values } = parseArgs({
  options: { config: { type: 'string' }, start: { type: 'boolean' }, help: { type: 'boolean' } },
});
if (!values.config || values.help) {
  console.log(
    'pnpm service:trial --config /absolute/config.json [--start]\n--start 在两个服务就绪时记录一次起点，不覆盖既有试运行。默认只读统计样本、断线和时间缺口。满 24 小时仍需人工审核任务/通知和登录、锁屏、休眠、网络切换记录，不自动判定 PASS，也不设置定时提醒。',
  );
  process.exit(values.help ? 0 : 1);
}
process.umask(0o077);
const config = await loadConfig(values.config),
  manifest = readManifest(config.dataDir);
await validateManifest(manifest);
const paths = servicePaths(config.dataDir),
  trialPath = join(paths.root, 'trial.json');
const health = Object.fromEntries(roles.map((role) => [role, readHealth(config.dataDir, role)]));
const database = inspectTaskDatabase(config.dataDir);
if (values.start && !existsSync(trialPath)) {
  if (!roles.every((role) => health[role].ready) || database.status !== 'ok')
    throw new Error('两个服务与数据库必须就绪后才能开始试运行');
  writeJson(trialPath, {
    startedAt: new Date().toISOString(),
    minimumHours: 24,
    buildHash: manifest.buildHash,
    configHash: manifest.configHash,
  });
}
if (!existsSync(trialPath)) throw new Error('尚未开始试运行；使用 --start 记录实际起点');
const trial = z
  .object({
    startedAt: z.iso.datetime(),
    minimumHours: z.literal(24),
    buildHash: z.string(),
    configHash: z.string(),
    skippedManualEvidence: z
      .array(
        z.object({
          case: z.enum(manualCases),
          status: z.literal('SKIPPED_BY_USER'),
          recordedAt: z.iso.datetime(),
          countsAsPassed: z.literal(false),
        }),
      )
      .default([]),
  })
  .parse(JSON.parse(readPrivate(trialPath)));
const start = Date.parse(trial.startedAt),
  now = Date.now();
const samples = Object.fromEntries(
  roles.map((role) => {
    let malformedLines = 0;
    const rows = [];
    for (const file of readdirSync(paths.logs).filter(
      (name) => name === `${role}.jsonl` || new RegExp(`^${role}\\.jsonl\\.\\d+$`).test(name),
    )) {
      for (const line of readPrivate(join(paths.logs, file), 51 * 1024 * 1024)
        .split('\n')
        .filter(Boolean)) {
        try {
          const row = JSON.parse(line);
          if (row.event === 'sample' && typeof row.at === 'string' && Date.parse(row.at) >= start)
            rows.push(row);
        } catch {
          malformedLines++;
        }
      }
    }
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const times = [start, ...rows.map((row) => Date.parse(row.at)), now];
    const gaps = times.slice(1).map((time, index) => time - times[index]);
    return [
      role,
      {
        count: rows.length,
        notReadySamples: rows.filter((row) => !row.ready).length,
        gapsOverTwoMinutes: gaps.filter((gap) => gap > 120_000).length,
        longestGapSeconds: Math.round(Math.max(0, ...gaps) / 1000),
        malformedLines,
        current: health[role],
      },
    ];
  }),
);
const elapsedHours = Math.max(0, now - start) / 3600_000;
const unchanged =
  trial.buildHash === manifest.buildHash && trial.configHash === manifest.configHash;
console.log(
  JSON.stringify(
    {
      status:
        !unchanged || now < start
          ? 'NEEDS_REVIEW'
          : elapsedHours < 24
            ? 'OBSERVING'
            : 'NEEDS_MANUAL_ACCEPTANCE',
      startedAt: trial.startedAt,
      earliestReviewAt: new Date(start + 24 * 3600_000).toISOString(),
      elapsedHours: Math.round(elapsedHours * 1000) / 1000,
      deploymentUnchanged: unchanged,
      samples,
      database,
      requiredManualEvidence: manualCases.filter(
        (name) => !trial.skippedManualEvidence.some((item) => item.case === name),
      ),
      skippedManualEvidence: trial.skippedManualEvidence,
      scope: 'local-log-summary-only; no scheduler or automatic acceptance',
    },
    null,
    2,
  ),
);
