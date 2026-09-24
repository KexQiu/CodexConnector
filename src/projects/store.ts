import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import type { GatewayConfig } from '../config/schema.js';
import type { CodexRpcClient } from '../codex/rpc-client.js';
import { threadListSchema } from '../codex/schemas.js';
import { TaskError } from '../tasks/types.js';
import { canExecuteProject, projectPermissions } from '../config/project-policy.js';

const projectPage = z.object({
  data: z.array(
    z.object({ id: z.string(), name: z.string(), roots: z.array(z.object({ path: z.string() })) }),
  ),
  nextCursor: z.string().nullable(),
});
type ConfiguredProject = GatewayConfig['projects'][number];
export function canonicalDirectory(path: string): string {
  try {
    const canonical = realpathSync(path);
    if (statSync(canonical).isDirectory()) return canonical;
  } catch {
    /* reported without exposing paths */
  }
  throw new TaskError('项目目录不存在或不可访问');
}
export function contains(root: string, path: string) {
  const suffix = relative(root, path);
  return (
    suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
  );
}
export function writableProject(projects: ConfiguredProject[], key: string, expectedCwd?: string) {
  const project = executableProject(projects, key, expectedCwd);
  if (projectPermissions(project).mode !== 'workspace-write')
    throw new TaskError('项目未开启文件修改权限');
  return project;
}
export function executableProject(
  projects: ConfiguredProject[],
  key: string,
  expectedCwd?: string,
) {
  const project = projects.find((entry) => entry.key === key);
  if (!project || !canExecuteProject(project))
    throw new TaskError('项目未开放远程执行（remoteWrite / remotePermissions）');
  const cwd = canonicalDirectory(project.root);
  if (expectedCwd && cwd !== expectedCwd) throw new TaskError('项目目录已改变，拒绝按旧任务执行');
  const aliases = projects.filter((other) => {
    if (other.key === key) return false;
    try {
      return canonicalDirectory(other.root) === cwd;
    } catch {
      return false;
    }
  });
  if (aliases.length) throw new TaskError('多个项目 key 指向同一规范目录，请消除歧义');
  return { ...project, cwd };
}

/** A worktree's .git file marks its own checkout; subdirectories share the parent lock. */
export function checkoutRoot(cwd: string): string {
  const canonical = canonicalDirectory(cwd);
  for (let current = canonical; ; current = dirname(current)) {
    try {
      const marker = lstatSync(join(current, '.git'));
      if (marker.isFile() || marker.isDirectory()) return current;
      throw new TaskError('Git 目录标记不安全');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) return canonical;
  }
}

export class ProjectStore {
  constructor(
    private readonly projects: ConfiguredProject[],
    private readonly rpc: Pick<CodexRpcClient, 'request'>,
  ) {}
  localProjects() {
    return this.projects.map((project) => {
      try {
        return {
          ...project,
          canonicalRoot: canonicalDirectory(project.root),
          available: true,
          source: 'configured' as const,
        };
      } catch {
        return { ...project, canonicalRoot: null, available: false, source: 'configured' as const };
      }
    });
  }
  async catalog() {
    const configured = this.localProjects();
    const roots = new Set(
      configured.flatMap((project) => (project.canonicalRoot ? [project.canonicalRoot] : [])),
    );
    const discovered: {
      key: string;
      name: string;
      root: string;
      canonicalRoot: string | null;
      available: boolean;
      remoteWrite: boolean;
      source: 'codex';
    }[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result: z.infer<typeof projectPage> = await this.rpc.request(
        'project/list',
        { cursor, limit: 100 },
        projectPage,
      );
      for (const project of result.data)
        for (const [index, root] of project.roots.entries()) {
          let canonicalRoot: string | null = null;
          try {
            canonicalRoot = canonicalDirectory(root.path);
          } catch {
            /* surface an unavailable read-only project */
          }
          if (canonicalRoot && roots.has(canonicalRoot)) continue;
          if (canonicalRoot) roots.add(canonicalRoot);
          discovered.push({
            key: `codex:${project.id}:${index}`,
            name: project.name,
            root: root.path,
            canonicalRoot,
            available: canonicalRoot !== null,
            remoteWrite: false,
            source: 'codex',
          });
        }
      if (!result.nextCursor) return [...configured, ...discovered];
      if (seen.has(result.nextCursor)) throw new TaskError('项目分页游标重复，拒绝返回伪完整列表');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new TaskError('项目列表超出读取上限，请缩小数据范围');
  }
  async sessions(projectKey: string, offset = 0, limit = 20) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new TaskError('分页参数无效');
    const projects = await this.catalog();
    const selected = projects.find((project) => project.key === projectKey);
    if (!selected) throw new TaskError('项目不存在');
    if (!selected.canonicalRoot) return { data: [], total: null, available: false };
    const configuredRoots = projects.filter(
      (project) => project.source === 'configured' && project.canonicalRoot,
    );
    if (
      new Set(configuredRoots.map((project) => project.canonicalRoot)).size !==
      configuredRoots.length
    )
      throw new TaskError('配置项目目录存在歧义，无法可靠分配会话');
    const matched: z.infer<typeof threadListSchema>['data'] = [];
    let unavailablePaths = 0;
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result: z.infer<typeof threadListSchema> = await this.rpc.request(
        'thread/list',
        {
          cursor,
          limit: 100,
          useStateDbOnly: true,
          modelProviders: [],
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
          sortKey: 'updated_at',
        },
        threadListSchema,
      );
      for (const thread of result.data) {
        let cwd: string;
        try {
          cwd = canonicalDirectory(thread.cwd);
        } catch {
          unavailablePaths++;
          continue;
        }
        const owner = projects
          .filter((project) => project.canonicalRoot && contains(project.canonicalRoot, cwd))
          .sort((a, b) => (b.canonicalRoot?.length ?? 0) - (a.canonicalRoot?.length ?? 0))[0];
        if (owner?.key === selected.key) matched.push(thread);
      }
      if (!result.nextCursor)
        return {
          data: matched.slice(offset, offset + limit),
          total: matched.length,
          available: true,
          skippedUnavailablePaths: unavailablePaths,
        };
      if (seen.has(result.nextCursor)) throw new TaskError('会话分页游标重复');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new TaskError('会话列表超过读取上限，未返回截断结果');
  }
}
