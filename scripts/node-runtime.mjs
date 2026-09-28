import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(import.meta.dirname);
const baseline = JSON.parse(readFileSync(join(root, 'src/runtime-baseline.json'), 'utf8'));
export function nodeEnvironment(binary, original = process.env) {
  const env = { ...original, PATH: `${dirname(binary)}:${original.PATH ?? '/usr/bin:/bin'}` };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function validateNode(binary, version) {
  const actual = JSON.parse(
    execFileSync(
      binary,
      [
        '-p',
        'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,napi:process.versions.napi})',
      ],
      { encoding: 'utf8', timeout: 5000, env: nodeEnvironment(binary) },
    ),
  );
  if (
    actual.version !== version ||
    actual.platform !== process.platform ||
    actual.arch !== process.arch
  )
    throw new Error(`内置 Node 不匹配：需要 ${version} / ${process.platform} / ${process.arch}`);
  const license = join(dirname(dirname(binary)), 'LICENSE');
  if (!existsSync(license)) throw new Error('Node 安装目录缺少 LICENSE，请使用官方完整发行包');
  return { binary, license, ...actual };
}

/** Official Node archives stay in this checkout's ignored cache, never in the global PATH. */
export function ensureNode(version = baseline.node, { preferHost = true } = {}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('需要明确的 Node 稳定版本号');
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('桌面运行时准备目前仅支持 macOS arm64');
  if (preferHost && process.versions.node === version) {
    const license = join(dirname(dirname(process.execPath)), 'LICENSE');
    if (existsSync(license)) return validateNode(process.execPath, version);
  }
  const cache = join(root, '.artifacts/node-runtimes');
  const name = `node-v${version}-${process.platform}-${process.arch}`;
  const destination = join(cache, name);
  const binary = join(destination, 'bin/node');
  if (existsSync(destination)) return validateNode(binary, version);
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(cache, '.download-'));
  try {
    const filename = `${name}.tar.xz`;
    const download = (file) => {
      const target = join(staging, file);
      execFileSync(
        '/usr/bin/curl',
        [
          '-fL',
          '--silent',
          '--show-error',
          '--connect-timeout',
          '15',
          '--max-time',
          '600',
          '--retry',
          '2',
          '-o',
          target,
          `https://nodejs.org/dist/v${version}/${file}`,
        ],
        { stdio: 'inherit' },
      );
      return target;
    };
    console.log(`准备 Node ${version}（项目内缓存，不修改系统 Node）`);
    const sums = readFileSync(download('SHASUMS256.txt'), 'utf8');
    const entry = sums
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, file]) => file === filename);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry[0])) throw new Error('官方校验清单缺少目标 Node 包');
    const archive = download(filename);
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== entry[0])
      throw new Error('Node 下载 SHA-256 校验失败');
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', staging], { stdio: 'inherit' });
    validateNode(join(staging, name, 'bin/node'), version);
    // Another local build may have finished the same download while we were waiting.
    if (!existsSync(destination)) renameSync(join(staging, name), destination);
    return validateNode(binary, version);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function bundledNode() {
  const override = process.env.CODEXCONNECTOR_BUNDLED_NODE;
  return override ? validateNode(resolve(override), baseline.node) : ensureNode();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('用法：pnpm runtime:setup [稳定版本号]');
  console.log(JSON.stringify(ensureNode(args[0] ?? baseline.node), null, 2));
}
