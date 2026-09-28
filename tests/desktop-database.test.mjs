import { mkdtempSync, mkdirSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../src/persistence/database.ts';
import {
  migrationSources,
  SCHEMA_VERSION,
  validateMigrationChecksums,
} from '../src/persistence/migrate.ts';
import { prepareDesktopDatabase } from '../src/desktop/database.ts';
import { ServiceLeases } from '../src/service/state.ts';
import { gatewayErrorMessage } from '../src/service/gateway-error.ts';
import { FeishuApiError } from '../src/feishu/api.ts';

let root, db;
const deadPid = 2147483000;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-upgrade-'));
  db = database.openGatewayDatabase(join(root, 'gateway.sqlite'));
  for (const migration of migrationSources().slice(0, 9)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
      migration.version,
      migration.checksum,
    );
    db.pragma(`user_version=${migration.version}`);
  }
  db.prepare('INSERT INTO worker_lease VALUES (1,?,?)').run('old-worker', deadPid);
  db.prepare('INSERT INTO feishu_runtime_lease VALUES (1,?,?)').run(deadPid, 'old-gateway');
  const kill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === deadPid && signal === 0)
      throw Object.assign(new Error('not running'), { code: 'ESRCH' });
    return kill(pid, signal);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const version = () => db.pragma('user_version', { simple: true });
const addTask = (status) =>
  db
    .prepare(
      `INSERT INTO tasks
  (task_id,request_key,fingerprint,owner_key,owner_json,project_key,cwd,prompt,status,created_at,updated_at)
  VALUES ('task-1','request-1','fingerprint','owner','{}','project',?,'keep my history',?,1,1)`,
    )
    .run(root, status);
const assertUnchanged = () => {
  expect(version()).toBe(9);
  expect(db.prepare('SELECT pid FROM worker_lease').pluck().get()).toBe(deadPid);
  expect(db.prepare('SELECT pid FROM feishu_runtime_lease').pluck().get()).toBe(deadPid);
};

