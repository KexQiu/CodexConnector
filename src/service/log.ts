import {
  appendFileSync,
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { privateDirectory, readPrivate } from './files.js';
import { TaskError } from '../tasks/types.js';

export class RotatingLog {
  constructor(
    readonly path: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly keep = 5,
  ) {
    privateDirectory(dirname(path));
  }
  write(event: string, fields: Record<string, string | number | boolean | null> = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n';
    if (Buffer.byteLength(line) > 8192) throw new TaskError('日志记录过大');
    let fd = openSync(
      this.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new TaskError('日志文件权限不安全');
      if (stat.size + Buffer.byteLength(line) > this.maxBytes) {
        closeSync(fd);
        fd = -1;
        for (let i = this.keep; i >= 1; i--) {
          const target = `${this.path}.${i}`;
          if (existsSync(target)) {
            readPrivate(target, this.maxBytes + 8192);
            if (i === this.keep) unlinkSync(target);
          }
          const source = i === 1 ? this.path : `${this.path}.${i - 1}`;
          if (existsSync(source)) {
            readPrivate(source, this.maxBytes + 8192);
            renameSync(source, target);
          }
        }
        fd = openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      }
      appendFileSync(fd, line);
    } finally {
      if (fd !== -1) closeSync(fd);
    }
  }
}
