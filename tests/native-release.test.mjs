import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicReleaseMetadata } from '../scripts/native-release.mjs';
import { verifySourceArchive } from '../scripts/native-licenses.mjs';

describe('native release distribution boundary', () => {
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
