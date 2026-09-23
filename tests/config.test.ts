import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import example from '../config/config.example.json' with { type: 'json' };
import { gatewayConfigSchema, loadConfig } from '../src/config/schema.js';

describe('configuration boundary', () => {
  it('accepts the non-secret example', () => {
    expect(gatewayConfigSchema.safeParse(example).success).toBe(true);
  });
  it.each(['ws://0.0.0.0:4500', 'ws://example.com:4500', 'unix://relative.sock'])(
    'rejects unapproved RPC endpoint %s',
    (endpoint) => {
      expect(
        gatewayConfigSchema.safeParse({ ...example, codex: { ...example.codex, endpoint } })
          .success,
      ).toBe(false);
    },
  );
  it('rejects relaxed approval and duplicate project keys', () => {
    expect(
      gatewayConfigSchema.safeParse({
        ...example,
        codex: { ...example.codex, approvalPolicy: 'never' },
      }).success,
    ).toBe(false);
    expect(
      gatewayConfigSchema.safeParse({
        ...example,
        projects: [...example.projects, ...example.projects],
      }).success,
    ).toBe(false);
  });
  it('does not leak invalid input in error messages', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codexconnector-config-'));
    try {
      const path = join(directory, 'config.json');
      await writeFile(path, '{"secret":"SHOULD_NOT_APPEAR"');
      await expect(loadConfig(path)).rejects.toThrow('配置文件不是有效 JSON');
      await writeFile(
        path,
        JSON.stringify({ ...example, codex: { ...example.codex, sandbox: 'SHOULD_NOT_APPEAR' } }),
      );
      await expect(loadConfig(path)).rejects.toThrow('codex.sandbox [invalid_value]');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
