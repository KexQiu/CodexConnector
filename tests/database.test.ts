import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupGatewayDatabase,
  openGatewayDatabase,
  openReadonlyDatabase,
} from '../src/persistence/database.js';

describe('SQLite on the current Node/macOS runtime', () => {
  let directory: string;
  const connections: Database.Database[] = [];
  const track = (database: Database.Database) => {
    connections.push(database);
    return database;
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codexconnector-db-'));
  });
  afterEach(() => {
    for (const connection of connections.splice(0)) if (connection.open) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('enforces unique keys atomically and retains earlier committed data', () => {
    const path = join(directory, 'gateway.sqlite');
    const database = track(openGatewayDatabase(path));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(database.pragma('synchronous', { simple: true })).toBe(2);
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    database.exec('CREATE TABLE commands (request_key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    const insert = database.prepare('INSERT INTO commands VALUES (?, ?)');
    insert.run('existing', 'committed');
    expect(() =>
      database.transaction(() => {
        insert.run('new', 'rolled back');
        insert.run('existing', 'duplicate');
      })(),
    ).toThrow();
    expect(database.prepare('SELECT request_key FROM commands').pluck().all()).toEqual([
      'existing',
    ]);
    database.close();
    const reopened = track(openGatewayDatabase(path));
    expect(reopened.prepare('SELECT payload FROM commands').pluck().get()).toBe('committed');
  });

  it('rejects writes through a readonly connection', () => {
    const path = join(directory, 'gateway.sqlite');
    const writable = track(openGatewayDatabase(path));
    writable.exec('CREATE TABLE entries (value TEXT)');
    const readonly = track(openReadonlyDatabase(path));
    expect(() => readonly.prepare('INSERT INTO entries VALUES (?)').run('forbidden')).toThrow(
      /readonly/i,
    );
    expect(readonly.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(0);
  });

  it('restores committed WAL data using the backup API', async () => {
    const database = track(openGatewayDatabase(join(directory, 'gateway.sqlite')));
    database.exec("CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES ('durable')");
    const backup = join(directory, 'backup.sqlite');
    await backupGatewayDatabase(database, backup);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    const restored = track(openReadonlyDatabase(backup));
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(restored.pragma('foreign_key_check')).toEqual([]);
    expect(restored.prepare('SELECT value FROM entries').pluck().get()).toBe('durable');
    await expect(backupGatewayDatabase(database, backup)).rejects.toThrow(/EEXIST/);
  });

  it('removes an incomplete backup when the source is unavailable', async () => {
    const database = track(openGatewayDatabase(join(directory, 'gateway.sqlite')));
    database.close();
    const backup = join(directory, 'failed-backup.sqlite');
    await expect(backupGatewayDatabase(database, backup)).rejects.toThrow();
    expect(existsSync(backup)).toBe(false);
  });

  it('bounds busy waits and does not commit failed transactions', () => {
    const path = join(directory, 'gateway.sqlite');
    const first = track(openGatewayDatabase(path));
    first.exec('CREATE TABLE entries (value TEXT)');
    const second = track(openGatewayDatabase(path));
    first.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    try {
      expect(() => second.prepare('INSERT INTO entries VALUES (?)').run('blocked')).toThrow(
        /locked/i,
      );
    } finally {
      first.exec('ROLLBACK');
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(second.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(0);
  });

  it('refuses to initialize a non-Gateway database', () => {
    const path = join(directory, 'external.sqlite');
    const external = track(new Database(path));
    external.exec('CREATE TABLE external_data (value TEXT)');
    external.close();
    // Match private permissions so this test reaches the ownership marker check.
    chmodSync(path, 0o600);
    expect(() => openGatewayDatabase(path)).toThrow(/not owned/);
  });
});
