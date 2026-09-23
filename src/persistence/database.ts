import Database from 'better-sqlite3';
import { closeSync, constants, lstatSync, openSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const APPLICATION_ID = 0x43465847;

function assertPrivateDirectory(path: string): void {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
    throw new Error('Gateway database directory must be private and owned by the current user');
  }
}

/** The caller creates a private parent directory. Never pass a Codex database here. */
export function openGatewayDatabase(path: string, timeoutMs = 250): Database.Database {
  if (!isAbsolute(path)) throw new Error('Gateway database path must be absolute');
  assertPrivateDirectory(path);
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error('Gateway database must be a private regular file owned by the current user');
  }
  const database = new Database(path, { fileMustExist: true, timeout: timeoutMs });
  try {
    const applicationId = database.pragma('application_id', { simple: true });
    const hasSchema = database.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get() !== undefined;
    if (applicationId !== APPLICATION_ID && (applicationId !== 0 || hasSchema)) {
      throw new Error('Refusing a database that is not owned by CodexConnector');
    }
    database.pragma(`application_id = ${APPLICATION_ID}`);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    if (
      database.pragma('journal_mode', { simple: true }) !== 'wal' ||
      database.pragma('synchronous', { simple: true }) !== 2 ||
      database.pragma('foreign_keys', { simple: true }) !== 1
    ) {
      throw new Error('Gateway database durability settings were not applied');
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openReadonlyDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true, timeout: 250 });
}

/** Each backup gets a new private file; existing backups are never overwritten. */
export async function backupGatewayDatabase(
  database: Database.Database,
  destination: string,
): Promise<void> {
  if (!isAbsolute(destination)) throw new Error('Backup path must be absolute');
  assertPrivateDirectory(destination);
  closeSync(
    openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600),
  );
  try {
    await database.backup(destination);
  } catch (error) {
    unlinkSync(destination);
    throw error;
  }
}
