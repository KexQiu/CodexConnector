import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { runtimePaths } from '../config/schema.js';
import {
  backupGatewayDatabase,
  openGatewayDatabase,
  openReadonlyDatabase,
} from '../persistence/database.js';
import { migrate, migrationSources, SCHEMA_VERSION } from '../persistence/migrate.js';
import { privateDirectory, processAlive, servicePaths } from '../service/files.js';
import { ServiceLeases } from '../service/state.js';

function schemaVersion(db: Database.Database) {
  const version: unknown = db.pragma('user_version', { simple: true });
  if (
    db.pragma('application_id', { simple: true }) !== 0x43465847 ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0 ||
    version > SCHEMA_VERSION
  )
    throw new Error('任务数据库版本不受支持，已停止启动；请使用兼容版本并保留原数据。');
  if (
    version === 0 &&
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()
  )
    throw new Error('任务数据库缺少版本记录，已停止启动；请保留原数据。');
  for (const migration of migrationSources().filter((item) => item.version <= version)) {
    if (
      db
        .prepare('SELECT checksum FROM schema_migrations WHERE version=?')
        .pluck()
        .get(migration.version) !== migration.checksum
    )
      throw new Error('任务数据库迁移校验不一致，已停止启动；请保留原数据库和备份。');
  }
  return version;
}

function assertIntegrity(db: Database.Database) {
  if (
    db.pragma('quick_check', { simple: true }) !== 'ok' ||
    z.array(z.unknown()).parse(db.pragma('foreign_key_check')).length
  )
    throw new Error('任务数据库完整性检查失败，已停止升级；请保留原数据库和备份。');
}

function staleLeaseTables(db: Database.Database, preservePending = false): string[] {
  const tables = ['worker_lease', 'feishu_runtime_lease'].filter((table) =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table),
  );
  for (const table of tables) {
    const pids = z
      .array(z.number().int().positive())
      .parse(db.prepare(`SELECT pid FROM ${table}`).pluck().all());
    if (pids.some(processAlive))
      throw new Error('仍有 Gateway/worker 运行或无法确认旧进程已退出，数据库尚未升级。');
  }
  if (
    !preservePending &&
    db
      .prepare(
        "SELECT 1 FROM tasks WHERE status NOT IN ('completed','failed','interrupted') LIMIT 1",
      )
      .get()
  )
    throw new Error('数据库升级前需要核对未完成任务，请先使用原版本完成恢复，原数据已保留。');
  return tables;
}

/** Called under the desktop identity lock, before either service starts. */
export async function prepareDesktopDatabase(dataDir: string, signal?: AbortSignal) {
  const path = runtimePaths(dataDir).database;
  if (!existsSync(path)) return;
  privateDirectory(dataDir);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('任务数据库必须是当前用户的私有普通文件，已停止启动。');
  const source = openReadonlyDatabase(path);
  let leases: ServiceLeases | undefined;
  let token: string | undefined;
  try {
    const before = schemaVersion(source);
    if (before === 0 || before === SCHEMA_VERSION) return;
    assertIntegrity(source);
    staleLeaseTables(source, before >= 10);
    leases = new ServiceLeases(dataDir);
    if (leases.active().length)
      throw new Error('数据库升级前必须停止旧服务及其子进程，原数据已保留。');
    token = leases.acquire('maintenance');
    const backups = servicePaths(dataDir).backups;
    privateDirectory(backups);
    const backup = join(
      backups,
      `before-upgrade-v${before}-to-v${SCHEMA_VERSION}-${randomUUID()}.sqlite`,
    );
    try {
      await backupGatewayDatabase(source, backup);
    } catch {
      throw new Error('无法创建数据库升级备份，原数据库未修改；请检查数据目录权限和磁盘空间。');
    }
    const saved = openReadonlyDatabase(backup);
    try {
      if (schemaVersion(saved) !== before) throw new Error('升级备份版本不一致，原数据库未修改。');
      assertIntegrity(saved);
    } finally {
      saved.close();
    }
    if (signal?.aborted) throw new Error('启动已取消');
    const db = openGatewayDatabase(path);
    try {
      migrate(db, () => {
        if (schemaVersion(db) !== before || leases!.active().some((row) => row.token !== token))
          throw new Error('备份期间数据库或服务状态发生变化，已取消升级；请停止其他实例后重试。');
        const tables = staleLeaseTables(db, before >= 10);
        // Only proven-dead PID rows are removed, and only inside the same
        // transaction as migration. Failure restores both locks and schema.
        for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
      });
    } catch {
      throw new Error(
        '任务数据库升级未完成，原版本和运行锁已保留；升级前备份位于数据目录的 backups 中。',
      );
    } finally {
      db.close();
    }
    return { from: before, to: SCHEMA_VERSION, backup };
  } finally {
    source.close();
    if (token) leases?.release(token);
    leases?.close();
  }
}
