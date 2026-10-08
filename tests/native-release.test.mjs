import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertMacOSMinimum, publicReleaseMetadata } from '../scripts/native-release.mjs';
import { verifySourceArchive } from '../scripts/native-licenses.mjs';
import { copyProductionDependencies } from '../scripts/native-runtime.mjs';

describe('native release distribution boundary', () => {
  it('rejects a minimum OS declaration below a bundled binary requirement', () => {
    expect(() => assertMacOSMinimum('13.0', '13.5')).toThrow(/声明过低/);
    expect(() => assertMacOSMinimum('13.5', '13.5.1')).toThrow(/声明过低/);
    expect(() => assertMacOSMinimum('13.5', '13.5.0')).not.toThrow();
    expect(() => assertMacOSMinimum('14.0', '13.5')).not.toThrow();
    expect(() => assertMacOSMinimum('13.5', undefined)).toThrow(/无法校验/);
  });
  it('keeps dependency runtime and notices without development or local configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-production-copy-'));
    const dependency = join(dir, 'node_modules/fixture-dependency');
    const output = join(dir, 'output');
    try {
      mkdirSync(dependency, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.cjs' }),
      );
      writeFileSync(join(dependency, 'index.cjs'), 'module.exports = "fixture-runtime";');
      writeFileSync(join(dependency, 'LICENSE'), 'MIT license fixture');
      for (const path of [
        '.claude/settings.local.json',
        '.github/workflows/test.yml',
        '.husky/pre-commit',
        '.env',
        '.env.local',
        '.npmrc',
      ]) {
        const file = join(dependency, path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, 'development fixture');
      }
      copyProductionDependencies(dir, output, ['fixture-dependency']);
      const packaged = join(output, 'node_modules/fixture-dependency');
      expect(readFileSync(join(packaged, 'index.cjs'), 'utf8')).toBe(
        'module.exports = "fixture-runtime";',
      );
      expect(readFileSync(join(packaged, 'LICENSE'), 'utf8')).toBe('MIT license fixture');
      for (const path of ['.claude', '.github', '.husky', '.env', '.env.local', '.npmrc'])
        expect(existsSync(join(packaged, path))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('exports only public provenance, filenames and fixed checks', () => {
    const secret = 'PRIVATE_TEST_VALUE';
    const report = {
      version: '0.2.0-alpha.2',
      implementation: 'Rust/Tauri host, transitional Node gateway',
      source: { commit: 'a'.repeat(40), dirty: false, localPath: '/Users/private/repo' },
      node: '24.15.0',
      licenses: { packages: 300, sourceArchives: 5 },
      appKiB: 160000,
      dmg: { file: '/Users/private/output/app.dmg', bytes: 100, sha256: 'b'.repeat(64) },
      smoke: {
        renderer: true,
        assetsLoaded: true,
        errorsVisible: true,
        ipc: true,
        configured: false,
        feishuConnected: false,
        secret,
      },
      installedSmoke: {
        renderer: true,
        assetsLoaded: true,
        ipc: true,
        localPath: '/private/tmp/install',
      },
    };
    const result = publicReleaseMetadata(report);
    expect(result.dmg.file).toBe('app.dmg');
    expect(result.source).toEqual({ commit: 'a'.repeat(40), dirty: false });
    expect(result.signing).toEqual({ type: 'ad-hoc', notarized: false });
    expect(Object.values(result.checks).every((value) => value === true)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/\/Users|\/private|PRIVATE_TEST_VALUE/);
  });

  it('does not turn failed or missing checks into success', () => {
    const result = publicReleaseMetadata({
      version: 'test',
      source: { commit: 'a'.repeat(40), dirty: true },
      dmg: { file: 'app.dmg', bytes: 100, sha256: 'b'.repeat(64) },
      smoke: { renderer: false, configured: true, feishuConnected: false },
      installedSmoke: {},
    });
    expect(result.source.dirty).toBe(true);
    expect(Object.values(result.checks).every((value) => value === false)).toBe(true);
  });

  it('only accepts the exact source archive recorded by the lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-license-'));
    const archive = join(dir, 'fixture.crate');
    const bytes = Buffer.from('unmodified source fixture');
    const digest = createHash('sha256').update(bytes).digest('hex');
    try {
      writeFileSync(archive, bytes);
      expect(() => verifySourceArchive(archive, digest)).not.toThrow();
      writeFileSync(archive, 'tampered source fixture');
      expect(() => verifySourceArchive(archive, digest)).toThrow(/校验和/);
      expect(() => verifySourceArchive(archive, undefined)).toThrow(/校验和/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
