import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskError } from '../tasks/types.js';

export const servicePaths = (dataDir: string) => ({
  root: join(dataDir, 'services'),
  manifest: join(dataDir, 'services', 'manifest.json'),
  leases: join(dataDir, 'services', 'leases.sqlite'),
  logs: join(dataDir, 'logs'),
  backups: join(dataDir, 'backups'),
});
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new TaskError('服务目录必须为当前用户的私有目录，不能使用符号链接');
}
export function readPrivate(path: string, maxBytes = 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > maxBytes
    )
      throw new TaskError('服务文件必须为当前用户的私有普通文件');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
export function writePrivate(path: string, content: string) {
  privateDirectory(dirname(path));
  // Atomic replacement prevents partial heartbeat/config reads. Never follow a target symlink.
  try {
    readPrivate(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
export function writeJson(path: string, value: unknown) {
  writePrivate(path, JSON.stringify(value, null, 2) + '\n');
}
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    return true; // Permission/unknown errors never authorize takeover.
  }
}
