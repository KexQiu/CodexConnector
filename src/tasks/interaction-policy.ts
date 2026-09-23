import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { CommandExecutionRequestApprovalResponse } from '../codex/generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from '../codex/generated/v2/FileChangeRequestApprovalResponse.js';
import type { PermissionsRequestApprovalResponse } from '../codex/generated/v2/PermissionsRequestApprovalResponse.js';
import type { ToolRequestUserInputResponse } from '../codex/generated/v2/ToolRequestUserInputResponse.js';
import { TaskError } from './types.js';

const id = z.string().min(1).max(256);
const path = z.string().min(1).max(4096);
export const fileChangesSchema = z
  .array(
    z.object({
      path,
      kind: z.discriminatedUnion('type', [
        z.object({ type: z.literal('add') }),
        z.object({ type: z.literal('delete') }),
        z.object({ type: z.literal('update'), move_path: path.nullable() }),
      ]),
      diff: z.string().max(64000),
    }),
  )
  .min(1)
  .max(100);
const fsPermissions = z.strictObject({
  read: z.array(path).max(20).nullable(),
  write: z.array(path).max(20).nullable(),
  globScanMaxDepth: z.number().int().nonnegative().optional(),
  entries: z
    .array(
      z.strictObject({
        path: z.strictObject({ type: z.literal('path'), path }),
        access: z.enum(['read', 'write', 'deny']),
      }),
    )
    .max(20)
    .optional(),
});
const permissions = z.strictObject({
  network: z.strictObject({ enabled: z.boolean().nullable() }).nullable(),
  fileSystem: fsPermissions.nullable(),
});
const base = { threadId: id, turnId: id, itemId: id };
const schemas = {
  'item/commandExecution/requestApproval': z.object({
    ...base,
    command: z.string().min(1).max(8000),
    cwd: path,
    kind: z.enum(['command', 'writeStdin']).default('command'),
    reason: z.string().max(4000).nullish(),
    environmentId: z.literal('local').nullable().optional(),
    additionalPermissions: permissions.nullish(),
    availableDecisions: z.array(z.unknown()).nullish(),
    networkApprovalContext: z.unknown().optional(),
  }),
  'item/fileChange/requestApproval': z.object({
    ...base,
    reason: z.string().max(4000).nullish(),
    grantRoot: path.nullish(),
    gatewayChanges: fileChangesSchema.optional(),
  }),
  'item/permissions/requestApproval': z.object({
    ...base,
    cwd: path,
    environmentId: z.literal('local').nullable().optional(),
    reason: z.string().max(4000).nullable(),
    permissions,
  }),
  'item/tool/requestUserInput': z.object({
    ...base,
    isBlocking: z.boolean(),
    autoResolutionMs: z.number().int().positive().nullable(),
    questions: z
      .array(
        z.object({
          id,
          header: z.string().max(200),
          question: z.string().max(2000),
          isOther: z.boolean(),
          isSecret: z.literal(false),
          options: z
            .array(
              z.object({ label: z.string().min(1).max(500), description: z.string().max(1000) }),
            )
            .max(10)
            .nullable(),
        }),
      )
      .min(1)
      .max(3),
  }),
};
export type InteractionMethod = keyof typeof schemas;
export type Interaction = {
  [K in InteractionMethod]: { method: K; params: z.infer<(typeof schemas)[K]> };
}[InteractionMethod];
export type Decision = 'accept' | 'decline' | 'cancel' | 'network' | 'files' | 'answer';
export const decisionSchema = z.enum(['accept', 'decline', 'cancel', 'network', 'files', 'answer']);

