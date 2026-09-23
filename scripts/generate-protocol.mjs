import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, 'src/runtime-baseline.json'), 'utf8'));
const binary = process.env.CODEX_BINARY ?? baseline.codexBinary;
const check = process.argv.includes('--check');
const run = (args) =>
  execFileSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
const actual = run(['--version']).trim();
if (actual !== `codex-cli ${baseline.codex}`)
  throw new Error(`Protocol baseline mismatch: expected ${baseline.codex}, got ${actual}`);

function filesUnder(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const name = join(relative, entry.name);
      return entry.isDirectory() ? filesUnder(directory, name) : [name];
    })
    .sort();
}

const scratch = mkdtempSync(join(tmpdir(), 'codexconnector-protocol-'));
try {
  const types = join(scratch, 'types');
  const schemas = join(scratch, 'schemas');
  const flags = baseline.protocolExperimental ? ['--experimental'] : [];
  run(['app-server', 'generate-ts', ...flags, '--out', types]);
  run(['app-server', 'generate-json-schema', ...flags, '--out', schemas]);
  const typeFiles = filesUnder(types);
  const hash = createHash('sha256');
  for (const name of typeFiles) {
    if (!name.endsWith('.ts')) throw new Error(`Unexpected generated file: ${name}`);
    const source = readFileSync(join(types, name), 'utf8');
    // The CLI emits extensionless imports; NodeNext requires the emitted JS extension.
    const normalized = source.replace(
      /((?:from\s*|import\(\s*)["'])(\.[^"']+)(["'])/g,
      (match, prefix, path, suffix) => {
        if (/\.[cm]?[jt]s$|\.json$/.test(path)) return match;
        const isBarrel = existsSync(join(dirname(join(types, name)), path, 'index.ts'));
        return `${prefix}${path}${isBarrel ? '/index' : ''}.js${suffix}`;
      },
    );
    writeFileSync(join(types, name), normalized);
    hash.update(name).update('\0').update(normalized).update('\0');
  }
  const schema = readFileSync(join(schemas, 'codex_app_server_protocol.schemas.json'));
  const manifest = {
    codexVersion: baseline.codex,
    experimental: baseline.protocolExperimental,
    commands: [
      'codex app-server generate-ts --experimental --out <temporary directory>',
      'codex app-server generate-json-schema --experimental --out <temporary directory>',
    ],
    postprocess:
      'Resolve relative TypeScript imports/exports to .js or /index.js for NodeNext. No field changes.',
    typeFileCount: typeFiles.length,
    typesSha256: hash.digest('hex'),
    schemaSha256: createHash('sha256').update(schema).digest('hex'),
  };
  writeFileSync(join(types, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const destination = join(root, 'src/codex/generated');
  const schemaPath = join(root, 'schemas/codex', baseline.codex, 'protocol.schema.json');
  if (check) {
    const expected = filesUnder(types);
    if (
      !existsSync(destination) ||
      JSON.stringify(filesUnder(destination)) !== JSON.stringify(expected)
    )
      throw new Error('Generated protocol file inventory differs; run pnpm protocol:generate');
    for (const name of expected) {
      if (!readFileSync(join(types, name)).equals(readFileSync(join(destination, name))))
        throw new Error(`Generated protocol differs: ${name}`);
    }
    if (!existsSync(schemaPath) || !schema.equals(readFileSync(schemaPath)))
      throw new Error('Generated JSON Schema differs');
  } else {
    rmSync(destination, { recursive: true, force: true });
    cpSync(types, destination, { recursive: true });
    mkdirSync(dirname(schemaPath), { recursive: true });
    writeFileSync(schemaPath, schema);
  }
  console.log(JSON.stringify({ check, ...manifest }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
