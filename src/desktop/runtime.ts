import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { assertLocalConfigIsProtected } from '../config/local-boundary.js';
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayConfigSchema, servicePolicySchema, type GatewayConfig } from '../config/schema.js';
import {
  credentialsSchema,
  gatewayCredentials,
  type FeishuCredentials,
} from '../feishu/credentials.js';
import { canonicalDirectory } from '../projects/store.js';
import { validateCreationRoot } from '../projects/remote.js';
import { privateDirectory, processAlive } from '../service/files.js';
import { processGroupAlive } from '../service/child.js';
import { readHealth, roles, ServiceLeases } from '../service/state.js';
import { runService } from '../service/runner.js';
import type { ServiceManifest } from '../service/plan.js';
import { legacyConfigFor, legacySettingsSchema, type LegacySettings } from './legacy.js';
import { loaded } from '../cli/service.js';
import { inspectTaskDatabase, runDoctor, doctorMessage } from '../cli/doctor.js';
import { CodexRpcClient } from '../codex/rpc-client.js';
import { prepareDesktopDatabase } from './database.js';
import {
  desktopSettingsSchema,
  stoppedStatus,
  type DesktopSettings,
  type DesktopStatus,
} from './contracts.js';

export const runtimeInputSchema = z.strictObject({
  settings: desktopSettingsSchema,
  dataDir: z.string().refine(isAbsolute),
  credentials: credentialsSchema,
  legacy: legacySettingsSchema.optional(),
});
export type RuntimeInput = z.infer<typeof runtimeInputSchema>;
export function validateSettings(
  settings: DesktopSettings,
  credentials: FeishuCredentials,
  legacy?: LegacySettings,
) {
  credentialsSchema.parse(credentials);
  if (!isAbsolute(settings.codexBinary)) throw new Error('请选择 Codex 可执行文件的绝对路径');
  const roots = new Set<string>();
  for (const project of settings.projects) {
    const root = canonicalDirectory(project.root);
    if (roots.has(root)) throw new Error('同一目录不能重复添加为多个项目');
    roots.add(root);
  }
  validateCreationRoot(settings, [process.env.CODEX_HOME ?? join(homedir(), '.codex')]);
  return gatewayConfigSchema.parse({
    ...legacyConfigFor(settings, legacy),
    schemaVersion: 1,
    dataDir: '/placeholder',
    codex: {
      binary: settings.codexBinary,
      endpoint: 'unix:///placeholder/rpc.sock',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    },
    feishu: {
      appId: settings.feishu.appId,
      tenantKey: settings.feishu.tenantKey,
      allowedOpenId: settings.feishu.allowedOpenId,
      credentialsSource: 'desktop',
    },
    projects: settings.projects,
    projectless: settings.projectless ?? { enabled: true },
    maxConcurrentTasks: settings.maxConcurrentTasks,
    remoteProjectCreation: settings.remoteProjectCreation,
    hiddenProjectRoots: settings.hiddenProjectRoots,
  });
}
export class DesktopRuntime {
  private appAbort: AbortController | undefined;
  private gatewayAbort: AbortController | undefined;
  private appDone: Promise<number> | undefined;
  private gatewayDone: Promise<number> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private startup: Promise<DesktopStatus> | undefined;
  private stopRequested = false;
  private lease: { db: ServiceLeases; token: string } | undefined;
  private config: GatewayConfig | undefined;
  private phase: DesktopStatus['phase'] = 'stopped';
  private error: string | null = null;
  status(): DesktopStatus {
    if (!this.config) return { ...stoppedStatus(), phase: this.phase, error: this.error };
    const app = readHealth(this.config.dataDir, 'app-server');
    const gateway = readHealth(this.config.dataDir, 'gateway');
    const database = inspectTaskDatabase(this.config.dataDir);
    const tasks = z
      .array(z.object({ status: z.string(), count: z.number() }))
      .catch([])
      .parse(database.statuses);
    const pending = tasks
      .filter((t) => !['completed', 'failed', 'interrupted'].includes(t.status))
      .reduce((n, t) => n + t.count, 0);
    return {
      phase: ['stopped', 'stopping', 'error'].includes(this.phase)
        ? this.phase
        : app.ready && gateway.ready
          ? 'ready'
          : this.phase === 'starting'
            ? 'starting'
            : 'degraded',
      ...('projectless' in gateway && gateway.projectless
        ? { projectless: gateway.projectless }
        : {}),
      rpcReady: app.ready && gateway.rpcReady,
      feishuConnected: gateway.feishuConnected,
      tasks,
      pending,
      error:
        this.error ??
        ('error' in gateway ? gateway.error : null) ??
        ('error' in app ? app.error : null),
    };
  }
  async start(raw: RuntimeInput) {
    if (this.startup) throw new Error('服务正在启动');
    this.stopRequested = false;
    const operation = this.startInternal(raw);
    this.startup = operation;
    try {
      return await operation;
    } finally {
      this.startup = undefined;
    }
  }
  private async startInternal(raw: RuntimeInput) {
    if (!['stopped', 'error'].includes(this.phase) || this.appDone || this.gatewayDone)
      throw new Error('服务已启动或正在切换');
    const input = runtimeInputSchema.parse(raw);
    const config = validateSettings(input.settings, input.credentials, input.legacy);
    assertLocalConfigIsProtected(config.projects, [input.dataDir]);
    validateCreationRoot(config, [input.dataDir]);
    gatewayCredentials(config, input.credentials);
    for (const role of roles)
      if (loaded(role))
        throw new Error('检测到已有开发服务，请先在本机停止原 LaunchAgent，再启动 App 连接');
    const doctor = await runDoctor(input.settings.codexBinary);
    if (this.stopRequested) throw new Error('启动已取消');
    if (doctor.status !== 'ok') throw new Error(doctorMessage(doctor));
    config.codex.binary = doctor.codexBinary;
    const codexHome = realpathSync(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    const binary = realpathSync(doctor.codexBinary);
    privateDirectory(input.dataDir);
    const lockRoot = `/private/tmp/cc-${process.getuid!()}`;
    privateDirectory(lockRoot);
    const key = createHash('sha256').update(input.settings.feishu.appId).digest('hex').slice(0, 24);
    const socketDir = join(lockRoot, key);
    privateDirectory(socketDir);
    const leases = new ServiceLeases(socketDir);
    try {
      this.lease = { db: leases, token: leases.acquire('gateway') };
    } catch (e) {
      leases.close();
      throw e;
    }
    config.dataDir = input.dataDir;
    config.codex.endpoint = `unix://${join(socketDir, 'rpc.sock')}`;
    this.config = config;
    this.phase = 'starting';
    this.error = null;
    this.appAbort = new AbortController();
    this.gatewayAbort = new AbortController();
    const manifest: ServiceManifest = {
      schemaVersion: 1,
      application: 'CodexConnector',
      uid: process.getuid!(),
      preparedAt: new Date().toISOString(),
      configPath: join(input.dataDir, 'desktop-owned'),
      configHash: '',
      dataDir: input.dataDir,
      node: process.execPath,
      binary,
      entry: process.argv[1]!,
      buildHash: '',
      codexHome,
      policy: config.service ?? servicePolicySchema.parse({}),
      plistHashes: { 'app-server': '', gateway: '' },
    };
    const validate = async () => {
      const current = await runDoctor(manifest.binary);
      if (current.status !== 'ok') throw new Error(doctorMessage(current));
      if (current.codexBinary !== manifest.binary)
        throw new Error('Codex 安装路径已变化，请停止后重新启动');
      return config;
    };
    const failed = () => {
      this.error = '后端异常退出，请停止后检查日志';
      this.phase = 'error';
      return 1;
    };
    try {
      await prepareDesktopDatabase(input.dataDir, this.appAbort.signal);
      if (this.stopRequested) throw new Error('启动已取消');
      this.appDone = runService(manifest, 'app-server', {
        desktop: true,
        signal: this.appAbort.signal,
        validate,
        onChild: (pid) => this.lease?.db.child(this.lease.token, pid, true),
      }).catch(failed);
      const deadline = Date.now() + 35_000;
      while (
        !readHealth(input.dataDir, 'app-server').ready &&
        Date.now() < deadline &&
        !this.stopRequested &&
        !this.error
      )
        await delay(100);
      if (this.stopRequested) throw new Error('启动已取消');
      if (!readHealth(input.dataDir, 'app-server').ready)
        throw new Error('Codex 后端未就绪，请检查版本与日志');
      const rpc = new CodexRpcClient({ endpoint: config.codex.endpoint });
      try {
        await rpc.connect();
        const result = await rpc.request(
          'account/read',
          { refreshToken: false },
          z.object({ account: z.unknown().nullable() }),
          5000,
        );
        if (!result.account) throw new Error('Codex 尚未登录，请先在 Codex 中登录');
      } finally {
        rpc.close();
      }
      if (this.stopRequested) throw new Error('启动已取消');
      this.gatewayDone = runService(manifest, 'gateway', {
        desktop: true,
        signal: this.gatewayAbort.signal,
        credentials: input.credentials,
        validate,
      }).catch(failed);
      this.phase = 'degraded';
    } catch (error) {
      await this.performStop();
      throw error;
    }
    return this.status();
  }
  async stop() {
    this.stopRequested = true;
    if (this.startup) this.appAbort?.abort();
    if (this.startup) await this.startup.catch(() => {});
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return this.status();
    }
    this.shutdownPromise = this.performStop();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = undefined;
    }
    return this.status();
  }
  private async performStop() {
    this.phase = 'stopping';
    this.gatewayAbort?.abort();
    await this.gatewayDone;
    this.gatewayDone = undefined;
    this.appAbort?.abort();
    const appResult = await this.appDone;
    this.appDone = undefined;
    if (this.lease) {
      if (appResult === 1) {
        this.phase = 'error';
        this.error = '后端清理尚未确认，保留运行锁；请检查日志后重试停止';
        throw new Error(this.error);
      }
      // A failed earlier stop may have left a detached group after its leader died.
      const record = this.lease.db.list().find((row) => row.token === this.lease?.token);
      if (
        record?.child_pid !== null &&
        record?.child_pid !== undefined &&
        (record.child_pid < 0
          ? processGroupAlive(-record.child_pid)
          : processAlive(record.child_pid))
      ) {
        this.phase = 'error';
        this.error = '自有子进程清理尚未确认，保留运行锁';
        throw new Error(this.error);
      }
      this.lease.db.release(this.lease.token);
      this.lease.db.close();
      this.lease = undefined;
    }
    this.phase = 'stopped';
    this.error = null;
  }
}
