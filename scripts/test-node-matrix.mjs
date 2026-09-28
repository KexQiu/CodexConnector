import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureNode, nodeEnvironment } from './node-runtime.mjs';

const root = dirname(import.meta.dirname);
const baseline = JSON.parse(readFileSync(join(root, 'src/runtime-baseline.json'), 'utf8'));
const versions = process.argv.slice(2);
if (!versions.length) versions.push('22.14.0', '24.0.0', baseline.node);
for (const version of [...new Set(versions)]) {
  const runtime = ensureNode(version);
  const env = nodeEnvironment(runtime.binary);
  const run = (args) => execFileSync(runtime.binary, args, { cwd: root, env, stdio: 'inherit' });
  console.log(`\n验证 Node ${version} / Node-API ${runtime.napi}`);
  run([
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    "import {inspectNode,nodeCompatibilityMessage} from './src/node-compatibility.ts'; const check=inspectNode(); if(!check.ok)throw new Error(nodeCompatibilityMessage(check));",
  ]);
  run(['node_modules/typescript/bin/tsc', '--noEmit']);
  run(['node_modules/typescript/bin/tsc', '-p', 'apps/desktop/tsconfig.json', '--noEmit']);
  run(['node_modules/vitest/vitest.mjs', 'run']);
  run(['--import', 'tsx', 'scripts/check-sqlite.mjs']);
  const output = join(root, '.artifacts/node-matrix', version, 'backend');
  mkdirSync(output, { recursive: true });
  run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', output]);
  cpSync(join(root, 'src/persistence/migrations'), join(output, 'persistence/migrations'), {
    recursive: true,
  });
  run([join(output, 'index.js'), '--help']);
  console.log(`Node ${version} 验证通过；根 dist 未改动。`);
}
