import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import profileJson from './compatibility-profile.json' with { type: 'json' };
import { compareContract, type Contract, type Json } from './contract.js';
import { resolveCodexBinary } from './binary.js';

const exec = promisify(execFile);
const profile = profileJson as Contract;
// Version-specific semantic regressions can be blocked even when schema is unchanged.
const blockedVersions: Readonly<Record<string, string>> = {};
const verifiedVersions = new Set(['0.155.0-alpha.9.2']);
export type CodexCompatibility = {
  ok: boolean;
  status: 'verified' | 'compatible' | 'incompatible' | 'unavailable';
  actual: string | null;
  expected: string;
  binary: string;
  profile: string;
  issues: string[];
  message: string;
};
export async function inspectCodex(requested?: string): Promise<CodexCompatibility> {
  const binary = resolveCodexBinary(requested);
  const result: CodexCompatibility = {
    ok: false,
    status: 'unavailable',
    actual: null,
    expected: `${profile.id}（协议基线 ${profile.sourceVersion}）`,
    binary,
    profile: profile.id,
    issues: [],
    message: '',
  };
  let scratch: string | undefined;
  try {
    const version = async () =>
      (await exec(binary, ['--version'], { timeout: 5000, maxBuffer: 65536 })).stdout.trim();
    result.actual = await version();
    const match = /^codex-cli (\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$/.exec(
      result.actual,
    );
    if (!match) throw new Error('无法识别 Codex 版本输出，请选择官方 Codex 可执行文件');
    const release = match[1]!;
    result.status = 'incompatible';
    if (blockedVersions[release]) throw new Error(`该版本已知不兼容：${blockedVersions[release]}`);
    scratch = await mkdtemp(join(tmpdir(), 'cc-protocol-'));
    const home = join(scratch, 'home');
    await mkdir(home, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
    for (const key of Object.keys(env))
      if (/TOKEN|API_KEY|SECRET|PASSWORD|CODEX_AUTH|CODEX_ACCESS|NODE_OPTIONS|NODE_PATH/i.test(key))
        delete env[key];
    const out = join(scratch, 'schemas');
    try {
      await exec(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', out], {
        cwd: scratch,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      const file = join(out, 'codex_app_server_protocol.schemas.json');
      if ((await stat(file)).size > 16 * 1024 * 1024) throw new Error('schema too large');
      result.issues = compareContract(profile, JSON.parse(await readFile(file, 'utf8')) as Json);
    } catch {
      throw new Error('无法导出或读取 Codex 协议，请核对程序和版本；未跳过兼容性检查');
    }
    if ((await version()) !== result.actual)
      throw new Error('检查期间 Codex 已更新，请重新检查后启动');
    if (result.issues.length)
      throw new Error(`核心协议不兼容：${result.issues.slice(0, 3).join('；')}`);
    result.ok = true;
    result.status = verifiedVersions.has(release) ? 'verified' : 'compatible';
    result.message = `${result.actual} · ${result.status === 'verified' ? '已验证版本，核心协议检查通过' : '核心协议检查通过，可启动；该版本尚未完成完整联调'}；启动时检查登录`;
  } catch (error) {
    result.message =
      result.actual === null
        ? `无法执行 Codex：${binary}。请检查文件是否存在及执行权限`
        : error instanceof Error && !('stdout' in error) && !('stderr' in error)
          ? error.message
          : 'Codex 版本检查失败，请重新选择程序';
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}
