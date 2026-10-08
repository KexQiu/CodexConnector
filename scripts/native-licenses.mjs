import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { nodeEnvironment } from './node-runtime.mjs';

const root = dirname(import.meta.dirname);
const licenseName = /^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)(?:$|[._-])/i;

export function resolvePackage(name, from) {
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
    throw new Error(`无法解析依赖 ${name}`);
  }
}

export function verifySourceArchive(path, checksum) {
  if (
    !/^[a-f0-9]{64}$/.test(checksum ?? '') ||
    createHash('sha256').update(readFileSync(path)).digest('hex') !== checksum
  )
    throw new Error('第三方源码归档与 Cargo.lock 校验和不一致');
}

/** License collection uses installed, locked dependencies; missing texts fail the build. */
export function prepareNativeLicenses(runtime) {
  const destination = join(runtime, 'licenses');
  mkdirSync(destination, { recursive: true });
  const overrides = JSON.parse(
    readFileSync(join(root, 'third_party/license-overrides.json'), 'utf8'),
  );
  const entries = [];
  const portable = (path) => relative(runtime, path).split(sep).join('/');
  const safeName = (name) => name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const copyTexts = (ecosystem, name, version, source, fallback = []) => {
    const files = readdirSync(source, { withFileTypes: true })
      .filter((item) => item.isFile() && licenseName.test(item.name))
      .map((item) => ({ file: join(source, item.name), name: item.name }));
    if (!files.length)
      files.push(
        ...fallback.map((item) => ({
          file: join(root, item.file),
          name: item.file.split('/').at(-1),
        })),
      );
    if (!files.length) throw new Error(`缺少原始许可证：${ecosystem} ${name}@${version}`);
    const dir = join(destination, ecosystem, `${safeName(name)}-${version}`);
    mkdirSync(dir, { recursive: true });
    return files.map(({ file, name: filename }) => {
      if (!readFileSync(file, 'utf8').trim()) throw new Error(`许可证为空：${name}@${version}`);
      const target = join(dir, filename);
      cpSync(file, target);
      return portable(target);
    });
  };

  const visited = new Set();
  const npm = (name, from) => {
    const source = resolvePackage(name, from);
    if (visited.has(source)) return;
    visited.add(source);
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    const texts = copyTexts(
      'npm',
      pkg.name,
      pkg.version,
      source,
      overrides.npm[`${pkg.name}@${pkg.version}`],
    );
    entries.push({
      ecosystem: 'npm',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? pkg.licenses,
      source: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`,
      licenseFiles: texts,
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) npm(dep, source);
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      try {
        resolvePackage(dep, source);
      } catch {
        continue;
      }
      npm(dep, source);
    }
  };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies)) npm(name, root);
  for (const name of ['react', 'react-dom']) npm(name, join(root, 'apps/desktop'));
  npm('@tauri-apps/api', join(root, 'apps/native'));
  const qr = join(destination, 'qrcode-generator.txt');
  cpSync(join(root, 'apps/desktop/assets/qrcode-generator.LICENSE'), qr);
  entries.push({
    ecosystem: 'npm',
    name: 'qrcode-generator',
    version: '2.0.4',
    license: 'MIT',
    source: 'https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz',
    licenseFiles: [portable(qr)],
  });

  const env = nodeEnvironment(process.execPath);
  const isolated = join(root, '.artifacts/rust-toolchain');
  if (existsSync(join(isolated, 'cargo/bin/cargo'))) {
    env.RUSTUP_HOME = join(isolated, 'rustup');
    env.CARGO_HOME = join(isolated, 'cargo');
    env.PATH = `${join(isolated, 'cargo/bin')}:${env.PATH}`;
  }
  const manifest = join(root, 'apps/native/src-tauri/Cargo.toml');
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        manifest,
        '--locked',
        '--format-version',
        '1',
        '--filter-platform',
        'aarch64-apple-darwin',
      ],
      { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const checksums = new Map();
  for (const block of readFileSync(join(dirname(manifest), 'Cargo.lock'), 'utf8').split(
    '[[package]]',
  )) {
    const field = (name) => block.match(new RegExp(`^${name} = "([^"\\n]+)"$`, 'm'))?.[1];
    checksums.set(`${field('name')}@${field('version')}`, field('checksum'));
  }
  const resolved = new Set(metadata.resolve.nodes.map((node) => node.id));
  for (const crate of metadata.packages.filter((p) => p.source && resolved.has(p.id))) {
    if (!crate.source.startsWith('registry+')) throw new Error(`不支持的源码来源：${crate.name}`);
    const source = dirname(crate.manifest_path);
    const texts = copyTexts(
      'rust',
      crate.name,
      crate.version,
      source,
      overrides.rust[`${crate.name}@${crate.version}`],
    );
    const entry = {
      ecosystem: 'rust',
      name: crate.name,
      version: crate.version,
      license: crate.license,
      source: `https://crates.io/api/v1/crates/${crate.name}/${crate.version}/download`,
      licenseFiles: texts,
    };
    if (crate.license?.includes('MPL-2.0')) {
      const cache = join(dirname(dirname(dirname(source))), 'cache', source.split(sep).at(-2));
      const filename = `${crate.name}-${crate.version}.crate`;
      const archive = join(cache, filename);
      const checksum = checksums.get(`${crate.name}@${crate.version}`);
      verifySourceArchive(archive, checksum);
      const target = join(destination, 'sources', filename);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(archive, target);
      entry.sourceArchive = portable(target);
      entry.sourceSha256 = checksum;
    }
    entries.push(entry);
  }

  cpSync(join(root, 'LICENSE'), join(runtime, 'LICENSE'));
  cpSync(join(root, 'NOTICE'), join(runtime, 'NOTICE'));
  cpSync(join(root, 'third_party/openai-codex'), join(destination, 'openai-codex'), {
    recursive: true,
  });
  entries.sort((a, b) =>
    `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`),
  );
  writeFileSync(join(destination, 'inventory.json'), JSON.stringify(entries, null, 2) + '\n');
  const header = [
    'CodexConnector — third-party software notices',
    '',
    'Original project code: MIT; see LICENSE and NOTICE.',
    'OpenAI Codex generated protocol: Apache-2.0; see licenses/openai-codex/LICENSE and NOTICE.',
    'Node.js and its bundled components: see NODE-LICENSE.',
    'The following list conservatively includes locked Rust build dependencies.',
    'Third-party components retain their own licenses; none are relicensed under MIT.',
    'Unmodified MPL-2.0 source archives are supplied in licenses/sources and verified against Cargo.lock.',
    'All paths below are relative to Contents/Resources/runtime inside the application.',
    '',
  ];
  for (const entry of entries) {
    header.push(
      `${entry.ecosystem}: ${entry.name}@${entry.version}`,
      `License: ${typeof entry.license === 'string' ? entry.license : JSON.stringify(entry.license)}`,
      `Source: ${entry.source}`,
    );
    if (entry.sourceArchive)
      header.push(
        `Included source: ${entry.sourceArchive}`,
        `Source SHA-256: ${entry.sourceSha256}`,
      );
    for (const file of entry.licenseFiles)
      header.push(`--- ${file} ---`, readFileSync(join(runtime, file), 'utf8'));
    header.push('');
  }
  // Include these texts in the standalone release notice too, not just links into the App.
  header.push(
    '--- Project NOTICE ---',
    readFileSync(join(runtime, 'NOTICE'), 'utf8'),
    '--- OpenAI Codex LICENSE ---',
    readFileSync(join(destination, 'openai-codex/LICENSE'), 'utf8'),
    '--- OpenAI Codex NOTICE ---',
    readFileSync(join(destination, 'openai-codex/NOTICE'), 'utf8'),
    '--- Node.js LICENSE and bundled notices ---',
    readFileSync(join(runtime, 'NODE-LICENSE'), 'utf8'),
  );
  writeFileSync(join(runtime, 'THIRD_PARTY_NOTICES.txt'), header.join('\n') + '\n');
  return {
    packages: entries.length,
    sourceArchives: entries.filter((e) => e.sourceArchive).length,
  };
}
