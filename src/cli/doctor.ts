import { lstatSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as lark from '@larksuiteoapi/node-sdk';
import WebSocket from 'ws';
import { pino } from 'pino';
import { runtimePaths } from '../config/schema.js';
import baseline from '../runtime-baseline.json' with { type: 'json' };
import { SCHEMA_VERSION, validateMigrationChecksums } from '../persistence/migrate.js';
import { inspectCodex } from '../codex/compatibility.js';
import { inspectNode, nodeCompatibilityMessage } from '../node-compatibility.js';

/** Inspect an existing Gateway DB without opening Codex data or running migrations. */
export function inspectTaskDatabase(dataDir: string) {
  if (!inspectNode().ok) return { status: 'incompatible-runtime' };
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
export async function runDoctor(binary = process.env.CODEX_BINARY) {
  const codex = await inspectCodex(binary);
  const node = inspectNode();
  let sqliteVersion: unknown;
  let sqliteError: string | undefined;
  try {
    // Do not load an unsupported native addon: old Node can abort before JS can catch it.
    if (!node.ok) sqliteError = 'Node 版本或 Node-API 不兼容，未加载 SQLite';
    else {
      const database = new Database(':memory:');
      try {
        sqliteVersion = database.prepare('SELECT sqlite_version()').pluck().get();
      } finally {
        database.close();
      }
    }
  } catch {
    sqliteError = 'SQLite 原生模块无法加载或执行，请为当前 Node 和架构重新安装依赖';
  }
  const checks = {
    node,
    codex,
    sqlite: { version: sqliteVersion, ok: typeof sqliteVersion === 'string', error: sqliteError },
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
    codexBinary: codex.binary,
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

export function doctorMessage(result: Awaited<ReturnType<typeof runDoctor>>): string {
  if (!result.checks.node.ok) return nodeCompatibilityMessage(result.checks.node);
  if (!result.checks.codex.ok) return result.checks.codex.message;
  if (!result.checks.sqlite.ok) return result.checks.sqlite.error ?? 'SQLite 运行检查失败';
  if (!result.checks.sdkImports.ok) return '本地运行依赖不可用，请重新构建或安装 CodexConnector';
  return result.checks.codex.message;
}
