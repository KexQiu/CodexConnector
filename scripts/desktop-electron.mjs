import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nodeEnvironment } from './node-runtime.mjs';
const root = dirname(import.meta.dirname);
const require = createRequire(join(root, 'apps/desktop/package.json'));
const electron = dirname(require.resolve('electron/package.json'));
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('首版运行环境仅支持 macOS arm64');
const { version } = JSON.parse(readFileSync(join(electron, 'package.json'), 'utf8'));
const filename = `electron-v${version}-darwin-arm64.zip`;
const cache = join(root, '.artifacts/electron-download');
mkdirSync(cache, { recursive: true });
const zip = join(cache, filename);
if (!existsSync(zip))
  execFileSync(
    '/usr/bin/curl',
    [
      '-fL',
      '--connect-timeout',
      '15',
      '--max-time',
      '300',
      '--retry',
      '2',
      '--silent',
      '--show-error',
      '-o',
      zip,
      `https://github.com/electron/electron/releases/download/v${version}/${filename}`,
    ],
    { stdio: 'inherit' },
  );
const checksums = JSON.parse(readFileSync(join(electron, 'checksums.json'), 'utf8'));
if (createHash('sha256').update(readFileSync(zip)).digest('hex') !== checksums[filename])
  throw new Error('Electron 下载校验失败，请删除不完整的 .artifacts/electron-download 下载后重试');
// Use the verified official archive; no dependency lifecycle scripts are enabled.
if (!existsSync(join(electron, 'path.txt'))) {
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, join(electron, 'dist')], { stdio: 'inherit' });
  writeFileSync(join(electron, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
}
console.log(`Electron ${version} arm64 已校验并就绪。`);
// DMG Finder aliases and extended attributes use two small native addons. Build only these,
// against the build host's Node (never against Electron or the running gateway).
let from = require;
let appDmg;
for (const name of [
  '@electron-forge/maker-dmg',
  'electron-installer-dmg',
  'appdmg',
  'ds-store',
  'macos-alias',
]) {
  from = createRequire(from.resolve(`${name}/package.json`));
  if (name === 'appdmg') appDmg = from;
}
const alias = dirname(from.resolve('macos-alias/package.json'));
for (const [directory, binary] of [
  [alias, 'volume.node'],
  [dirname(appDmg.resolve('fs-xattr/package.json')), 'xattr.node'],
]) {
  const loadable = () =>
    spawnSync(
      process.execPath,
      ['-e', 'require(process.argv[1])', join(directory, 'build/Release', binary)],
      {
        env: nodeEnvironment(process.execPath),
        timeout: 10_000,
        stdio: 'pipe',
      },
    ).status === 0;
  if (!loadable()) {
    const nodeRoot = dirname(dirname(process.execPath));
    execFileSync(
      process.execPath,
      [
        from.resolve('node-gyp/bin/node-gyp.js'),
        'rebuild',
        '--directory',
        directory,
        ...(existsSync(join(nodeRoot, 'include/node/node.h')) ? ['--nodedir', nodeRoot] : []),
      ],
      { stdio: 'inherit', env: nodeEnvironment(process.execPath) },
    );
    if (!loadable()) throw new Error(`DMG 构建模块 ${binary} 无法在当前 Node 下加载`);
  }
}
