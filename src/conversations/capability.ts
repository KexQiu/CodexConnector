import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCodexBinary } from '../codex/binary.js';
import {
  projectlessCandidateConfig,
  projectlessCandidateVersion,
  projectlessPolicyRevision,
} from './policy.js';

// Attests the tested executable, not every build bearing the same version string.
const nativeHash = '3e11ccc743e8198a5ef84fb57c89941d845b0ea0302485ed1fbac2f0821aca5a';
const wrapperHash = '50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8';
export const projectlessModel = 'gpt-6-astra';
const attestedPolicyHash = '3c413a57c8a2302bfc63bee869500ef02723b9c37e9dc54f5389937a2dbf2a50';
export function attestedPolicyMatches() {
  const payload = [
    projectlessPolicyRevision,
    projectlessModel,
    Object.entries(projectlessCandidateConfig).sort(([a], [b]) => (a < b ? -1 : 1)),
  ];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex') === attestedPolicyHash;
}
export type ProjectlessCapability = {
  ok: boolean;
  actual: string | null;
  expected: string;
  policy: string;
  message: string;
};
async function hash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('无法校验程序内容');
    digest.update(chunk);
  }
  return digest.digest('hex');
}
export async function inspectProjectless(requested: string): Promise<ProjectlessCapability> {
  const result: ProjectlessCapability = {
    ok: false,
    actual: null,
    expected: projectlessCandidateVersion,
    policy: projectlessPolicyRevision,
    message: '',
  };
  try {
    if (!attestedPolicyMatches()) throw new Error('普通聊天策略已变化，原能力证据已失效');
    const binary = await realpath(resolveCodexBinary(requested));
    result.actual = (
      await promisify(execFile)(binary, ['--version'], { timeout: 5000, maxBuffer: 4096 })
    ).stdout.trim();
    if (result.actual !== `codex-cli ${projectlessCandidateVersion}`)
      throw new Error('版本未完成普通聊天能力验证');
    const entryHash = await hash(binary);
    const actualHash =
      entryHash === wrapperHash
        ? await hash(resolve(dirname(binary), '../CodexCLI.app/Contents/MacOS/codex'))
        : entryHash;
    if (actualHash !== nativeHash) throw new Error('程序内容未完成普通聊天能力验证');
    result.ok = true;
    result.message = `普通聊天能力已验证 · ${projectlessModel} · 仅允许内置时钟；启动时再次核对有效配置`;
  } catch (error) {
    result.message = `${error instanceof Error && !('stderr' in error) && !('code' in error) ? error.message : '无法验证 Codex 程序'}。需要重新运行 NP0 探针；项目功能不受影响。`;
  }
  return result;
}
