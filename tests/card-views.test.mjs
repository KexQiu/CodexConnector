import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { openGatewayDatabase } from '../src/persistence/database.ts';
import { migrate, migrationSources, SCHEMA_VERSION } from '../src/persistence/migrate.ts';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-card-migration-'));
  db = openGatewayDatabase(join(dir, 'v11.sqlite'));
  for (const migration of migrationSources().slice(0, 11)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
      migration.version,
      migration.checksum,
    );
    db.pragma(`user_version=${migration.version}`);
  }
  db.exec(`INSERT INTO outbox (outbox_id,logical_key,card_version,payload,state,created_at,owner_key,chat_id,message_id,operation,wire_content)
    VALUES ('old','feishu:reply:old',1,'{"title":"选择项目","text":"旧页面","buttons":[]}', 'delivered',1,'owner','chat','om_old','send','frozen'),
    ('unknown','feishu:reply:unknown',1,'{"title":"未决","text":"","buttons":[]}', 'unknown',2,'owner','chat',NULL,'send','pending-receipt');
    INSERT INTO feishu_actions (nonce,outbox_id,owner_key,chat_id,message_id,action,expires_at,page)
    VALUES ('nonce','old','owner','chat','om_old','projects',9999999999999,1);`);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('upgrades v11 without rewriting legacy actions, receipt markers, unknown outcomes, or migration checksums', () => {
  const actions = db.prepare('SELECT * FROM feishu_actions').all();
  const before = db.prepare('SELECT * FROM outbox ORDER BY outbox_id').all();
  const checksums = db.prepare('SELECT * FROM schema_migrations').all();
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  expect(db.prepare('SELECT * FROM feishu_actions').all()).toEqual(actions);
  expect(db.prepare('SELECT * FROM outbox ORDER BY outbox_id').all()).toEqual(
    before.map((row) => ({ ...row, view_id: null, view_parent_id: null })),
  );
  expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=11').all()).toEqual(checksums);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('rolls back the entire view migration on failure, preserving a usable v11 database', () => {
  db.exec(`CREATE TRIGGER fail_v12 BEFORE INSERT ON schema_migrations WHEN NEW.version=12
    BEGIN SELECT RAISE(ABORT,'fixture interrupted migration'); END;`);
  const actions = db.prepare('SELECT * FROM feishu_actions').all();
  expect(() => migrate(db)).toThrow('fixture interrupted migration');
  expect(db.pragma('user_version', { simple: true })).toBe(11);
  expect(db.prepare('SELECT * FROM feishu_actions').all()).toEqual(actions);
  expect(() => db.prepare('SELECT view_id FROM outbox')).toThrow();
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.exec('DROP TRIGGER fail_v12');
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
});

it('does not migrate while a gateway still owns the old database', () => {
  db.prepare('INSERT INTO feishu_runtime_lease VALUES (1,?,?)').run(process.pid, 'owned');
  expect(() => migrate(db)).toThrow('Stop the existing Gateway');
  expect(db.pragma('user_version', { simple: true })).toBe(11);
  expect(db.prepare('SELECT token FROM feishu_runtime_lease').pluck().get()).toBe('owned');
});
