import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { assertLocalConfigIsProtected } from './local-boundary.js';
import { remoteProjectCreationSchema } from './remote-projects.js';
import { validateCreationRoot } from '../projects/remote.js';
import {
  hasOneProjectPolicy,
  maxConcurrentTasksSchema,
  projectAccessFields,
} from './project-policy.js';

const absolutePath = z.string().min(1).refine(isAbsolute, '必须是绝对路径');
const identifier = z.string().min(1);
export const servicePolicySchema = z.strictObject({
  logMaxBytes: z
    .number()
    .int()
    .min(65536)
    .max(50 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  logFiles: z.number().int().min(1).max(20).default(5),
  backupIntervalHours: z.number().int().min(1).max(24).default(24),
  backupsToKeep: z.number().int().min(2).max(90).default(7),
  contentRetentionDays: z.number().int().min(7).max(3650).default(30),
});

export function isPrivateEndpoint(value: string): boolean {
  if (value.startsWith('unix://')) {
    const path = value.slice('unix://'.length);
    return isAbsolute(path) && !/[\0:?#]/.test(path);
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'ws:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.search === ''
    );
  } catch {
    return false;
  }
}

export const gatewayConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  dataDir: absolutePath,
  codex: z.strictObject({
    binary: identifier,
    endpoint: z.string().refine(isPrivateEndpoint, '只允许 Unix socket 或 loopback WebSocket'),
    sandbox: z.literal('workspace-write'),
    approvalPolicy: z.literal('on-request'),
    approvalsReviewer: z.literal('user'),
  }),
  feishu: z
    .strictObject({
      appId: identifier,
      tenantKey: identifier,
      allowedOpenId: identifier,
      credentialsFile: absolutePath.optional(),
      credentialsSource: z.literal('desktop').optional(),
    })
    .refine(
      (value) => Boolean(value.credentialsFile) !== Boolean(value.credentialsSource),
      '必须指定文件凭据或桌面安全存储，不能同时指定',
    ),
  projectless: z.strictObject({ enabled: z.boolean() }).optional(),
  maxConcurrentTasks: maxConcurrentTasksSchema,
  remoteProjectCreation: remoteProjectCreationSchema.optional(),
  hiddenProjectRoots: z.array(absolutePath).max(500).optional(),
  service: servicePolicySchema.optional(),
  notify: z
    .strictObject({
      port: z.number().int().min(1024).max(65535),
      tokenFile: absolutePath,
      spoolDir: absolutePath,
      projectKeys: z.array(identifier).min(1),
      // Explicit opt-in only after G3. No failure/interrupt events are assumed.
      verifiedEvents: z.array(z.literal('agent-turn-complete')).length(1),
    })
    .optional(),
  projects: z
    .array(
      z
        .strictObject({
          key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
          name: identifier,
          root: absolutePath,
          directoryIdentity: z.object({ dev: z.number(), ino: z.number() }).optional(),
          ...projectAccessFields,
        })
        .refine(hasOneProjectPolicy, '必须且只能指定 remotePermissions 或旧版 remoteWrite'),
    )
    .refine(
      (projects) => new Set(projects.map((project) => project.key)).size === projects.length,
      '项目 key 不能重复',
    ),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

export function runtimePaths(dataDir = join(homedir(), '.codex-feishu')) {
  return {
    dataDir,
    configFile: join(dataDir, 'config.json'),
    credentialsFile: join(dataDir, 'credentials.json'),
    database: join(dataDir, 'gateway.sqlite'),
    socket: join(dataDir, 'app-server.sock'),
    logs: join(dataDir, 'logs'),
    backups: join(dataDir, 'backups'),
  };
}

export function resolveConfigPath(explicit?: string): string {
  const path = explicit ?? process.env.CODEX_FEISHU_CONFIG ?? runtimePaths().configFile;
  if (!isAbsolute(path)) throw new ConfigurationError('配置文件路径必须为绝对路径');
  return path;
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    throw new ConfigurationError('无法读取配置文件');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ConfigurationError('配置文件不是有效 JSON');
  }
  const result = gatewayConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'} [${issue.code}]`,
    );
    throw new ConfigurationError(`配置校验失败：${issues.join('；')}`);
  }
  assertLocalConfigIsProtected(result.data.projects, [
    path,
    result.data.dataDir,
    ...(result.data.feishu.credentialsFile ? [result.data.feishu.credentialsFile] : []),
  ]);
  validateCreationRoot(result.data, [
    path,
    result.data.dataDir,
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    ...(result.data.feishu.credentialsFile ? [result.data.feishu.credentialsFile] : []),
  ]);
  return result.data;
}
