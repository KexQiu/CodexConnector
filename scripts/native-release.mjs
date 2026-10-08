import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  mkdirSync,
  cpSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { nodeEnvironment } from './node-runtime.mjs';

const root = dirname(import.meta.dirname);
export function verifyNativeApp(appPath) {
  // macOS /var and /tmp aliases are symlinks; Tauri intentionally rejects linked executables.
  const binary = join(realpathSync(appPath), 'Contents/MacOS/codexconnector-native');
  const output = execFileSync(binary, ['--connector-smoke-test'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: nodeEnvironment(process.execPath),
  });
  const line = output.split('\n').find((line) => line.startsWith('CONNECTOR_NATIVE_SMOKE '));
  if (!line) throw new Error('Rust App 未通过实际窗口与 IPC 启动检查');
  const value = JSON.parse(line.slice('CONNECTOR_NATIVE_SMOKE '.length));
  if (
    !value.renderer ||
    !value.assetsLoaded ||
    !value.errorsVisible ||
    !value.ipc ||
    value.configured ||
    value.phase !== 'stopped' ||
    value.feishuConnected
  )
    throw new Error('Rust App 启动检查没有使用隔离档案');
  return value;
}
export function verifyDmgInstall(dmg) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cc-native-install-')));
  const mount = join(temporary, 'mount');
  mkdirSync(mount);
  let attached = false;
  try {
    execFileSync(
      '/usr/bin/hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg],
      { stdio: 'pipe' },
    );
    attached = true;
    const destination = join(temporary, '中文 空格 安装', 'CodexConnector Rust.app');
    cpSync(join(mount, 'CodexConnector Rust.app'), destination, { recursive: true });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination], {
      stdio: 'inherit',
    });
    return verifyNativeApp(destination);
  } finally {
    if (attached) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
    rmSync(temporary, { recursive: true, force: true });
  }
}
export function makeNativeRelease() {
  const manifest = JSON.parse(readFileSync(join(root, 'apps/native/package.json'), 'utf8'));
  const source = join(
    root,
    '.artifacts/native-target/release/bundle/macos/CodexConnector Rust.app',
  );
  if (!existsSync(source)) throw new Error('缺少 Rust App 构建结果');
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const destination = join(root, '.artifacts/native-releases', manifest.version, stamp);
  mkdirSync(destination, { recursive: true });
  const appPath = join(destination, 'CodexConnector Rust.app');
  cpSync(source, appPath, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), 'cc-native-package-'));
  try {
    const entitlements = join(temporary, 'node-entitlements.plist');
    writeFileSync(
      entitlements,
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
    );
    const runtime = join(appPath, 'Contents/Resources/runtime');
    const sign = (path, extra = []) =>
      execFileSync(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--timestamp=none', ...extra, path],
        { stdio: 'inherit' },
      );
    const walk = (path) =>
      readdirSync(path, { withFileTypes: true }).flatMap((item) =>
        item.isDirectory() ? walk(join(path, item.name)) : [join(path, item.name)],
      );
    for (const path of walk(runtime).filter((file) => file.endsWith('.node'))) sign(path);
    sign(join(runtime, 'node'), ['--options', 'runtime', '--entitlements', entitlements]);
    sign(appPath, ['--options', 'runtime']);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'inherit',
    });
    const smoke = verifyNativeApp(appPath);
    const staging = join(temporary, 'image');
    mkdirSync(staging);
    cpSync(appPath, join(staging, 'CodexConnector Rust.app'), { recursive: true });
    symlinkSync('/Applications', join(staging, 'Applications'));
    const dmg = join(destination, `CodexConnector-Rust-${manifest.version}-arm64.dmg`);
    execFileSync(
      '/usr/bin/hdiutil',
      ['create', '-volname', 'CodexConnector Rust', '-srcfolder', staging, '-format', 'ULFO', dmg],
      { stdio: 'inherit' },
    );
    execFileSync('/usr/bin/hdiutil', ['verify', dmg], { stdio: 'inherit' });
    const installedSmoke = verifyDmgInstall(dmg);
    const digest = createHash('sha256').update(readFileSync(dmg)).digest('hex');
    const report = {
      version: manifest.version,
      implementation: 'Rust/Tauri host, transitional Node gateway',
      smoke,
      installedSmoke,
      dmg: { file: dmg, bytes: statSync(dmg).size, sha256: digest },
      appKiB: Number(
        execFileSync('/usr/bin/du', ['-sk', appPath], { encoding: 'utf8' }).split(/\s+/)[0],
      ),
    };
    writeFileSync(join(destination, 'release.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
