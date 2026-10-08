import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { verifyPackagedDesktop } from './desktop-smoke.mjs';

const root = dirname(import.meta.dirname);
const desktop = join(root, 'apps/desktop');
const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const stamp = new Date()
  .toISOString()
  .replaceAll(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const output = join(root, '.artifacts/releases', manifest.version, stamp);
mkdirSync(output, { recursive: true });
const env = { ...process.env, CONNECTOR_DESKTOP_BUILD_ROOT: output };
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, env, stdio: 'inherit' });
console.log(`内部测试包独立输出：${output}`);
run(process.execPath, ['scripts/desktop-build.mjs']);

// Forge packages only this staging directory; existing dist/runtime/out stay untouched.
const staging = join(output, 'package');
mkdirSync(staging);
cpSync(join(output, 'app'), join(staging, 'dist'), { recursive: true });
writeFileSync(
  join(staging, 'package.json'),
  JSON.stringify({ ...manifest, config: { forge: join(desktop, 'forge.config.cjs') } }, null, 2),
);
symlinkSync(join(desktop, 'node_modules'), join(staging, 'node_modules'), 'dir');
run(join(desktop, 'node_modules/.bin/electron-forge'), [
  'make',
  staging,
  '--platform',
  'darwin',
  '--arch',
  'arm64',
]);

function artifacts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? artifacts(path) : /\.(dmg|zip)$/.test(entry.name) ? [path] : [];
  });
}
const files = artifacts(join(output, 'out/make'));
if (!files.some((file) => file.endsWith('.dmg')) || !files.some((file) => file.endsWith('.zip')))
  throw new Error('安装包不完整：需要 DMG 和 ZIP');
const app = join(output, 'out/CodexConnector-darwin-arm64/CodexConnector.app');
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const launchCheck = verifyPackagedDesktop(app);
if (launchCheck.version !== manifest.version) throw new Error('安装包启动版本不匹配');
for (const file of files) if (file.endsWith('.dmg')) run('/usr/bin/hdiutil', ['verify', file]);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const release = {
  version: manifest.version,
  builtAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeModified: !!execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  platform: 'darwin',
  arch: 'arm64',
  signing: 'ad-hoc',
  notarized: false,
  launchCheck,
  artifacts: files.map((file) => ({
    path: relative(output, file),
    bytes: statSync(file).size,
    sha256: sha256(file),
  })),
};
writeFileSync(join(output, 'release.json'), JSON.stringify(release, null, 2) + '\n');
writeFileSync(
  join(output, 'SHA256SUMS'),
  release.artifacts.map((file) => `${file.sha256}  ${file.path}\n`).join(''),
);
console.log(`安装包与校验清单已生成：${output}`);
