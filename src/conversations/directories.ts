import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TaskError } from '../tasks/types.js';
import type { Conversation } from './store.js';

export const projectlessDirectoryRoot = () =>
  join(homedir(), 'Library', 'Application Support', 'CodexConnector Conversations');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function ownedDirectory(path: string) {
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new TaskError('无项目会话目录必须是本机用户的私有目录');
  return info;
}
function createParent(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  ownedDirectory(path);
}
export class ConversationDirectories {
  readonly root: string;
  readonly profile: string;
  constructor(dataDir: string, root = projectlessDirectoryRoot()) {
    // Data profiles must exist before allocating conversations. Hash the canonical identity.
    this.root = join(realpathSync(dirname(root)), basename(root));
    this.profile = join(
      this.root,
      createHash('sha256').update(realpathSync(dataDir)).digest('hex'),
    );
  }
  private path(id: string) {
    if (!idPattern.test(id)) throw new TaskError('无项目会话 ID 无效');
    return join(this.profile, id);
  }
  create(id: string) {
    createParent(this.root);
    createParent(this.profile);
    const cwd = this.path(id);
    mkdirSync(cwd, { mode: 0o700 }); // Existing/missing registrations must never be silently reused.
    const info = ownedDirectory(cwd);
    return { cwd, identity: { dev: info.dev, ino: info.ino } };
  }
  assert(conversation: Conversation) {
    const path = this.path(conversation.conversation_id);
    try {
      ownedDirectory(this.root);
      ownedDirectory(this.profile);
      const info = ownedDirectory(path);
      if (
        conversation.cwd !== path ||
        info.dev !== conversation.directory_device ||
        info.ino !== conversation.directory_inode
      )
        throw new Error('Directory identity changed');
    } catch {
      throw new TaskError('无项目会话目录已丢失或被替换，请创建新会话，原历史仍保留');
    }
    return path;
  }
}
