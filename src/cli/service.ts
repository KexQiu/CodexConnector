import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import { runtimePaths } from '../config/schema.js';
import {
  openGatewayDatabase,
  openReadonlyDatabase,
  backupGatewayDatabase,
} from '../persistence/database.js';
import { TaskStore } from '../tasks/store.js';
import { TaskError } from '../tasks/types.js';
import { processAlive, readPrivate, servicePaths } from '../service/files.js';
import {
  digest,
  labels,
  prepareServices,
  readManifest,
  validateManifest,
  type ServiceManifest,
} from '../service/plan.js';
import { roles, readHealth, ServiceLeases, type ServiceRole } from '../service/state.js';
import { runService } from '../service/runner.js';
import { maintain, restoreCopy } from '../service/maintenance.js';
import { inspectTaskDatabase } from './doctor.js';

const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const domain = () => `gui/${process.getuid!()}`;
const target = (role: ServiceRole) => `${domain()}/${labels[role]}`;
export function loaded(role: ServiceRole, expectedPath?: string) {
  try {
    const report = execFileSync('/bin/launchctl', ['print', target(role)], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (
      expectedPath &&
      !report.split('\n').some((line) => line.trim() === `path = ${expectedPath}`)
    )
      throw new TaskError('launchd 已加载服务来源不匹配，拒绝操作');
    return true;
  } catch (error) {
    if (error instanceof TaskError) throw error;
    // launchctl uses 113 for missing services. Other errors cannot prove absence.
    if (error && typeof error === 'object' && 'status' in error && error.status === 113)
      return false;
    throw new TaskError('无法读取 launchd 服务状态');
  }
}
const installedPath = (role: ServiceRole) =>
  join(homedir(), 'Library', 'LaunchAgents', `${labels[role]}.plist`);
function ownedPlist(manifest: ServiceManifest, role: ServiceRole) {
  const path = installedPath(role);
  if (digest(readPrivate(path)) !== manifest.plistHashes[role])
    throw new TaskError('LaunchAgent 与部署清单不匹配，拒绝操作');
  return path;
}
function launch(args: string[]) {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'pipe', timeout: 65_000 });
  } catch {
    throw new TaskError('launchctl 操作失败；请运行 service-status 核对实际状态');
  }
}
export function assertQuietDatabase(config: GatewayConfig) {
  const path = runtimePaths(config.dataDir).database;
  if (!existsSync(path)) return;
  const db = openReadonlyDatabase(path);
  try {
    if (db.pragma('application_id', { simple: true }) !== 0x43465847)
      throw new TaskError('拒绝操作非 Gateway 数据库');
    for (const table of ['worker_lease', 'feishu_runtime_lease']) {
      const pids = z.array(z.number()).parse(db.prepare(`SELECT pid FROM ${table}`).pluck().all());
      if (pids.some(processAlive)) throw new TaskError('请先停止前台 Gateway/worker');
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM tasks WHERE status NOT IN ('completed','failed','interrupted') LIMIT 1",
        )
        .get()
    )
      throw new TaskError('存在排队、执行中或未知任务；先核对并排空，再升级部署');
  } finally {
    db.close();
  }
}
export async function runServiceCli(
  command: string,
  positionals: string[],
  options: { destination?: string | undefined; backup?: string | undefined },
  configPath: string,
  config: GatewayConfig,
) {
  process.umask(0o077);
  if (process.platform !== 'darwin') throw new TaskError('服务管理仅支持 macOS');
  if (positionals.length !== (command === 'service-run' ? 2 : 1))
    throw new TaskError('服务命令参数无效');
  if (command === 'service-prepare') {
    for (const role of roles) if (loaded(role)) throw new TaskError('先 service-stop 再准备升级');
    for (const role of roles)
      if (existsSync(installedPath(role)))
        throw new TaskError('重新部署前先 service-uninstall 移除旧 plist；数据和凭据会保留');
    assertQuietDatabase(config);
    const manifest = await prepareServices(configPath);
    const path = runtimePaths(config.dataDir).database;
    if (existsSync(path)) {
      const existing = openReadonlyDatabase(path);
      try {
        await backupGatewayDatabase(
          existing,
          join(servicePaths(config.dataDir).backups, `before-prepare-${Date.now()}.sqlite`),
        );
      } finally {
        existing.close();
      }
    }
    const db = openGatewayDatabase(path);
    try {
      new TaskStore(db);
    } finally {
      db.close();
    }
    output({
      status: 'prepared',
      manifest: servicePaths(config.dataDir).manifest,
      plists: roles.map((role) => join(servicePaths(config.dataDir).root, `${labels[role]}.plist`)),
      node: manifest.node,
      codex: manifest.binary,
      installed: false,
    });
    return 0;
  }
  const manifest = readManifest(config.dataDir);
  if (command === 'service-run') return runService(manifest, z.enum(roles).parse(positionals[1]));
  if (command === 'service-status') {
    const app = readHealth(config.dataDir, 'app-server'),
      gateway = readHealth(config.dataDir, 'gateway');
    const database = inspectTaskDatabase(config.dataDir);
    const ready = app.ready && gateway.ready && database.status === 'ok';
    output({
      healthy: app.healthy && gateway.healthy,
      ready,
      feishuConnected: gateway.feishuConnected,
      components: { appServer: app, gateway },
      launchd: Object.fromEntries(roles.map((role) => [role, loaded(role)])),
      database,
    });
    return ready ? 0 : 2;
  }
  if (command === 'service-maintain') {
    output(await maintain(manifest, true));
    return 0;
  }
  if (command === 'service-restore-check') {
    if (!options.backup || !options.destination)
      throw new TaskError('需要 --backup 和新的 --destination，目标父目录必须为 700');
    output(await restoreCopy(options.backup, options.destination));
    return 0;
  }
  if (command === 'service-install' || command === 'service-start') {
    await validateManifest(manifest);
    const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(launchAgents, { recursive: true, mode: 0o755 });
    const stat = lstatSync(launchAgents);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new TaskError('LaunchAgents 目录不安全');
    // Validate BOTH targets before changing either one.
    for (const role of roles) {
      if (existsSync(installedPath(role))) {
        ownedPlist(manifest, role);
        loaded(role, installedPath(role));
      } else if (loaded(role) || command === 'service-start')
        throw new TaskError('已有未知服务或缺少已安装的 plist');
      const prepared = readPrivate(
        join(servicePaths(config.dataDir).root, `${labels[role]}.plist`),
      );
      if (digest(prepared) !== manifest.plistHashes[role])
        throw new TaskError('待安装 plist 校验失败');
    }
    const started: ServiceRole[] = [];
    try {
      for (const role of roles) {
        const path = installedPath(role);
        if (!existsSync(path))
          writeFileSync(
            path,
            readPrivate(join(servicePaths(config.dataDir).root, `${labels[role]}.plist`)),
            { flag: 'wx', mode: 0o600 },
          );
        if (!loaded(role)) {
          launch(['bootstrap', domain(), path]);
          started.push(role);
        }
      }
    } catch (error) {
      for (const role of started.reverse()) launch(['bootout', target(role)]);
      throw error;
    }
    output({ status: 'started', labels, next: 'service-status；就绪与实际飞书连接需独立核实' });
    return 0;
  }
  if (command === 'service-stop' || command === 'service-uninstall') {
    for (const role of roles)
      if (loaded(role) || existsSync(installedPath(role))) {
        ownedPlist(manifest, role);
        loaded(role, installedPath(role));
      }
    for (const role of [...roles].reverse()) if (loaded(role)) launch(['bootout', target(role)]);
    const leases = new ServiceLeases(config.dataDir);
    try {
      const deadline = Date.now() + 15_000;
      while (leases.active().length && Date.now() < deadline) await delay(100);
      if (leases.active().length)
        throw new TaskError('仍有服务或子进程存活，保留 plist 和数据等待核对');
    } finally {
      leases.close();
    }
    if (command === 'service-uninstall')
      for (const role of roles)
        if (existsSync(installedPath(role))) unlinkSync(ownedPlist(manifest, role));
    output({
      status: command === 'service-uninstall' ? 'uninstalled' : 'stopped',
      retained: 'credentials/config/database/logs/backups',
    });
    return 0;
  }
  throw new TaskError('未知服务命令');
}
