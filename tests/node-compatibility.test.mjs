import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, it, vi } from 'vitest';
import baseline from '../src/runtime-baseline.json' with { type: 'json' };
import { inspectNode } from '../src/node-compatibility.ts';
import { nodeEnvironment, validateNode } from '../scripts/node-runtime.mjs';
import { runDoctor, doctorMessage } from '../src/cli/doctor.ts';
import { runCli } from '../src/cli/main.ts';

it.each(['22.14.0', '22.14.1', '22.20.0', '24.0.0', '24.15.0', '24.99.1'])(
  'accepts supported stable version %s without pinning the bundled version',
  (version) => {
    expect(inspectNode(version, '10').ok).toBe(true);
  },
);
it.each([
  '18.20.0',
  '20.19.0',
  '22.0.0',
  '22.13.9',
  '23.9.0',
  '25.0.0',
  '26.0.0',
  '24.0.0-rc.1',
  '24.0.0+custom',
  'v24.0.0',
  '24.0',
  '024.0.0',
  'unknown',
])('rejects unsupported or unverified version %s', (version) => {
  expect(inspectNode(version, '10').ok).toBe(false);
});
it.each(['9', '', 'invalid'])('rejects missing native API support %s', (napi) => {
  expect(inspectNode('22.14.0', napi).ok).toBe(false);
});
it('keeps the package support range and bundled pin consistent', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.engines.node).toBe(baseline.nodeSupported);
  expect(inspectNode(baseline.node, '10').ok).toBe(true);
  expect(pkg.devDependencies['@types/node'].split('.')[0]).toBe('22');
});
it('checks the real SQLite native binding on the current runtime', async () => {
  const result = await runDoctor('/does-not-exist/codexconnector-test');
  expect(result.checks.node.ok).toBe(true);
  expect(result.checks.node.actual).toBe(process.versions.node);
  expect(result.checks.sqlite.ok).toBe(true);
  expect(result.checks.sdkImports.ok).toBe(true);
});
it('does not load SQLite on an unsupported runtime and reports the required range', async () => {
  const node = Object.getOwnPropertyDescriptor(process.versions, 'node');
  const napi = Object.getOwnPropertyDescriptor(process.versions, 'napi');
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    Object.defineProperty(process.versions, 'node', { value: '22.13.0', configurable: true });
    Object.defineProperty(process.versions, 'napi', { value: '9', configurable: true });
    const result = await runDoctor('/does-not-exist/codexconnector-test');
    expect(result.status).toBe('incompatible');
    expect(result.checks.sqlite.error).toContain('未加载');
    expect(doctorMessage(result)).toContain(baseline.nodeSupported);
    expect(await runCli(['state', '--config', '/does-not-exist/config.json'])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Node 版本不兼容'));
  } finally {
    stderr.mockRestore();
    Object.defineProperty(process.versions, 'node', node);
    Object.defineProperty(process.versions, 'napi', napi);
  }
});
it('rejects a mismatched shipping runtime even when the developer runtime is supported', () => {
  expect(() => validateNode(process.execPath, '99.0.0')).toThrow('内置 Node 不匹配');
});
it('uses the selected Node for child tools without inheriting injected Node flags', () => {
  const original = {
    PATH: '/usr/bin:/bin',
    NODE_OPTIONS: '--require anything',
    NODE_PATH: '/tmp',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const env = nodeEnvironment('/a path/bin/node', original);
  expect(env.PATH).toBe('/a path/bin:/usr/bin:/bin');
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.NODE_PATH).toBeUndefined();
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(original.NODE_OPTIONS).toBeDefined();
});
