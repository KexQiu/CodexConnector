import { projectPermissions, type ProjectAccess } from '../config/project-policy.js';
import { GATEWAY_THREAD_POLICY, type RequestParams } from '../codex/protocol.js';
import { TaskError } from './types.js';
import { z } from 'zod';

export function executionPolicy(project: ProjectAccess, cwd: string) {
  const policy = projectPermissions(project);
  if (policy.mode === 'disabled') throw new TaskError('项目未开放远程执行');
  // Approval must never turn a hard local limit into an unsandboxed command.
  const approvalPolicy = project.remotePermissions ? 'never' : 'on-request';
  const sandboxPolicy: RequestParams<'turn/start'>['sandboxPolicy'] =
    policy.mode === 'read-only'
      ? { type: 'readOnly', networkAccess: policy.networkAccess }
      : {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: policy.networkAccess,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        };
  return {
    thread: {
      ...GATEWAY_THREAD_POLICY,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      sandbox: policy.mode,
      approvalPolicy,
      ...(project.remotePermissions
        ? {
            config: {
              web_search: policy.networkAccess ? 'live' : 'disabled',
              'sandbox_workspace_write.network_access': policy.networkAccess,
              'sandbox_workspace_write.exclude_tmpdir_env_var': true,
              'sandbox_workspace_write.exclude_slash_tmp': true,
              'features.hooks': false,
              'features.plugins': false,
              'features.apps': false,
              'features.multi_agent': false,
            },
          }
        : {}),
    } satisfies RequestParams<'thread/start'>,
    turn: {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy,
      approvalsReviewer: 'user',
      sandboxPolicy,
    } satisfies Partial<RequestParams<'turn/start'>>,
  };
}

export function assertProjectInteraction(project: ProjectAccess, method: string) {
  if (projectPermissions(project).mode === 'disabled') throw new TaskError('项目执行权限已关闭');
  if (project.remotePermissions && method !== 'item/tool/requestUserInput')
    throw new TaskError('本机权限为硬限制，飞书不能批准权限扩展');
}

export function assertThreadPolicy(
  project: ProjectAccess,
  cwd: string,
  response: { approvalPolicy?: unknown; sandbox?: unknown },
) {
  if (!project.remotePermissions) return;
  const policy = projectPermissions(project);
  const sandbox = z
    .object({
      type: z.enum(['readOnly', 'workspaceWrite']),
      networkAccess: z.boolean(),
      writableRoots: z.array(z.string()).optional(),
      excludeTmpdirEnvVar: z.boolean().optional(),
      excludeSlashTmp: z.boolean().optional(),
    })
    .parse(response.sandbox);
  if (
    response.approvalPolicy !== 'never' ||
    (!policy.networkAccess && sandbox.networkAccess) ||
    (policy.mode === 'read-only' && sandbox.type !== 'readOnly') ||
    (sandbox.type === 'workspaceWrite' &&
      (!sandbox.excludeTmpdirEnvVar ||
        !sandbox.excludeSlashTmp ||
        !sandbox.writableRoots ||
        sandbox.writableRoots.some((root) => root !== cwd)))
  )
    throw new TaskError('服务端未应用本机权限限制');
}
