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
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { nodeEnvironment } from './node-runtime.mjs';
import { verifySourceArchive } from './native-licenses.mjs';

const root = dirname(import.meta.dirname);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const minimumMacOS = JSON.parse(
  readFileSync(join(root, 'apps/native/src-tauri/tauri.conf.json'), 'utf8'),
).bundle.macOS.minimumSystemVersion;

export function assertMacOSMinimum(configured, required) {
  const parse = (value) => {
    if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(value))
      throw new Error('无法校验 macOS 最低版本');
    return [...value.split('.').map(Number), 0, 0].slice(0, 3);
  };
  const allowed = parse(configured),
    needed = parse(required);
  for (let index = 0; index < 3; index++) {
    if (allowed[index] > needed[index]) return;
    if (allowed[index] < needed[index])
      throw new Error(`随包程序需要 macOS ${required}，App 最低版本 ${configured} 声明过低`);
  }
}

/** Public metadata must not include local build paths or arbitrary smoke-test output. */
export function publicReleaseMetadata(report) {
  return {
    version: report.version,
    platform: 'darwin',
    arch: 'arm64',
    minimumMacOS,
    implementation: report.implementation,
    source: { commit: report.source.commit, dirty: report.source.dirty },
    runtime: { node: report.node },
    signing: { type: 'ad-hoc', notarized: false },
    dmg: { file: basename(report.dmg.file), bytes: report.dmg.bytes, sha256: report.dmg.sha256 },
    appKiB: report.appKiB,
    licenses: {
      packages: report.licenses?.packages ?? 0,
      sourceArchives: report.licenses?.sourceArchives ?? 0,
    },
    checks: {
      renderer: report.smoke.renderer === true,
      assetsLoaded: report.smoke.assetsLoaded === true,
      errorsVisible: report.smoke.errorsVisible === true,
      ipc: report.smoke.ipc === true,
      isolated: report.smoke.configured === false && report.smoke.feishuConnected === false,
      installedRenderer: report.installedSmoke.renderer === true,
      installedAssetsLoaded: report.installedSmoke.assetsLoaded === true,
      installedIpc: report.installedSmoke.ipc === true,
    },
  };
}
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
    const runtimeInfo = JSON.parse(readFileSync(join(runtime, 'runtime.json'), 'utf8'));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (runtimeInfo.sourceCommit !== commit)
      throw new Error('运行时源提交与当前提交不一致，请重新执行完整原生构建');
    const inventory = JSON.parse(readFileSync(join(runtime, 'licenses/inventory.json'), 'utf8'));
    const sourceEntries = inventory.filter(
      (entry) => entry.ecosystem === 'rust' && entry.license?.includes('MPL-2.0'),
    );
    if (
      runtimeInfo.licenses?.packages !== inventory.length ||
      runtimeInfo.licenses?.sourceArchives !== sourceEntries.length ||
      !inventory.length
    )
      throw new Error('缺少第三方许可或源码归档，请核对锁定依赖及许可收集结果');
    for (const entry of sourceEntries)
      verifySourceArchive(join(runtime, entry.sourceArchive), entry.sourceSha256);
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
    const addons = walk(runtime).filter((file) => file.endsWith('.node'));
    for (const path of [
      join(appPath, 'Contents/MacOS/codexconnector-native'),
      join(runtime, 'node'),
      ...addons,
    ]) {
      const commands = execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8' });
      const required =
        commands.match(/\bminos\s+(\d+\.\d+(?:\.\d+)?)/)?.[1] ??
        commands.match(/LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+(\d+\.\d+(?:\.\d+)?)/)?.[1];
      assertMacOSMinimum(minimumMacOS, required);
    }
    for (const path of addons) sign(path);
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
    const digest = sha256(dmg);
    const report = {
      version: manifest.version,
      implementation: 'Rust/Tauri host, transitional Node gateway',
      source: {
        commit,
        dirty:
          runtimeInfo.sourceDirty ||
          Boolean(
            execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
          ),
      },
      node: runtimeInfo.node,
      licenses: runtimeInfo.licenses,
      smoke,
      installedSmoke,
      dmg: { file: dmg, bytes: statSync(dmg).size, sha256: digest },
      appKiB: Number(
        execFileSync('/usr/bin/du', ['-sk', appPath], { encoding: 'utf8' }).split(/\s+/)[0],
      ),
    };
    writeFileSync(join(destination, 'release.json'), JSON.stringify(report, null, 2) + '\n');
    const publicFiles = [basename(dmg), 'release-metadata.json', 'THIRD_PARTY_NOTICES.txt'];
    writeFileSync(
      join(destination, 'release-metadata.json'),
      JSON.stringify(publicReleaseMetadata(report), null, 2) + '\n',
    );
    cpSync(join(runtime, 'THIRD_PARTY_NOTICES.txt'), join(destination, 'THIRD_PARTY_NOTICES.txt'));
    writeFileSync(
      join(destination, 'SHA256SUMS'),
      publicFiles.map((file) => `${sha256(join(destination, file))}  ${file}\n`).join(''),
    );
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
