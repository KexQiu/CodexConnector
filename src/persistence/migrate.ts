import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 12;
export const migrationSources = () =>
  [
    '001_tasks.sql',
    '002_feishu.sql',
    '003_interactions.sql',
    '004_conversation_ui.sql',
    '005_context_panel.sql',
    '006_status_metrics.sql',
    '007_project_metrics.sql',
    '008_session_navigation.sql',
    '009_navigation_cards.sql',
    '010_remote_projects.sql',
    '011_projectless_sessions.sql',
    '012_card_views.sql',
  ].map((name, index) => {
    const sql = readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
    return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
export function validateMigrationChecksums(database: Database.Database) {
  for (const migration of migrationSources()) {
    if (
      database
        .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
        .pluck()
        .get(migration.version) !== migration.checksum
    )
      throw new Error('Gateway migration checksum mismatch');
  }
}
export function migrate(database: Database.Database, beforeMigration?: () => void): void {
  const migrations = migrationSources();
  if (database.inTransaction) throw new Error('Migration requires its own transaction');
  const foreignKeys = database.pragma('foreign_keys', { simple: true });
  // SQLite's supported table-rebuild procedure. Validation is inside the same
  // immediate transaction; enforcement is restored on success and on failure.
  database.pragma('foreign_keys = OFF');
  try {
    database
      .transaction(() => {
        beforeMigration?.();
        const version = database.pragma('user_version', { simple: true });
        if (version === 0) {
          if (
            database
              .prepare(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
              )
              .get()
          ) {
            throw new Error('Refusing to migrate an unversioned existing schema');
          }
        } else if (typeof version !== 'number' || version > SCHEMA_VERSION || version < 0) {
          throw new Error('Unsupported Gateway database schema version');
        }
        for (const migration of migrations) {
          if (typeof version === 'number' && migration.version <= version) {
            if (
              database
                .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
                .pluck()
                .get(migration.version) !== migration.checksum
            )
              throw new Error('Gateway migration checksum mismatch');
          } else {
            // Never migrate while another worker holds the database. Stop it and back up first.
            if (migration.version > 1 && database.prepare('SELECT 1 FROM worker_lease').get())
              throw new Error('Stop the existing worker before migrating');
            if (
              migration.version > 2 &&
              database.prepare('SELECT 1 FROM feishu_runtime_lease').get()
            )
              throw new Error('Stop the existing Gateway before migrating');
            database.exec(migration.sql);
            database
              .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
              .run(migration.version, migration.checksum);
            database.pragma(`user_version = ${migration.version}`);
          }
        }
        // Prepare actual consumed columns: drift is an error, never an empty healthy database.
        for (const [table, columns] of Object.entries({
          tasks:
            'task_id, request_key, status, thread_id, turn_id, version, notification_message_id,conversation_id,fingerprint_version',
          threads: 'thread_id, owner_key, cwd,conversation_id',
          conversations: 'conversation_id,owner_key,chat_id,scope_kind,project_key,cwd,thread_id',
          inbox: 'event_key, state, attempts, payload',
          commands: 'command_id, inbox_id, task_id, state',
          rpc_operations: 'operation_id, rpc_id_json, connection_epoch, intent, state',
          approvals:
            'approval_id, connection_epoch, rpc_id_json, state, payload, answers, response_state',
          execution_locks: 'lock_key, task_id',
          outbox:
            'logical_key, card_version, state, claim_token, lease_until, panel_id, view_id, view_parent_id',
          feishu_panels:
            'panel_id,owner_key,chat_id,message_id,message_created_at,version,snapshot_hash,refresh_requested,next_refresh_at,core_hash,last_rendered_at',
          user_context: 'owner_key,chat_id,scope_kind,project_key,conversation_id,task_id',
          session_metrics: 'thread_id,payload',
          account_metrics: 'owner_key,payload',
          project_metrics: 'owner_key,project_key,payload',
          worker_lease: 'singleton, token, pid',
          task_items: 'task_id, item_id, text',
          task_destinations: 'task_id, owner_key, chat_id',
          feishu_commands:
            'command_id, business_key, state, payload, target_task_id, target_project_key,target_resolved,target_scope_kind,target_conversation_id',
          feishu_actions: 'nonce, outbox_id, owner_key, message_id, project_key, draft_id, page',
          feishu_drafts: 'draft_id, owner_key, chat_id, prompt, state, expires_at',
          feishu_runtime_lease: 'singleton, token, pid',
          tool_observations: 'thread_id, turn_id, item_id, payload',
          task_controls: 'control_id, task_id, kind, turn_id, state',
          remote_projects: 'request_id,owner_key,chat_id,project_key,root,state,device,inode',
          remote_project_prompts: 'owner_key,chat_id,token,expires_at',
        }))
          database.prepare(`SELECT ${columns} FROM ${table} LIMIT 0`).all();
        const violations = database.pragma('foreign_key_check');
        if (!Array.isArray(violations) || violations.length)
          throw new Error('Gateway foreign key check failed');
      })
      .immediate();
  } finally {
    database.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
  }
}
