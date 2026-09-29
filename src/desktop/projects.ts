import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalDirectory } from '../projects/store.js';
import type { DesktopSettings, DiscoveredProject, ProjectDiscovery } from './contracts.js';
import { registeredProjects } from '../projects/remote.js';
import { ownerKey } from '../tasks/store.js';

const rootSchema = z.string().max(4096).refine(isAbsolute);
const rowsSchema = z.array(z.object({ name: z.string().max(4096), root: rootSchema })).max(500);
export function discoverProfileProjects(
  input: { knownRoots: string[]; dataDir: string; feishu: DesktopSettings['feishu'] },
  home?: string,
): ProjectDiscovery {
  let discovery: ProjectDiscovery;
  try {
    discovery = discoverProjects(input.knownRoots, home);
  } catch {
    discovery = {
      projects: [],
      ...inspectKnownRoots(input.knownRoots),
      unavailable: 0,
      warning: 'Codex 项目暂不可读，已保留当前列表并读取远程项目。',
    };
  }
  const path = join(input.dataDir, 'gateway.sqlite');
  if (!existsSync(path)) return discovery;
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    const owner = ownerKey({
      appId: input.feishu.appId,
      tenantKey: input.feishu.tenantKey,
      openId: input.feishu.allowedOpenId,
    });
    const remote = registeredProjects(db, owner, input.feishu.testChatId).map(
      ({ key, name, root, remotePermissions }) => ({
        key,
        name,
        root,
        ...(remotePermissions ? { remotePermissions } : {}),
      }),
    );
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='remote_projects'").get()) {
      const pending = Number(
        db
          .prepare(
            "SELECT count(*) FROM remote_projects WHERE owner_key=? AND chat_id=? AND state='creating'",
          )
          .pluck()
          .get(owner, input.feishu.testChatId),
      );
      if (pending)
        discovery.warning = [
          discovery.warning,
          `${pending} 个项目创建结果待核对，请检查保存目录后手动添加；系统不会覆盖或删除目录。`,
        ]
          .filter(Boolean)
          .join(' ');
    }
    // Prefer the durable gateway key and locally granted policy over a Codex discovery alias.
    return {
      ...discovery,
      projects: [
        ...remote,
        ...discovery.projects.filter((p) => !remote.some((r) => r.root === p.root)),
      ],
    };
  } finally {
    db.close();
  }
}
function projectRows(home: string): { name: string; root: string }[] {
  // Versioned, read-only adapter for the verified Codex baseline. Never open thread
  // tables, migrate this database, or start another Codex/Feishu connection.
  const path = join(home, 'state_5.sqlite');
  if (existsSync(path)) {
    const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 250 });
    try {
      db.pragma('query_only = ON');
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
        .get();
      if (table)
        return rowsSchema.parse(
          db
            .prepare(
              `SELECT p.name, r.path AS root
        FROM projects p JOIN project_roots r ON p.id=r.project_id
        ORDER BY p.position, p.id, r.position LIMIT 501`,
            )
            .all(),
        );
    } finally {
      db.close();
    }
  }
  // Pre-project-registry desktop versions keep only a local UI catalog. An empty
  // authoritative projects table above must not resurrect removed legacy entries.
  const stateFile = join(home, '.codex-global-state.json');
  if (!existsSync(stateFile)) return [];
  if (statSync(stateFile).size > 10 * 1024 * 1024) throw new Error('项目列表文件超出读取上限');
  const state = z
    .object({
      'local-projects': z
        .record(z.string(), z.object({ name: z.string(), rootPaths: z.array(rootSchema) }))
        .optional(),
      'electron-saved-workspace-roots': z.array(rootSchema).optional(),
    })
    .parse(JSON.parse(readFileSync(stateFile, 'utf8')));
  if (state['local-projects'])
    return rowsSchema.parse(
      Object.values(state['local-projects']).flatMap((p) =>
        p.rootPaths.map((root) => ({ name: p.name, root })),
      ),
    );
  return rowsSchema.parse(
    (state['electron-saved-workspace-roots'] ?? []).map((root) => ({ name: basename(root), root })),
  );
}

export function discoverProjects(
  knownRoots: string[],
  home = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
): ProjectDiscovery {
  const known = inspectKnownRoots(knownRoots);
  let rows: { name: string; root: string }[];
  try {
    rows = projectRows(home);
  } catch {
    throw new Error('暂时无法读取 Codex 项目列表，已保留当前项目；请稍后刷新或手动添加目录。');
  }
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  let unavailable = 0;
  for (const row of rows) {
    let root: string;
    try {
      root = canonicalDirectory(row.root);
    } catch {
      unavailable++;
      continue;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    const suffix = createHash('sha256').update(root).digest('hex').slice(0, 10);
    const slug =
      basename(root)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^[-_]+|-+$/g, '')
        .slice(0, 48) || 'project';
    projects.push({
      key: `${slug}-${suffix}`,
      name: row.name.trim() || basename(root) || '项目',
      root,
    });
  }
  return { projects, ...known, unavailable };
}

function inspectKnownRoots(knownRoots: string[]) {
  const canonicalRoots: Record<string, string> = {};
  const unavailableRoots: string[] = [];
  for (const root of knownRoots) {
    try {
      canonicalRoots[root] = canonicalDirectory(root);
    } catch {
      unavailableRoots.push(root);
    }
  }
  return { canonicalRoots, unavailableRoots };
}
