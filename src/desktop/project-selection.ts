import type { DesktopSettings, DiscoveredProject, ProjectDiscovery } from './contracts.js';

export function appendProject(projects: DesktopSettings['projects'], project: DiscoveredProject) {
  const keys = new Set(projects.map((p) => p.key));
  let key = project.key,
    suffix = 2;
  while (keys.has(key)) key = `${project.key}-${suffix++}`;
  return [
    ...projects,
    {
      ...project,
      key,
      remotePermissions: project.remotePermissions ?? {
        mode: 'disabled' as const,
        networkAccess: false,
      },
    },
  ];
}

/** Merge into the latest editor state, never the snapshot used to begin the read. */
export function mergeDiscoveredProjects(settings: DesktopSettings, discovery: ProjectDiscovery) {
  const canonical = (root: string) => discovery.canonicalRoots[root] ?? root;
  const roots = new Set(settings.projects.map((p) => canonical(p.root)));
  const hidden = new Set(settings.hiddenProjectRoots.map(canonical));
  let projects = settings.projects;
  for (const project of discovery.projects) {
    if (roots.has(project.root) || hidden.has(project.root) || projects.length >= 100) continue;
    projects = appendProject(projects, project);
    roots.add(project.root);
  }
  return projects === settings.projects ? settings : { ...settings, projects };
}
