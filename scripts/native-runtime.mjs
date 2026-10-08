import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledNode, nodeEnvironment } from './node-runtime.mjs';

const root = dirname(import.meta.dirname);
function resolvePackage(name, from) {
  const require = createRequire(join(from, 'package.json'));
  try {
    return dirname(realpathSync(require.resolve(`${name}/package.json`)));
  } catch {
    let dir = dirname(realpathSync(require.resolve(name)));
    while (dir !== dirname(dir)) {
      if (
        existsSync(join(dir, 'package.json')) &&
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === name
      )
        return dir;
      dir = dirname(dir);
    }
    throw new Error(`无法打包生产依赖 ${name}`);
  }
}

/** Hoist compatible production versions once. Conflicting versions retain a nested copy. */
export function copyProductionDependencies(from, into, dependencies) {
  const primary = new Map();
  const copied = new Set();
  const copy = (name, parent, destinationParent) => {
    const source = resolvePackage(name, parent);
    const primarySource = primary.get(name);
    if (primarySource === source) return;
    const destination = join(primarySource ? destinationParent : into, 'node_modules', name);
    if (!primarySource) primary.set(name, source);
    if (copied.has(destination)) return;
    copied.add(destination);
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (path) => {
        const parts = relative(source, path).split(sep);
        if (parts.includes('node_modules')) return false;
        if (name === 'better-sqlite3' && parts[0] === 'prebuilds' && parts.length > 1)
          return parts[1] === `${process.platform}-${process.arch}.node`;
        // Declarations and SQLite build intermediates are not loaded by the runtime.
        if (path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.map'))
          return false;
        if (
          name === 'better-sqlite3' &&
          (parts[0] === 'deps' ||
            parts[0] === 'src' ||
            parts.includes('obj') ||
            parts.includes('obj.target'))
        )
          return false;
        return true;
      },
    });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const dep of Object.keys(manifest.dependencies ?? {})) copy(dep, source, destination);
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      try {
        resolvePackage(dep, source);
      } catch {
        continue;
      }
      copy(dep, source, destination);
    }
  };
  for (const name of dependencies) copy(name, from, into);
}

export function prepareNativeRuntime() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('首版 Rust 构建需要 macOS arm64');
  const runtime = bundledNode();
  const target = join(root, '.artifacts/native-runtime');
  // This directory belongs only to the Rust development build, never the Electron deployment.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const backend = join(target, 'backend');
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(root, 'tsconfig.build.json'),
      '--outDir',
      backend,
      '--sourceMap',
      'false',
    ],
    { stdio: 'inherit' },
  );
  cpSync(join(root, 'src/persistence/migrations'), join(backend, 'persistence/migrations'), {
    recursive: true,
  });
  cpSync(runtime.binary, join(target, 'node'));
  chmodSync(join(target, 'node'), 0o755);
  cpSync(runtime.license, join(target, 'NODE-LICENSE'));
  writeFileSync(join(backend, 'package.json'), JSON.stringify({ type: 'module' }));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  copyProductionDependencies(root, backend, Object.keys(pkg.dependencies));
  const licenses = join(target, 'licenses');
  mkdirSync(licenses, { recursive: true });
  for (const name of ['react', 'react-dom'])
    cpSync(join(root, 'apps/desktop/node_modules', name, 'LICENSE'), join(licenses, `${name}.txt`));
  cpSync(
    join(root, 'apps/desktop/assets/qrcode-generator.LICENSE'),
    join(licenses, 'qrcode-generator.txt'),
  );
  execFileSync(
    join(target, 'node'),
    [
      '--input-type=module',
      '-e',
      "import Database from 'better-sqlite3'; import {WSClient} from '@larksuiteoapi/node-sdk'; import pino from 'pino'; import WebSocket from 'ws'; import {z} from 'zod'; const db=new Database(':memory:');db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');db.prepare('INSERT INTO probe VALUES (?)').run(1);if(db.prepare('SELECT id FROM probe').pluck().get()!==1 || !WSClient || !pino || !WebSocket || !z)process.exit(1);db.close();",
    ],
    { cwd: backend, stdio: 'inherit', env: nodeEnvironment(runtime.binary) },
  );
  writeFileSync(
    join(target, 'runtime.json'),
    JSON.stringify(
      {
        host: 'rust/tauri',
        gateway: 'node-transition',
        node: runtime.version,
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    ),
  );
  console.log('Rust 独立网关运行时已准备；Electron 及 CLI 产物未改动。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareNativeRuntime();
