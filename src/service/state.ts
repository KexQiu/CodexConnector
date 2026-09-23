import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { privateDirectory, processAlive, readPrivate, servicePaths, writeJson } from './files.js';
import { TaskError } from '../tasks/types.js';

export const roles = ['app-server', 'gateway'] as const;
export type ServiceRole = (typeof roles)[number];
export const healthSchema = z.object({
  role: z.enum(roles),
  pid: z.number().int().positive(),
  token: z.string(),
  updatedAt: z.number(),
  startedAt: z.number(),
  phase: z.string(),
  ready: z.boolean(),
  rpcReady: z.boolean(),
  feishuConnected: z.boolean(),
  error: z.string().nullable(),
  notify: z
    .object({
      enabled: z.boolean(),
      listening: z.boolean().optional(),
      errorCode: z.string().nullable().optional(),
      startupError: z.string().nullable().optional(),
    })
    .optional(),
});
export type ComponentHealth = z.infer<typeof healthSchema>;
export function readHealth(dataDir: string, role: ServiceRole, now = Date.now()) {
  try {
    const health = healthSchema.parse(
      JSON.parse(readPrivate(join(servicePaths(dataDir).root, `${role}.json`))),
    );
    const healthy =
      health.role === role &&
      health.phase !== 'stopped' &&
      now >= health.updatedAt &&
      now - health.updatedAt <= 20_000 &&
      processAlive(health.pid);
    return {
      ...health,
      healthy,
      ready: healthy && health.ready,
      rpcReady: healthy && health.rpcReady,
      feishuConnected: healthy && health.feishuConnected,
    };
  } catch {
    return { role, healthy: false, ready: false, rpcReady: false, feishuConnected: false };
  }
}
export function writeHealth(dataDir: string, health: ComponentHealth) {
  writeJson(join(servicePaths(dataDir).root, `${health.role}.json`), healthSchema.parse(health));
}
const leaseSchema = z.object({
  role: z.enum([...roles, 'maintenance']),
  pid: z.number().int(),
  token: z.string(),
  child_pid: z.number().int().nullable(),
});
/** A separate database avoids adding supervisor locks to the task schema or migrating live work. */
export class ServiceLeases {
  readonly db: Database.Database;
  constructor(dataDir: string) {
    const paths = servicePaths(dataDir);
    privateDirectory(dataDir);
    privateDirectory(paths.root);
    try {
      closeSync(
        openSync(paths.leases, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600),
      );
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(paths.leases);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new TaskError('服务租约库权限不安全');
    this.db = new Database(paths.leases, { timeout: 2000 });
    try {
      this.db
        .transaction(() => {
          const id = this.db.pragma('application_id', { simple: true });
          if (
            id !== 0x43465853 &&
            (id !== 0 || this.db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
          )
            throw new TaskError('不是服务租约数据库');
          this.db.pragma('application_id = 1128683603');
          this.db.exec(
            'CREATE TABLE IF NOT EXISTS leases (role TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL, child_pid INTEGER)',
          );
        })
        .immediate();
      this.db.pragma('synchronous = FULL');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  list() {
    return this.db
      .prepare('SELECT * FROM leases')
      .all()
      .map((row) => leaseSchema.parse(row));
  }
  active() {
    return this.list().filter(
      (row) => processAlive(row.pid) || (row.child_pid !== null && processAlive(row.child_pid)),
    );
  }
  acquire(role: ServiceRole | 'maintenance') {
    return this.db
      .transaction(() => {
        if (this.active().some((row) => row.role === role))
          throw new TaskError('已有服务进程或孤立子进程存活，拒绝抢占');
        const token = randomUUID();
        this.db
          .prepare('INSERT OR REPLACE INTO leases VALUES (?,?,?,NULL)')
          .run(role, process.pid, token);
        return token;
      })
      .immediate();
  }
  child(token: string, pid: number | null) {
    if (
      this.db.prepare('UPDATE leases SET child_pid=? WHERE token=?').run(pid, token).changes !== 1
    )
      throw new TaskError('服务租约已失效');
  }
  release(token: string) {
    this.db.prepare('DELETE FROM leases WHERE token=?').run(token);
  }
  close() {
    this.db.close();
  }
}