/** Resolve the nearest existing ancestor too: a lexical prefix does not contain symlinks. */
export function withinRoot(root: string, value: string): boolean {
  if (!isAbsolute(value) || value.includes('\0')) return false;
  const canonicalRoot = realpathSync(root);
  let parent = resolve(value);
  for (;;) {
    try {
      lstatSync(parent);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return false;
      const next = dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
  }
  let actual;
  try {
    actual = resolve(realpathSync(parent), relative(parent, resolve(value)));
  } catch {
    return false;
  } // A dangling symlink is not a missing ordinary directory.
  const delta = relative(canonicalRoot, actual);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}
function validatePermissions(root: string, value: z.infer<typeof permissions>) {
  const fs = value.fileSystem;
  for (const p of [
    ...(fs?.read ?? []),
    ...(fs?.write ?? []),
    ...(fs?.entries?.map((e) => e.path.path) ?? []),
  ])
    if (!withinRoot(root, p)) throw new TaskError('请求的文件权限超出当前项目，远程审批已拒绝');
}
export function parseInteraction(method: string, params: unknown, cwd: string): Interaction {
  if (!Object.hasOwn(schemas, method)) throw new TaskError('不支持此交互请求');
  // The switch preserves the generated protocol's distinct request variants.
  let interaction: Interaction;
  switch (method) {
    case 'item/commandExecution/requestApproval':
      interaction = { method, params: schemas[method].parse(params) };
      break;
    case 'item/fileChange/requestApproval':
      interaction = { method, params: schemas[method].parse(params) };
      break;
    case 'item/permissions/requestApproval':
      interaction = { method, params: schemas[method].parse(params) };
      break;
    case 'item/tool/requestUserInput':
      interaction = { method, params: schemas[method].parse(params) };
      break;
    default:
      throw new TaskError('不支持此交互请求');
  }
  const p = interaction.params;
  if ('cwd' in p && !withinRoot(cwd, p.cwd)) throw new TaskError('审批目录超出项目');
  if ('grantRoot' in p && p.grantRoot && !withinRoot(cwd, p.grantRoot))
    throw new TaskError('审批授权根超出项目');
  if ('gatewayChanges' in p && p.gatewayChanges)
    for (const change of p.gatewayChanges) {
      if (!withinRoot(cwd, change.path)) throw new TaskError('文件变更超出项目');
      if (
        change.kind.type === 'update' &&
        change.kind.move_path &&
        !withinRoot(cwd, change.kind.move_path)
      )
        throw new TaskError('文件移动目标超出项目');
    }
  if ('permissions' in p) validatePermissions(cwd, p.permissions);
  if ('additionalPermissions' in p && p.additionalPermissions)
    validatePermissions(cwd, p.additionalPermissions);
  if ('questions' in p && new Set(p.questions.map((q) => q.id)).size !== p.questions.length)
    throw new TaskError('问题标识重复');
  if (Buffer.byteLength(JSON.stringify(interaction)) > 14000)
    throw new TaskError('审批信息过大，不能完整展示');
  return interaction;
}
export function choices(interaction: Interaction): { value: Decision; label: string }[] {
  if (interaction.method === 'item/tool/requestUserInput')
    return [{ value: 'cancel', label: '取消回答' }];
  const common: { value: Decision; label: string }[] = [
    {
      value: 'accept',
      label:
        interaction.method === 'item/permissions/requestApproval'
          ? '授予所列权限（本轮）'
          : '仅允许本次',
    },
    { value: 'decline', label: '拒绝' },
    { value: 'cancel', label: '取消' },
  ];
  if (
    interaction.method === 'item/commandExecution/requestApproval' &&
    interaction.params.availableDecisions
  )
    return common.filter((c) => interaction.params.availableDecisions!.includes(c.value));
  if (interaction.method === 'item/permissions/requestApproval') {
    if (interaction.params.permissions.network?.enabled)
      common.push({ value: 'network', label: '仅网络（本轮）' });
    if (interaction.params.permissions.fileSystem)
      common.push({ value: 'files', label: '仅所列文件权限（本轮）' });
  }
  return common;
}
export function interactionResponse(
  interaction: Interaction,
  choice: Decision,
  answers: Record<string, string> = {},
) {
  if (choice !== 'answer' && !choices(interaction).some((c) => c.value === choice))
    throw new TaskError('此决定不在请求允许的选项中');
  switch (interaction.method) {
    case 'item/commandExecution/requestApproval':
      if (!['accept', 'decline', 'cancel'].includes(choice)) throw new TaskError('无效命令决定');
      return {
        decision: choice as 'accept' | 'decline' | 'cancel',
      } satisfies CommandExecutionRequestApprovalResponse;
    case 'item/fileChange/requestApproval':
      if (!['accept', 'decline', 'cancel'].includes(choice)) throw new TaskError('无效文件决定');
      return {
        decision: choice as 'accept' | 'decline' | 'cancel',
      } satisfies FileChangeRequestApprovalResponse;
    case 'item/permissions/requestApproval': {
      if (choice === 'answer') throw new TaskError('无效权限决定');
      const p = interaction.params.permissions;
      return {
        permissions: {
          ...(['accept', 'network'].includes(choice) && p.network ? { network: p.network } : {}),
          ...(['accept', 'files'].includes(choice) && p.fileSystem
            ? {
                fileSystem: {
                  read: p.fileSystem.read,
                  write: p.fileSystem.write,
                  ...(p.fileSystem.entries ? { entries: p.fileSystem.entries } : {}),
                  ...(p.fileSystem.globScanMaxDepth !== undefined
                    ? { globScanMaxDepth: p.fileSystem.globScanMaxDepth }
                    : {}),
                },
              }
            : {}),
        },
        scope: 'turn',
      } satisfies PermissionsRequestApprovalResponse;
    }
    case 'item/tool/requestUserInput':
      if (choice === 'cancel') return { answers: {} } satisfies ToolRequestUserInputResponse;
      if (choice !== 'answer') throw new TaskError('此请求需要回答问题');
      return {
        answers: Object.fromEntries(
          interaction.params.questions.map((q) => {
            const answer = answers[q.id];
            if (!answer?.trim() || answer.length > 4000) throw new TaskError('请回答全部问题');
            if (q.options?.length && !q.isOther && !q.options.some((o) => o.label === answer))
              throw new TaskError('请选择题目列出的选项');
            return [q.id, { answers: [answer] }];
          }),
        ),
      } satisfies ToolRequestUserInputResponse;
  }
}
export function describeInteraction(
  interaction: Interaction,
  approvalId: string,
  cwd: string,
): string {
  const p = interaction.params;
  const lines = [`请求：${approvalId}`, `目录：${cwd}`];
  if ('reason' in p && p.reason) lines.push(`理由：${p.reason}`);
  switch (interaction.method) {
    case 'item/commandExecution/requestApproval':
      lines.push(
        `操作：${interaction.params.kind === 'writeStdin' ? '向已有终端输入' : '执行命令'}`,
        interaction.params.command,
        `执行目录：${interaction.params.cwd}`,
      );
      if (interaction.params.additionalPermissions)
        lines.push('附加权限：', describePermissions(interaction.params.additionalPermissions));
      if (interaction.params.networkApprovalContext)
        lines.push(`网络请求：${JSON.stringify(interaction.params.networkApprovalContext)}`);
      break;
    case 'item/fileChange/requestApproval':
      lines.push(
        '操作：修改文件',
        `授权根：${interaction.params.grantRoot ?? '当前请求涉及的文件'}`,
      );
      if (interaction.params.gatewayChanges)
        for (const change of interaction.params.gatewayChanges)
          lines.push(
            `文件：${change.path}`,
            `操作：${{ add: '新增', delete: '删除', update: '修改' }[change.kind.type]}`,
            change.kind.type === 'update' && change.kind.move_path
              ? `移动到：${change.kind.move_path}`
              : '',
            change.diff,
          );
      break;
    case 'item/permissions/requestApproval':
      lines.push(
        '操作：申请本轮权限',
        describePermissions(interaction.params.permissions),
        '可授予全部所列权限、仅网络、仅文件权限，或拒绝。不会保存为会话授权。',
      );
      break;
    case 'item/tool/requestUserInput':
      interaction.params.questions.forEach((q, i) =>
        lines.push(
          `${i + 1}. ${q.question}`,
          ...(q.options ?? []).map((o) => `- ${o.label}：${o.description}`),
        ),
      );
      lines.push(
        `逐题回复：/回答 ${approvalId.slice(0, 8)} 题号 答案`,
        '选择题请填写选项原文；全部回答后提交。',
      );
  }
  return lines.join('\n');
}

function describePermissions(p: z.infer<typeof permissions>) {
  const lines: string[] = [];
  if (p.network?.enabled) lines.push('网络：允许访问网络');
  for (const path of p.fileSystem?.read ?? []) lines.push(`读取：${path}`);
  for (const path of p.fileSystem?.write ?? []) lines.push(`写入：${path}`);
  for (const entry of p.fileSystem?.entries ?? [])
    lines.push(
      `${{ read: '读取', write: '写入', deny: '禁止访问' }[entry.access]}：${entry.path.path}`,
    );
  if (p.fileSystem?.globScanMaxDepth !== undefined)
    lines.push(`目录扫描最大深度：${p.fileSystem.globScanMaxDepth}`);
  return lines.join('\n') || '未请求额外权限';
}
