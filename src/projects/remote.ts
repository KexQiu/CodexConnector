import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import { remotePermissionsSchema } from '../config/project-policy.js';
import { canonicalControlPath } from '../config/local-boundary.js';
import { canonicalDirectory, contains } from './store.js';
import { TaskError } from '../tasks/types.js';

const rowSchema = z.object({
  request_id: z.string(),
  project_key: z.string(),
  name: z.string(),
  root: z.string(),
  parent_root: z.string(),
  permissions: z.string(),
  state: z.enum(['creating', 'ready']),
  device: z.number().nullable(),
  inode: z.number().nullable(),
});
type Row = z.infer<typeof rowSchema>;
type Project = GatewayConfig['projects'][number];

export function validateCreationRoot(
  config: Pick<GatewayConfig, 'remoteProjectCreation' | 'projects'>,
  protectedPaths: string[],
) {
  const policy = config.remoteProjectCreation;
  if (!policy?.enabled) return;
  if (!isAbsolute(policy.root)) throw new TaskError('请选择远程新建项目的保存目录');
  const root = canonicalDirectory(policy.root);
  if (root !== policy.root || root === '/' || root === homedir())
    throw new TaskError('远程新建项目需要独立的规范目录，请在本机重新选择保存目录');
  const info = statSync(root);
  if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new TaskError('远程项目保存目录必须由当前用户拥有，且不能允许其他用户写入');
  try {
    accessSync(root, constants.W_OK | constants.X_OK);
  } catch {
    throw new TaskError('远程项目保存目录不可写，请在本机检查权限');
  }
  // Protect both the existing control files and future profiles/config files.
  for (const raw of protectedPaths) {
    const path = canonicalControlPath(raw);
    if (contains(root, path) || contains(path, root))
      throw new TaskError('远程项目保存目录不能与网关数据、配置或 Codex 数据目录重叠');
  }
  for (const project of config.projects) {
    let projectRoot: string;
    try {
      projectRoot = canonicalDirectory(project.root);
    } catch {
      continue;
    }
    if (contains(projectRoot, root))
      throw new TaskError('远程项目保存目录不能位于已有项目内，请选择独立目录');
  }
}

export function projectName(input: string) {
  const name = input.normalize('NFC').trim();
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name) ||
    /[. ]$/.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new TaskError(
      '项目名称需为 1–64 个字符，可用中文、字母、数字、空格、短横线和下划线；不能包含路径或以点结尾',
    );
  return name;
}

function projectFromRow(row: Row): Project {
  return {
    key: row.project_key,
    name: row.name,
    root: row.root,
    remotePermissions: remotePermissionsSchema.parse(JSON.parse(row.permissions)),
    ...(row.device !== null && row.inode !== null
      ? { directoryIdentity: { dev: row.device, ino: row.inode } }
      : {}),
  };
}

/** Read-only use is also supported by the desktop's project discovery. */
export function registeredProjects(db: Database.Database, owner: string, chat: string): Project[] {
  if (
    !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='remote_projects'").get()
  )
    return [];
  return db
    .prepare(
      "SELECT * FROM remote_projects WHERE owner_key=? AND chat_id=? AND state='ready' ORDER BY created_at",
    )
    .all(owner, chat)
    .map((row) => projectFromRow(rowSchema.parse(row)));
}

export class RemoteProjects {
  constructor(
    private readonly db: Database.Database,
    private readonly config: GatewayConfig,
    private readonly owner: string,
    private readonly chat: string,
  ) {}

  restore() {
    for (const project of registeredProjects(this.db, this.owner, this.chat)) this.install(project);
  }

  private install(project: Project) {
    if (this.config.hiddenProjectRoots?.includes(project.root)) return;
    // Local settings are authoritative, including an explicit disabled permission.
    const configured = this.config.projects.find(
      (p) => p.key === project.key || p.root === project.root,
    );
    if (configured) {
      if (configured.root === project.root && project.directoryIdentity)
        configured.directoryIdentity = project.directoryIdentity;
      return;
    }
    this.config.projects.push(project);
  }

