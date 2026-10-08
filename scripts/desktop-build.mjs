import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { bundledNode, nodeEnvironment } from './node-runtime.mjs';

const root = dirname(import.meta.dirname);
const baseline = JSON.parse(readFileSync(join(root, 'src/runtime-baseline.json'), 'utf8'));
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('首版构建需要 macOS arm64');
// Resolve before touching existing output. The developer's Node is not the shipped runtime.
const runtime = bundledNode();
const isolatedRoot = process.env.CONNECTOR_DESKTOP_BUILD_ROOT
  ? resolve(process.env.CONNECTOR_DESKTOP_BUILD_ROOT)
  : null;
if (
  isolatedRoot &&
  (!isolatedRoot.startsWith(join(root, '.artifacts') + sep) ||
    isolatedRoot === join(root, '.artifacts/desktop-runtime'))
)
  throw new Error('独立构建必须使用项目 .artifacts 下的专用子目录');
const target = isolatedRoot
  ? join(isolatedRoot, 'desktop-runtime')
  : join(root, '.artifacts/desktop-runtime');
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
  ],
  { stdio: 'inherit' },
);
cpSync(join(root, 'src/persistence/migrations'), join(backend, 'persistence/migrations'), {
  recursive: true,
});
cpSync(runtime.binary, join(target, 'node'));
chmodSync(join(target, 'node'), 0o755);
cpSync(runtime.license, join(target, 'NODE-LICENSE'));
const licenses = join(target, 'licenses');
mkdirSync(licenses, { recursive: true });
for (const name of ['react', 'react-dom'])
  cpSync(join(root, 'apps/desktop/node_modules', name, 'LICENSE'), join(licenses, `${name}.txt`));
cpSync(
  join(root, 'apps/desktop/assets/qrcode-generator.LICENSE'),
  join(licenses, 'qrcode-generator.txt'),
);
writeFileSync(join(backend, 'package.json'), JSON.stringify({ type: 'module' }));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
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
    throw new Error(`无法打包依赖 ${name}`);
  }
}
function copyDependency(name, from, into, ancestors = new Set()) {
  const source = resolvePackage(name, from);
  if (ancestors.has(source)) return;
  const destination = join(into, 'node_modules', name);
  if (existsSync(destination)) return;
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => !relative(source, path).split(sep).includes('node_modules'),
  });
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const visited = new Set([...ancestors, source]);
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyDependency(dependency, source, destination, visited);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try {
      resolvePackage(dependency, source);
    } catch {
      continue;
    }
    copyDependency(dependency, source, destination, visited);
  }
}
for (const name of Object.keys(pkg.dependencies)) copyDependency(name, root, backend);
execFileSync(
  join(target, 'node'),
  [
    '--input-type=module',
    '-e',
    "import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)'); db.transaction(()=>db.prepare('INSERT INTO probe VALUES (?)').run(1))(); if(db.prepare('SELECT id FROM probe').pluck().get()!==1)process.exit(1); db.close();",
  ],
  { cwd: backend, stdio: 'inherit', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } },
);
writeFileSync(
  join(target, 'runtime.json'),
  JSON.stringify(
    {
      node: runtime.version,
      nodeSupported: baseline.nodeSupported,
      buildNode: process.versions.node,
      napi: runtime.napi,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ),
);
if (isolatedRoot) {
  const appOutput = join(isolatedRoot, 'app');
  for (const args of [
    ['build', '--outDir', join(appOutput, 'ui')],
    ['build', '--config', 'vite.main.config.ts', '--outDir', appOutput],
  ])
    execFileSync('pnpm', ['exec', 'vite', ...args], {
      cwd: join(root, 'apps/desktop'),
      stdio: 'inherit',
      env: nodeEnvironment(process.execPath),
    });
  writeFileSync(
    join(appOutput, 'package.json'),
    JSON.stringify({
      name: 'codexconnector-internal-test',
      version: JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version,
      main: 'main.cjs',
    }),
  );
} else {
  execFileSync('pnpm', ['--filter', '@codexconnector/desktop', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: nodeEnvironment(process.execPath),
  });
}
console.log(
  isolatedRoot ? '独立桌面构建完成；现有运行产物未改动。' : '桌面产物已生成；现有 dist 未改动。',
);