describe('desktop database upgrades', () => {
  it('backs up v9 with stale locks, upgrades atomically and preserves history and dedup keys', async () => {
    addTask('completed');
    const result = await prepareDesktopDatabase(root);
    expect(result).toMatchObject({ from: 9, to: SCHEMA_VERSION });
    expect(version()).toBe(SCHEMA_VERSION);
    validateMigrationChecksums(db);
    expect(db.prepare('SELECT prompt,request_key FROM tasks').get()).toEqual({
      prompt: 'keep my history',
      request_key: 'request-1',
    });
    expect(db.prepare('SELECT * FROM worker_lease').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM feishu_runtime_lease').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM remote_projects').all()).toEqual([]);
    expect(lstatSync(result.backup).mode & 0o777).toBe(0o600);
    const backup = database.openReadonlyDatabase(result.backup);
    expect(backup.pragma('user_version', { simple: true })).toBe(9);
    expect(backup.prepare('SELECT pid FROM worker_lease').pluck().get()).toBe(deadPid);
    expect(backup.prepare('SELECT prompt FROM tasks').pluck().get()).toBe('keep my history');
    backup.close();
    await expect(prepareDesktopDatabase(root)).resolves.toBeUndefined();
    expect(
      readdirSync(join(root, 'backups')).filter((name) => name.endsWith('.sqlite')),
    ).toHaveLength(1);
  });
  it.each(['worker_lease', 'feishu_runtime_lease'])(
    'does not reclaim a live %s lock',
    async (table) => {
      db.prepare(`UPDATE ${table} SET pid=?`).run(process.pid);
      await expect(prepareDesktopDatabase(root)).rejects.toThrow('无法确认旧进程已退出');
      expect(version()).toBe(9);
      expect(db.prepare(`SELECT pid FROM ${table}`).pluck().get()).toBe(process.pid);
    },
  );
  it('refuses cleanup when process inspection is denied', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('无法确认旧进程已退出');
    assertUnchanged();
  });
  it.each(['queued', 'running', 'unknown'])('preserves unresolved %s work', async (status) => {
    addTask(status);
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('核对未完成任务');
    assertUnchanged();
    expect(db.prepare('SELECT status FROM tasks').pluck().get()).toBe(status);
  });
  it('refuses an active service even when task worker locks are stale', async () => {
    const leases = new ServiceLeases(root);
    const token = leases.acquire('app-server');
    try {
      await expect(prepareDesktopDatabase(root)).rejects.toThrow('停止旧服务及其子进程');
      assertUnchanged();
    } finally {
      leases.release(token);
      leases.close();
    }
  });
  it('refuses checksum drift before backing up or clearing locks', async () => {
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=9').run('changed');
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('迁移校验不一致');
    assertUnchanged();
  });
  it('refuses foreign and future databases', async () => {
    db.pragma('application_id=123');
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('版本不受支持');
    assertUnchanged();
    db.pragma('application_id=1128683591');
    db.pragma(`user_version=${SCHEMA_VERSION + 1}`);
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('版本不受支持');
    expect(version()).toBe(SCHEMA_VERSION + 1);
  });
  it('does not touch the source when backup fails', async () => {
    vi.spyOn(database, 'backupGatewayDatabase').mockRejectedValue(new Error('disk full'));
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('无法创建数据库升级备份');
    assertUnchanged();
  });
  it('rolls back lock cleanup and schema changes when migration fails', async () => {
    db.exec('CREATE TABLE remote_projects (incompatible TEXT)');
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('原版本和运行锁已保留');
    assertUnchanged();
    expect(
      db.prepare('SELECT version FROM schema_migrations WHERE version=10').get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='feishu_actions_v10'").get(),
    ).toBeUndefined();
    expect(
      readdirSync(join(root, 'backups')).filter((name) => name.endsWith('.sqlite')),
    ).toHaveLength(1);
  });
  it('rechecks process ownership after an asynchronous backup', async () => {
    const backup = database.backupGatewayDatabase;
    vi.spyOn(database, 'backupGatewayDatabase').mockImplementation(async (...args) => {
      await backup(...args);
      db.prepare('UPDATE worker_lease SET pid=?').run(process.pid);
    });
    await expect(prepareDesktopDatabase(root)).rejects.toThrow('升级未完成');
    expect(version()).toBe(9);
    expect(db.prepare('SELECT pid FROM worker_lease').pluck().get()).toBe(process.pid);
  });
  it('cancels before migration if the app quits during backup', async () => {
    const backup = database.backupGatewayDatabase,
      controller = new globalThis.AbortController();
    vi.spyOn(database, 'backupGatewayDatabase').mockImplementation(async (...args) => {
      await backup(...args);
      controller.abort();
    });
    await expect(prepareDesktopDatabase(root, controller.signal)).rejects.toThrow('启动已取消');
    assertUnchanged();
  });
  it('leaves a new profile to the normal initial schema creation', async () => {
    const fresh = join(root, 'new');
    mkdirSync(fresh, { mode: 0o700 });
    await expect(prepareDesktopDatabase(fresh)).resolves.toBeUndefined();
    expect(readdirSync(fresh)).toEqual([]);
    const empty = database.openGatewayDatabase(join(fresh, 'gateway.sqlite'));
    empty.close();
    await expect(prepareDesktopDatabase(fresh)).resolves.toBeUndefined();
  });
});

it('publishes useful gateway errors without exposing unknown error text or credentials', () => {
  expect(gatewayErrorMessage(new Error('Stop the existing worker before migrating'))).toContain(
    '数据库升级',
  );
  expect(gatewayErrorMessage(new FeishuApiError('permanent', 403, 99991672))).toContain('99991672');
  expect(gatewayErrorMessage(new Error('app_secret=do-not-expose'))).not.toContain('do-not-expose');
  expect(gatewayErrorMessage(new Error('toString'))).toContain('gateway_unavailable');
});