  create(requestId: string, input: string): Project {
    const name = projectName(input);
    const existing = rowSchema
      .optional()
      .parse(
        this.db
          .prepare('SELECT * FROM remote_projects WHERE request_id=? AND owner_key=? AND chat_id=?')
          .get(requestId, this.owner, this.chat),
      );
    if (existing) {
      if (existing.name !== name) throw new TaskError('同一次创建请求的名称发生变化，请重新发起');
      if (existing.state === 'ready') {
        const project = projectFromRow(existing);
        this.install(project);
        const effective = this.config.projects.find((p) => p.root === project.root);
        if (!effective || this.config.hiddenProjectRoots?.includes(project.root))
          throw new TaskError('项目此前已创建，但已在本机移除或更改目录；请从 /项目 核对');
        return effective;
      }
    }
    const policy = this.config.remoteProjectCreation;
    if (!policy?.enabled)
      throw new TaskError(
        '远程新建项目尚未开启，请在本机 App 的「本地项目 → 远程新建项目」配置并应用',
      );
    validateCreationRoot(this.config, [
      this.config.dataDir,
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      ...(this.config.feishu.credentialsFile ? [this.config.feishu.credentialsFile] : []),
    ]);
    const root = join(policy.root, name);
    if (
      existing &&
      (existing.root !== root || existing.permissions !== JSON.stringify(policy.permissions))
    )
      throw new TaskError('本机创建设置已变化，旧请求不会继续，请在本机核对');
    const key = `remote-${createHash('sha256').update(requestId).digest('hex').slice(0, 20)}`;
    if (!existing) {
      if (
        this.config.projects.length >= 100 ||
        Number(this.db.prepare('SELECT count(*) FROM remote_projects').pluck().get()) >= 100
      )
        throw new TaskError('项目数量已达到上限（100），请在本机管理项目');
      if (
        this.config.projects.some((p) => p.key === key || p.root === root) ||
        this.db.prepare('SELECT 1 FROM remote_projects WHERE root=?').get(root)
      )
        throw new TaskError('同名项目已经存在，请从 /项目 选择，或使用其他名称');
      this.db
        .prepare(
          "INSERT INTO remote_projects (request_id,owner_key,chat_id,project_key,name,root,parent_root,permissions,state,created_at) VALUES (?,?,?,?,?,?,?,?,'creating',?)",
        )
        .run(
          requestId,
          this.owner,
          this.chat,
          key,
          name,
          root,
          policy.root,
          JSON.stringify(policy.permissions),
          Date.now(),
        );
    }
    // Persist intent BEFORE mkdir. Never adopt an existing directory after a crash.
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        if (!existing)
          this.db
            .prepare("DELETE FROM remote_projects WHERE request_id=? AND state='creating'")
            .run(requestId);
        throw new TaskError(
          existing
            ? '上次创建结果尚未确认，目录已保留；请在本机核对并添加，不会重复创建或覆盖'
            : '同名目录已经存在，不会覆盖；请使用其他名称或在本机添加该目录',
        );
      }
      throw new TaskError('无法创建项目目录，请在本机检查保存位置与磁盘权限后重试');
    }
    const info = lstatSync(root);
    if (!info.isDirectory() || canonicalDirectory(root) !== root)
      throw new TaskError('创建目录的归属无法确认，请在本机核对');
    this.db
      .prepare(
        "UPDATE remote_projects SET state='ready',device=?,inode=? WHERE request_id=? AND state='creating'",
      )
      .run(info.dev, info.ino, requestId);
    const project: Project = {
      key: existing?.project_key ?? key,
      name,
      root,
      remotePermissions: { ...policy.permissions },
      directoryIdentity: { dev: info.dev, ino: info.ino },
    };
    this.install(project);
    return project;
  }
}
