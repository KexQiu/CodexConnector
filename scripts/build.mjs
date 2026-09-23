import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(join(root, 'dist'), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);
const migrations = join(root, 'src/persistence/migrations');
if (existsSync(migrations)) {
  mkdirSync(join(root, 'dist/persistence'), { recursive: true });
  cpSync(migrations, join(root, 'dist/persistence/migrations'), { recursive: true });
}
