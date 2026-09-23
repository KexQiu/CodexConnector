import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as lark from '@larksuiteoapi/node-sdk';
import WebSocket from 'ws';
import { pino } from 'pino';
import { runtimePaths } from '../config/schema.js';
import baseline from '../runtime-baseline.json' with { type: 'json' };
import { SCHEMA_VERSION, validateMigrationChecksums } from '../persistence/migrate.js';

const exec = promisify(execFile);

/** Inspect an existing Gateway DB without opening Codex data or running migrations. */
export function inspectTaskDatabase(dataDir: string) {
  const path = runtimePaths(dataDir).database;
  let database: Database.Database | undefined;
  try {
    for (const [file, directory] of [
      [dataDir, true],
      [path, false],
    ] as const) {
      const info = lstatSync(file);
      if (
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        (directory ? !info.isDirectory() : !info.isFile())
      )
        return { status: 'unsafe-permissions' };
    }
    database = new Database(path, { readonly: true, fileMustExist: true, timeout: 250 });
    if (
      database.pragma('application_id', { simple: true }) !== 0x43465847 ||
      database.pragma('user_version', { simple: true }) !== SCHEMA_VERSION
    )
      return { status: 'incompatible-schema' };
    try {
      validateMigrationChecksums(database);
    } catch {
      return { status: 'incompatible-schema' };
    }
    const integrity = database.pragma('quick_check', { simple: true });
    return {
      status: integrity === 'ok' ? 'ok' : 'corrupt',
      schemaVersion: SCHEMA_VERSION,
      statuses: database
        .prepare('SELECT status, count(*) AS count FROM tasks GROUP BY status')
        .all(),
      locks: database.prepare('SELECT count(*) FROM execution_locks').pluck().get(),
      failedEvents: database
        .prepare("SELECT count(*) FROM inbox WHERE state = 'failed'")
        .pluck()
        .get(),
      outbox: database.prepare('SELECT state, count(*) AS count FROM outbox GROUP BY state').all(),
      outboxErrors: database
        .prepare(
          'SELECT error_code, count(*) AS count FROM outbox WHERE error_code IS NOT NULL GROUP BY error_code',
        )
        .all(),
      feishuCommands: database
        .prepare('SELECT state, count(*) AS count FROM feishu_commands GROUP BY state')
        .all(),
    };
  } catch (error) {
    return {
      status:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'not-initialized'
          : 'unavailable',
    };
  } finally {
    database?.close();
  }
}

/** Local diagnostics only: no RPC, Feishu connection, credentials, or persistent DB. */
export async function runDoctor(binary = process.env.CODEX_BINARY ?? baseline.codexBinary) {
  let codexVersion: string | null = null;
  try {
    const { stdout } = await exec(binary, ['--version'], { timeout: 5000 });
    codexVersion = stdout.trim();
  } catch {
    // A missing or unavailable binary is a reported failure, not a healthy upstream.
  }
  const database = new Database(':memory:');
  let sqliteVersion: unknown;
  try {
    sqliteVersion = database.prepare('SELECT sqlite_version()').pluck().get();
  } finally {
    database.close();
  }
  const checks = {
    node: {
      expected: baseline.node,
      actual: process.versions.node,
      ok: process.versions.node === baseline.node,
    },
    codex: {
      expected: `codex-cli ${baseline.codex}`,
      actual: codexVersion,
      ok: codexVersion === `codex-cli ${baseline.codex}`,
    },
    sqlite: { version: sqliteVersion, ok: typeof sqliteVersion === 'string' },
    sdkImports: {
      ok: [lark.Client, lark.WSClient, lark.EventDispatcher, WebSocket, pino].every(
        (value) => typeof value === 'function',
      ),
    },
  };
  return {
    status: Object.values(checks).every((check) => check.ok) ? 'ok' : 'incompatible',
    milestone: baseline.milestone,
    platform: process.platform,
    architecture: process.arch,
    nodePath: process.execPath,
    codexBinary: binary,
    checks,
    defaultPaths: runtimePaths(),
    scope: 'local-compatibility-only',
    gates: {
      G1: 'not-checked-by-doctor',
      G2: 'not-checked-by-doctor',
      G3: 'not-checked-by-doctor',
    },
  };
}
