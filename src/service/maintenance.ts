import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { runtimePaths } from '../config/schema.js';
import {
  backupGatewayDatabase,
  openGatewayDatabase,
  openReadonlyDatabase,
} from '../persistence/database.js';
import { SCHEMA_VERSION, validateMigrationChecksums } from '../persistence/migrate.js';
import { TaskError } from '../tasks/types.js';
import type { ServiceManifest } from './plan.js';
import { privateDirectory, readPrivate, servicePaths, writeJson } from './files.js';
import { ServiceLeases } from './state.js';

export function verifyDatabase(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new TaskError('备份/数据库必须是当前用户的私有普通文件');
  const db = openReadonlyDatabase(path);
  try {
    if (
      db.pragma('application_id', { simple: true }) !== 0x43465847 ||
      db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION
    )
      throw new TaskError('备份 schema 与当前版本不兼容，不能直接恢复');
    validateMigrationChecksums(db);
    if (
      db.pragma('quick_check', { simple: true }) !== 'ok' ||
      z.array(z.unknown()).parse(db.pragma('foreign_key_check')).length
    )
      throw new TaskError('备份完整性检查失败');
    return {
      integrity: 'ok',
      schemaVersion: SCHEMA_VERSION,
      tasks: db.prepare('SELECT count(*) FROM tasks').pluck().get() as number,
    };
  } finally {
    db.close();
  }
}
/** Redact content only after terminal, settled work. Keep IDs/fingerprints/dedup tombstones. */
export function redactSettledContent(db: Database.Database, cutoff: number) {
  return db
    .transaction(() => {
      const tasks = z
        .array(
          z.object({
            task_id: z.string(),
            thread_id: z.string().nullable(),
            turn_id: z.string().nullable(),
          }),
        )
        .parse(
          db
            .prepare(
              `
      SELECT task_id,thread_id,turn_id FROM tasks t WHERE status IN ('completed','failed','interrupted')
      AND updated_at<? AND prompt!=''
      AND NOT EXISTS (SELECT 1 FROM execution_locks l WHERE l.task_id=t.task_id)
      AND NOT EXISTS (SELECT 1 FROM outbox o WHERE (o.task_id=t.task_id OR json_extract(o.payload,'$.sourceTaskId')=t.task_id) AND o.state NOT IN ('delivered','superseded'))
      AND NOT EXISTS (SELECT 1 FROM rpc_operations r WHERE r.task_id=t.task_id AND r.state IN ('intent','sent','unknown'))
      AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id=t.task_id AND (a.state='pending' OR a.response_state IN ('intent','unknown')))
      AND NOT EXISTS (SELECT 1 FROM task_controls c WHERE c.task_id=t.task_id AND c.state IN ('queued','sending','unknown'))
      AND NOT EXISTS (SELECT 1 FROM feishu_commands c WHERE (c.task_id=t.task_id OR c.target_task_id=t.task_id) AND c.state!='processed')
      AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.thread_id=t.thread_id AND i.turn_id=t.turn_id AND i.state!='processed')
      ORDER BY updated_at LIMIT 100`,
            )
            .all(cutoff),
        );
      for (const task of tasks) {
        db.prepare("UPDATE tasks SET prompt='' WHERE task_id=?").run(task.task_id);
        db.prepare("UPDATE task_items SET text='[内容已过保留期]' WHERE task_id=?").run(
          task.task_id,
        );
        db.prepare("UPDATE rpc_operations SET intent='{}',result=NULL WHERE task_id=?").run(
          task.task_id,
        );
        db.prepare(
          "UPDATE approvals SET payload=NULL,answers='{}',decision=NULL WHERE task_id=?",
        ).run(task.task_id);
        db.prepare("UPDATE task_controls SET text='' WHERE task_id=?").run(task.task_id);
        db.prepare("UPDATE tool_observations SET payload='{}' WHERE thread_id=? AND turn_id=?").run(
          task.thread_id,
          task.turn_id,
        );
        db.prepare(
          "UPDATE inbox SET payload='{}' WHERE state='processed' AND ((thread_id=? AND turn_id=?) OR inbox_id IN (SELECT inbox_id FROM commands WHERE task_id=?) OR inbox_id IN (SELECT inbox_id FROM feishu_commands WHERE task_id=?))",
        ).run(task.thread_id, task.turn_id, task.task_id, task.task_id);
        db.prepare(
          "UPDATE feishu_commands SET payload=json_set(payload,'$.text','') WHERE task_id=? AND state='processed'",
        ).run(task.task_id);
        db.prepare(
          "UPDATE outbox SET wire_content=NULL,payload='{}' WHERE task_id=? AND state IN ('delivered','superseded')",
        ).run(task.task_id);
      }
      // Only taskless commands with a confirmed settled reply are eligible. Old
      // unassociated controls/input remain for reconciliation instead of being guessed.
      const taskless = z.array(z.object({ command_id: z.string(), inbox_id: z.string() })).parse(
        db
          .prepare(
            `SELECT command_id,inbox_id FROM feishu_commands c
          WHERE c.task_id IS NULL AND c.state='processed' AND c.created_at<? AND coalesce(json_extract(c.payload,'$.text'),'')!=''
          AND EXISTS (SELECT 1 FROM outbox o WHERE o.logical_key='feishu:reply:'||c.command_id AND o.state IN ('delivered','superseded'))
          AND NOT EXISTS (SELECT 1 FROM task_controls t WHERE t.control_id=c.command_id)
          LIMIT 100`,
          )
          .all(cutoff),
      );
      for (const row of taskless) {
        db.prepare(
          "UPDATE feishu_commands SET payload=json_set(payload,'$.text','') WHERE command_id=?",
        ).run(row.command_id);
        db.prepare("UPDATE inbox SET payload='{}' WHERE inbox_id=? AND state='processed'").run(
          row.inbox_id,
        );
      }
      db.prepare(
        `UPDATE outbox SET wire_content=NULL,payload='{"title":"已过保留期","text":""}'
      WHERE task_id IS NULL AND created_at<? AND state IN ('delivered','superseded')`,
      ).run(cutoff);
      db.prepare(
        `UPDATE feishu_drafts SET prompt='' WHERE created_at<? AND expires_at<?
        AND (state!='pending' OR NOT EXISTS
          (SELECT 1 FROM feishu_commands c WHERE c.state!='processed' AND json_extract(c.payload,'$.draftId')=feishu_drafts.draft_id))`,
      ).run(cutoff, Date.now());
      return tasks.length;
    })
    .immediate();
}
export async function maintain(manifest: ServiceManifest, force = false) {
  const leases = new ServiceLeases(manifest.dataDir);
  let token: string | undefined;
  try {
    token = leases.acquire('maintenance');
    const paths = servicePaths(manifest.dataDir),
      statePath = join(paths.root, 'maintenance.json');
    let previous = 0;
    try {
      previous = z
        .object({ completedAt: z.number() })
        .parse(JSON.parse(readPrivate(statePath))).completedAt;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (!force && Date.now() - previous < manifest.policy.backupIntervalHours * 3600_000)
      return { skipped: true };
    privateDirectory(paths.backups);
    const source = runtimePaths(manifest.dataDir).database;
    verifyDatabase(source);
    const name = `gateway-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`;
    const backup = join(paths.backups, name);
    const db = openGatewayDatabase(source);
    let redacted;
    try {
      await backupGatewayDatabase(db, backup);
      verifyDatabase(backup);
      // Logical retention, not a promise of physical erasure from backups/WAL/media.
      redacted = redactSettledContent(
        db,
        Date.now() - manifest.policy.contentRetentionDays * 86400_000,
      );
    } finally {
      db.close();
    }
    const backups = readdirSync(paths.backups)
      .filter((file) =>
        /^gateway-backup-\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9-]{36}\.sqlite$/.test(file),
      )
      .sort()
      .reverse();
    for (const old of backups.slice(manifest.policy.backupsToKeep)) {
      const path = join(paths.backups, old);
      verifyDatabase(path);
      unlinkSync(path);
    }
    const result = {
      completedAt: Date.now(),
      backup,
      integrity: 'ok',
      redactedTasks: redacted,
      keptBackups: Math.min(backups.length, manifest.policy.backupsToKeep),
    };
    writeJson(statePath, result);
    return result;
  } finally {
    if (token) leases.release(token);
    leases.close();
  }
}
/** Restore to a NEW private destination only. Never replace a live database or replay old work. */
export async function restoreCopy(source: string, destination: string) {
  const before = verifyDatabase(source);
  const db = openReadonlyDatabase(source);
  try {
    await backupGatewayDatabase(db, destination);
  } finally {
    db.close();
  }
  const after = verifyDatabase(destination);
  if (after.tasks !== before.tasks) throw new TaskError('恢复后的任务数量不一致');
  return {
    ...after,
    destination,
    scope: 'offline-copy-only',
    requiresReconciliationBeforeUse: true,
  };
}
