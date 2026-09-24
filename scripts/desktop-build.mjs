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
import { dirname, join, relative, sep } from 'node:path';

const root = dirname(import.meta.dirname);
const baseline = JSON.parse(readFileSync(join(root, 'src/runtime-baseline.json'), 'utf8'));
if (
  process.platform !== 'darwin' ||
  process.arch !== 'arm64' ||
  process.versions.node !== baseline.node
)
  throw new Error(`首版构建需要 macOS arm64 / Node ${baseline.node}`);
const target = join(root, '.artifacts/desktop-runtime');
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
cpSync(process.execPath, join(target, 'node'));
chmodSync(join(target, 'node'), 0o755);
cpSync(join(dirname(dirname(process.execPath)), 'LICENSE'), join(target, 'NODE-LICENSE'));
const licenses = join(target, 'licenses');
mkdirSync(licenses, { recursive: true });
for (const name of ['react', 'react-dom'])
  cpSync(join(root, 'apps/desktop/node_modules', name, 'LICENSE'), join(licenses, `${name}.txt`));
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
    "import Database from 'better-sqlite3'; const db=new Database(':memory:'); if(db.prepare('SELECT 1').pluck().get()!==1)process.exit(1); db.close();",
  ],
  { cwd: backend, stdio: 'inherit', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } },
);
writeFileSync(
  join(target, 'runtime.json'),
  JSON.stringify({ node: baseline.node, platform: process.platform, arch: process.arch }, null, 2),
);
execFileSync('pnpm', ['--filter', '@codexconnector/desktop', 'build'], {
  cwd: root,
  stdio: 'inherit',
});
console.log('桌面产物已生成；现有 dist 未改动。');
