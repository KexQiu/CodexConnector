import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { gatewayConfigSchema } from '../src/config/schema.ts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { discoverProfileProjects, discoverProjects } from '../src/desktop/projects.ts';
import { appendProject, mergeDiscoveredProjects } from '../src/desktop/project-selection.ts';
import { defaultSettings, DesktopVault } from '../src/desktop/vault.ts';

let home;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cc-projects-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function directory(name) {
  const path = join(home, name);
  mkdirSync(path);
  return path;
}
function registry(entries) {
  const path = join(home, 'state_5.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER); PRAGMA user_version=42;`);
  entries.forEach((p, i) => {
    db.prepare('INSERT INTO projects VALUES (?,?,?)').run(String(i), p.name, i);
    p.roots.forEach((root, n) =>
      db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run(String(i), root, n),
    );
  });
  db.close();
  return path;
}
function globalState(state) {
  writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify(state));
}

it('returns an empty catalog without creating a Codex database or starting services', () => {
  expect(discoverProjects([], home)).toEqual({
    projects: [],
    canonicalRoots: {},
    unavailableRoots: [],
    unavailable: 0,
  });
  expect(readdirSync(home)).toEqual([]);
});
it('reads ordered project roots without changing the database, deduplicates aliases and skips missing paths', () => {
  const first = directory('含 空格'),
    second = directory('_other');
  const alias = join(home, 'alias');
  symlinkSync(first, alias);
  const db = registry([
    { name: 'Edited in Codex', roots: [first, alias, second, join(home, 'missing')] },
  ]);
  globalState({ 'electron-saved-workspace-roots': [directory('stale')] });
  const bytes = readFileSync(db),
    files = readdirSync(home);
  const result = discoverProjects([alias, join(home, 'missing')], home);
  expect(result.projects.map((p) => p.root)).toEqual([first, second]);
  expect(result.projects.map((p) => p.name)).toEqual(['Edited in Codex', 'Edited in Codex']);
  expect(result.canonicalRoots).toEqual({ [alias]: first });
  expect(result.unavailableRoots).toEqual([join(home, 'missing')]);
  expect(result.unavailable).toBe(1);
  expect(result.projects.map((p) => p.key)).toEqual(
    discoverProjects([], home).projects.map((p) => p.key),
  );
  for (const p of result.projects) expect(p.key).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
  expect(() =>
    gatewayConfigSchema.shape.projects.parse(
      result.projects.map((p) => ({ ...p, remoteWrite: false })),
    ),
  ).not.toThrow();
  expect(new Set(result.projects.map((p) => p.key)).size).toBe(2);
  expect(readFileSync(db)).toEqual(bytes);
  expect(readdirSync(home)).toEqual(files);
});
it('does not resurrect legacy entries when the current registry is empty', () => {
  registry([]);
  globalState({ 'electron-saved-workspace-roots': [directory('stale')] });
  expect(discoverProjects([], home).projects).toEqual([]);
});
it('supports the older local UI registry without reading unrelated state fields', () => {
  const root = directory('legacy');
  globalState({
    'local-projects': { p: { name: 'Named project', rootPaths: [root] } },
    unrelated: 'not returned',
  });
  expect(discoverProjects([], home).projects).toMatchObject([{ name: 'Named project', root }]);
  globalState({ 'electron-saved-workspace-roots': [root] });
  expect(discoverProjects([], home).projects[0].name).toBe('legacy');
});
it('handles an unavailable registry without attempting migrations or returning private data', () => {
  const db = registry([]);
  const connection = new Database(db);
  connection.exec('DROP TABLE project_roots');
  connection.close();
  const before = readFileSync(db);
  expect(() => discoverProjects([], home)).toThrow('暂时无法读取 Codex 项目列表');
  expect(readFileSync(db)).toEqual(before);
});
it('reports missing configured directories independently of a failed Codex catalog read', () => {
  const available = directory('available');
  const missing = join(home, 'offline-volume');
  const db = registry([]);
  const connection = new Database(db);
  connection.exec('DROP TABLE project_roots');
  connection.close();
  const result = discoverProfileProjects(
    {
      knownRoots: [available, missing],
      dataDir: join(home, 'data'),
      feishu: defaultSettings().feishu,
    },
    home,
  );
  expect(result.canonicalRoots).toEqual({ [available]: available });
  expect(result.unavailableRoots).toEqual([missing]);
  expect(result.warning).toContain('Codex 项目暂不可读');
});
it('clears the unavailable marker after a directory returns without changing its saved identity', () => {
  const missing = join(home, 'offline-volume');
  const saved = {
    ...defaultSettings(),
    projects: [{ key: 'saved-id', name: 'Saved name', root: missing, remoteWrite: false }],
  };
  const discovery = discoverProjects([missing], home);
  expect(discovery.unavailableRoots).toEqual([missing]);
  expect(mergeDiscoveredProjects(saved, discovery)).toBe(saved);
  mkdirSync(missing);
  const restored = discoverProjects([missing], home);
  expect(restored.unavailableRoots).toEqual([]);
  expect(restored.canonicalRoots[missing]).toBe(missing);
  expect(mergeDiscoveredProjects(saved, restored)).toBe(saved);
});
it('bounds and validates legacy catalogs', () => {
  globalState({ 'electron-saved-workspace-roots': ['relative'] });
  expect(() => discoverProjects([], home)).toThrow('暂时无法读取');
  globalState({ 'electron-saved-workspace-roots': Array(501).fill(home) });
  expect(() => discoverProjects([], home)).toThrow('暂时无法读取');
});
it('merges into current edits, preserving permission and ID while respecting removals and aliases', () => {
  const root = directory('work'),
    other = directory('new'),
    hidden = directory('hidden');
  const alias = join(home, 'alias');
  symlinkSync(root, alias);
  registry([{ name: 'Codex name', roots: [root, other, hidden] }]);
  const current = {
    ...defaultSettings(),
    hiddenProjectRoots: [hidden],
    projects: [
      {
        key: 'my-stable-id',
        name: 'Unsaved edited name',
        root: alias,
        remotePermissions: { mode: 'workspace-write', networkAccess: true },
      },
    ],
  };
  const discovery = discoverProjects([alias, hidden], home);
  const merged = mergeDiscoveredProjects(current, discovery);
  expect(merged.projects).toHaveLength(2);
  expect(merged.projects[0]).toBe(current.projects[0]);
  expect(merged.projects[1]).toMatchObject({
    root: other,
    remotePermissions: { mode: 'disabled', networkAccess: false },
  });
  expect(merged.hiddenProjectRoots).toBe(current.hiddenProjectRoots);
  expect(mergeDiscoveredProjects(merged, discovery)).toBe(merged);
});
it('does not restore a project removed while discovery was in flight', () => {
  const root = directory('removed');
  registry([{ name: 'Project', roots: [root] }]);
  const discovery = discoverProjects([], home);
  const latest = { ...defaultSettings(), hiddenProjectRoots: [root] };
  expect(mergeDiscoveredProjects(latest, discovery)).toBe(latest);
});
it('retains configured projects absent from Codex and limits automatic additions', () => {
  const settings = {
    ...defaultSettings(),
    projects: Array.from({ length: 100 }, (_, i) => ({
      key: `p${i}`,
      name: 'Existing',
      root: join(home, String(i)),
      remoteWrite: false,
    })),
  };
  registry([{ name: 'New', roots: [home] }]);
  expect(mergeDiscoveredProjects(settings, discoverProjects([], home))).toBe(settings);
  expect(
    appendProject(settings.projects, { key: 'p0', name: 'Manual', root: home }).at(-1).key,
  ).toBe('p0-2');
});
it('persists exclusions in a draft, so discovery after reopening does not re-add removed projects', () => {
  const root = directory('removed');
  registry([{ name: 'Project', roots: [root] }]);
  const vault = new DesktopVault(join(home, 'app'), {
    encrypt: () => {
      throw new Error('unexpected encryption');
    },
    decrypt: () => '',
  });
  const settings = { ...defaultSettings(), hiddenProjectRoots: [root] };
  vault.write('draft', vault.prepare(settings));
  const reopened = vault.read('draft').settings;
  expect(
    mergeDiscoveredProjects(reopened, discoverProjects(reopened.hiddenProjectRoots, home)),
  ).toBe(reopened);
});
