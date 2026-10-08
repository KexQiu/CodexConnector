import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { nodeEnvironment } from './node-runtime.mjs';
import { prepareNativeRuntime } from './native-runtime.mjs';
import { makeNativeRelease } from './native-release.mjs';

const root = dirname(import.meta.dirname);
const mode = process.argv[2];
if (!['dev', 'build', 'test', 'check', 'fmt', 'clippy'].includes(mode))
  throw new Error('用法：pnpm native:<dev|build|test|check|fmt|clippy>');
const env = nodeEnvironment(process.execPath);
const isolated = join(root, '.artifacts/rust-toolchain');
if (existsSync(join(isolated, 'cargo/bin/cargo'))) {
  env.RUSTUP_HOME = join(isolated, 'rustup');
  env.CARGO_HOME = join(isolated, 'cargo');
  env.PATH = `${join(isolated, 'cargo/bin')}:${env.PATH}`;
}
env.CARGO_TARGET_DIR = join(root, '.artifacts/native-target');
const manifest = join(root, 'apps/native/src-tauri/Cargo.toml');
if (mode === 'dev' || mode === 'build') prepareNativeRuntime();
const command = mode === 'dev' || mode === 'build' ? 'pnpm' : 'cargo';
const args =
  mode === 'dev' || mode === 'build'
    ? [
        '--filter',
        '@codexconnector/native',
        'exec',
        'tauri',
        mode,
        ...(mode === 'build' ? ['--bundles', 'app'] : []),
      ]
    : mode === 'fmt'
      ? ['fmt', '--manifest-path', manifest, '--', '--check']
      : [
          mode,
          '--manifest-path',
          manifest,
          '--locked',
          ...(mode === 'clippy' ? ['--all-targets', '--', '-D', 'warnings'] : []),
        ];
const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
child.on('error', () => {
  console.error('缺少 Rust 工具链，请安装 rustup 或检查项目工具链缓存。');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  if (code === 0 && mode === 'build') {
    try {
      makeNativeRelease();
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Rust 安装包验收失败');
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
