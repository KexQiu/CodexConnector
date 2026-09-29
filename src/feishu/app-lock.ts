import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory, processAlive } from '../service/files.js';
import { ServiceLeases } from '../service/state.js';

/** Honor the existing desktop lease too, including apps built before onboarding existed. */
export function acquireFeishuSetupLock(appId: string): () => void {
  const root = `/private/tmp/cc-${process.getuid!()}`;
  privateDirectory(root);
  const key = createHash('sha256').update(appId).digest('hex').slice(0, 24);
  const leases = new ServiceLeases(join(root, key));
  let token: string | undefined;
  let release: (() => void) | undefined;
  try {
    token = leases.acquire('gateway');
    release = acquireFeishuAppLock(appId);
  } catch (error) {
    if (token) leases.release(token);
    leases.close();
    throw error;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      release?.();
      leases.release(token);
    } finally {
      leases.close();
    }
  };
}

/** Shared by CLI, desktop profiles and setup sockets; unrelated to the task database. */
export function acquireFeishuAppLock(
  appId: string,
  root = `/private/tmp/cc-feishu-${process.getuid?.()}`,
): () => void {
  privateDirectory(root);
  const path = join(root, 'connections.sqlite');
  closeSync(openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('飞书连接锁必须为用户私有文件');
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('busy_timeout = 3000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS connections (app TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)',
  );
  const key = createHash('sha256').update(appId).digest('hex');
  const token = randomUUID();
  try {
    db.transaction(() => {
      const pid = db.prepare('SELECT pid FROM connections WHERE app=?').pluck().get(key);
      if (typeof pid === 'number' && processAlive(pid))
        throw new Error('该机器人已有本机连接，请先停止正式服务或其他配置窗口');
      db.prepare('INSERT OR REPLACE INTO connections VALUES (?,?,?)').run(key, process.pid, token);
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.prepare('DELETE FROM connections WHERE app=? AND token=?').run(key, token);
    } finally {
      db.close();
    }
  };
}
