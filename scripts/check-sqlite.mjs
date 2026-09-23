import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  backupGatewayDatabase,
  openGatewayDatabase,
  openReadonlyDatabase,
} from '../src/persistence/database.ts';

const directory = mkdtempSync(join(tmpdir(), 'codexconnector-sqlite-check-'));
const connections = [];
const track = (database) => {
  connections.push(database);
  return database;
};
const requireCheck = (condition, label) => {
  if (!condition) throw new Error(`SQLite check failed: ${label}`);
};
try {
  const path = join(directory, 'gateway.sqlite');
  const database = track(openGatewayDatabase(path));
  database.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO entries VALUES (?, ?)');
  const samples = [];
  for (let id = 0; id < 30; id++) {
    const started = performance.now();
    database.transaction(() => insert.run(id, 'fixture'))();
    samples.push(performance.now() - started);
  }
  let rollback = false;
  try {
    database.transaction(() => {
      insert.run(30, 'rollback');
      insert.run(0, 'duplicate');
    })();
  } catch {
    rollback = database.prepare('SELECT COUNT(*) FROM entries').pluck().get() === 30;
  }
  requireCheck(rollback, 'transaction rollback');
  const readonly = track(openReadonlyDatabase(path));
  let readonlyRejected = false;
  try {
    readonly.prepare('INSERT INTO entries VALUES (?, ?)').run(31, 'forbidden');
  } catch (error) {
    readonlyRejected = error.code === 'SQLITE_READONLY';
  }
  requireCheck(readonlyRejected, 'read-only connection');

  const second = track(openGatewayDatabase(path));
  database.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  const nextTick = delay(0).then(() => performance.now() - started);
  let busyRejected = false;
  try {
    second.prepare('INSERT INTO entries VALUES (?, ?)').run(32, 'blocked');
  } catch (error) {
    busyRejected = error.code === 'SQLITE_BUSY';
  } finally {
    database.exec('ROLLBACK');
  }
  const busyWaitMs = performance.now() - started;
  const eventLoopDelayMs = await nextTick;
  requireCheck(busyRejected && busyWaitMs < 1000, 'bounded busy timeout');

  const backup = join(directory, 'backup.sqlite');
  await backupGatewayDatabase(database, backup);
  const restored = track(openReadonlyDatabase(backup));
  const backupIntegrity = restored.pragma('integrity_check', { simple: true });
  requireCheck(
    backupIntegrity === 'ok' &&
      restored.prepare('SELECT COUNT(*) FROM entries').pluck().get() === 30,
    'backup restore',
  );
  requireCheck(
    (statSync(path).mode & 0o777) === 0o600 && (statSync(backup).mode & 0o777) === 0o600,
    'private files',
  );
  samples.sort((a, b) => a - b);
  const round = (value) => Math.round(value * 100) / 100;
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        node: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        sqlite: database.prepare('SELECT sqlite_version()').pluck().get(),
        pragmas: {
          journalMode: database.pragma('journal_mode', { simple: true }),
          synchronous: database.pragma('synchronous', { simple: true }),
          foreignKeys: database.pragma('foreign_keys', { simple: true }),
          busyTimeoutMs: database.pragma('busy_timeout', { simple: true }),
        },
        rollback,
        readonlyRejected,
        backupIntegrity,
        privateMode: '0600',
        sampleCount: samples.length,
        commitP95Ms: round(samples[Math.ceil(samples.length * 0.95) - 1]),
        busyWaitMs: round(busyWaitMs),
        eventLoopDelayMs: round(eventLoopDelayMs),
        scope: 'temporary-local-fixtures; not a Feishu ACK or production load test',
      },
      null,
      2,
    ),
  );
} finally {
  for (const database of connections) if (database.open) database.close();
  rmSync(directory, { recursive: true, force: true });
}
