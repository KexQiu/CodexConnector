import { projectlessDirectoryRoot } from '../conversations/directories.js';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute, sep } from 'node:path';
import type { ProjectAccess } from './project-policy.js';

// Resolve existing ancestors too: the first launch may not have created the data directory yet.
export function canonicalControlPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT' ||
      dirname(path) === path
    )
      throw error;
    return join(canonicalControlPath(dirname(path)), basename(path));
  }
}
export function assertLocalConfigIsProtected(
  projects: (ProjectAccess & { key: string; root: string })[],
  paths: string[],
) {
  for (const project of projects) {
    if (project.remotePermissions?.mode !== 'workspace-write') continue;
    const root = canonicalControlPath(project.root);
    for (const path of [...paths, projectlessDirectoryRoot()]) {
      const suffix = relative(root, canonicalControlPath(path));
      if (
        suffix === '' ||
        (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
      )
        throw new Error(`项目 ${project.key} 的写入范围包含网关配置或数据目录，请选择独立项目目录`);
    }
  }
}
