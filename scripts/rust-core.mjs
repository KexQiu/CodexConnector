import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = dirname(import.meta.dirname);
const mode = process.argv[2];
if (!['test', 'check', 'clippy', 'fmt', 'build'].includes(mode))
  throw new Error('用法：pnpm rust:core:<test|check|clippy|fmt|build>');
const env = { ...process.env };
const isolated = join(root, '.artifacts/rust-toolchain');
if (existsSync(join(isolated, 'cargo/bin/cargo'))) {
  env.RUSTUP_HOME = join(isolated, 'rustup');
  env.CARGO_HOME = join(isolated, 'cargo');
  env.PATH = `${join(isolated, 'cargo/bin')}:${env.PATH}`;
}
env.CARGO_TARGET_DIR = join(root, '.artifacts/native-core-target');
const manifest = join(root, 'crates/gateway-core/Cargo.toml');
const args =
  mode === 'fmt'
    ? ['fmt', '--manifest-path', manifest, '--', '--check']
    : [
        mode,
        '--manifest-path',
        manifest,
        '--locked',
        ...(mode === 'clippy' ? ['--all-targets', '--', '-D', 'warnings'] : []),
      ];
const child = spawn('cargo', args, { cwd: root, env, stdio: 'inherit' });
child.on('error', () => {
  console.error('缺少 Rust 工具链，请检查 rustup 或工作区工具链缓存。');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
