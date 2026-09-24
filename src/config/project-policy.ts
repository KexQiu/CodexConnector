import { z } from 'zod';

export const maxConcurrentTasksSchema = z.number().int().min(1).max(8).default(1);
export const remotePermissionsSchema = z.strictObject({
  mode: z.enum(['disabled', 'read-only', 'workspace-write']),
  networkAccess: z.boolean(),
});
export type RemotePermissions = z.infer<typeof remotePermissionsSchema>;
export type ProjectAccess = {
  remoteWrite?: boolean | undefined;
  remotePermissions?: RemotePermissions | undefined;
};
export const projectAccessFields = {
  remoteWrite: z.boolean().optional(),
  remotePermissions: remotePermissionsSchema.optional(),
};
export const hasOneProjectPolicy = (p: ProjectAccess) =>
  (p.remoteWrite !== undefined) !== (p.remotePermissions !== undefined);

/** Old configurations keep their approval flow until explicitly converted locally. */
export function projectPermissions(project: ProjectAccess | undefined): RemotePermissions {
  return (
    project?.remotePermissions ?? {
      mode: project?.remoteWrite ? 'workspace-write' : 'disabled',
      networkAccess: false,
    }
  );
}
export const canExecuteProject = (project: ProjectAccess | undefined) =>
  projectPermissions(project).mode !== 'disabled';
export function projectPermissionLabel(project: ProjectAccess | undefined) {
  if (!canExecuteProject(project)) return '只读 · 尚未开放远程执行';
  if (!project?.remotePermissions) return '可执行 · 旧版审批策略';
  const policy = projectPermissions(project);
  return `${policy.mode === 'read-only' ? '只读分析' : '允许修改文件'} · ${policy.networkAccess ? '允许联网' : '禁止联网'}`;
}
