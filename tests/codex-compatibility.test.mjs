import { URL } from 'node:url';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { buildContract, compareContract, clientMethods } from '../src/codex/contract.ts';
import { inspectCodex } from '../src/codex/compatibility.ts';
import { resolveCodexBinary, codexCandidates } from '../src/codex/binary.ts';
import { runDoctor, doctorMessage } from '../src/cli/doctor.ts';
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const oldSchema = read('../schemas/codex/0.155.0-alpha.9.2/protocol.schema.json');
const newSchema = read('../schemas/codex/0.158.0-alpha.2.1/protocol.schema.json');
const stableSchema = read('../schemas/codex/0.155.1/protocol.schema.json');
const profile = read('../src/codex/compatibility-profile.json');
const clone = () => JSON.parse(JSON.stringify(newSchema));
const check = (edit) => {
  const schema = clone();
  edit(schema.definitions, schema);
  return compareContract(profile, schema);
};
const directories = [];
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'cc-compat-test-'));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fakeBinary(version, schema = newSchema, mode = 'valid') {
  const root = temporary(),
    binary = join(root, 'codex');
  writeFileSync(join(root, 'schema.json'), JSON.stringify(schema));
  writeFileSync(
    join(root, 'fake.mjs'),
    `import fs from 'node:fs';import path from 'node:path';
 const args=process.argv.slice(2);
 if(args[0]==='--version')console.log(${JSON.stringify(version)});
 else if(${JSON.stringify(mode)}==='fail')process.exit(2);
 else { const out=args[args.indexOf('--out')+1];fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'codex_app_server_protocol.schemas.json'), ${JSON.stringify(mode)}==='malformed'?'invalid':fs.readFileSync(new URL('./schema.json',import.meta.url)));fs.writeFileSync(new URL('./home.txt',import.meta.url),process.env.CODEX_HOME); }
 `,
  );
  const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    binary,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'fake.mjs'))} "$@"\n`,
    { mode: 0o700 },
  );
  return { binary, root };
}
describe('Codex wire compatibility contract', () => {
  it('reproduces the checked-in profile and accepts all three captured releases', () => {
    expect(buildContract(oldSchema, '0.155.0-alpha.9.2')).toEqual(profile);
    expect(compareContract(profile, oldSchema)).toEqual([]);
    expect(compareContract(profile, newSchema)).toEqual([]);
    expect(compareContract(profile, stableSchema)).toEqual([]);
  });
  it('covers every RPC request currently sent by gateway sources', () => {
    for (const dir of ['tasks', 'projects', 'service', 'desktop']) {
      const root = new URL(`../src/${dir}/`, import.meta.url);
      for (const name of readdirSync(root).filter((n) => n.endsWith('.ts'))) {
        const text = readFileSync(new URL(name, root), 'utf8');
        for (const m of text.matchAll(/\.request\(\s*'([^']+)'/g))
          expect(Object.hasOwn(clientMethods, m[1]), `${dir}/${name}: ${m[1]}`).toBe(true);
      }
    }
  });
  it('accepts additive non-permission fields and unrelated methods', () => {
    expect(
      check((d) => {
        d.v2.ThreadStartParams.properties.futureOption = { type: 'string' };
        d.v2.Thread.properties.extraMetadata = { type: 'string' };
        d.v2.Thread.required.push('extraMetadata');
        d.ClientRequest.oneOf.push({
          type: 'object',
          properties: { method: { enum: ['future/method'] } },
          required: ['method'],
        });
      }),
    ).toEqual([]);
  });
  it('ignores removal of unused experimental fields but retains consumed fields', () => {
    expect(
      check((d) => {
        delete d.v2.ThreadStartParams.properties.daybreakEnabled;
        delete d.v2.GetAccountResponse.properties.workspaceRouting;
        delete d.v2.ThreadSettings.properties.disabledPluginIds;
      }),
    ).toEqual([]);
    expect(
      check((d) => {
        delete d.v2.ThreadStartParams.properties.runtimeWorkspaceRoots;
      }).length,
    ).toBeGreaterThan(0);
    expect(
      check((d) => {
        delete d.v2.Model.properties.model;
      }).length,
    ).toBeGreaterThan(0);
  });
  it('blocks added mandatory input, even when it is outside known properties', () => {
    expect(
      check((d) => {
        d.v2.ThreadStartParams.properties.futureOption = { type: 'string' };
        d.v2.ThreadStartParams.required = ['futureOption'];
      }).join(' '),
    ).toContain('new required input futureOption');
  });
  it('blocks removal of a needed request and of a nested response field', () => {
    expect(
      check((d) => {
        d.ClientRequest.oneOf = d.ClientRequest.oneOf.filter(
          (x) => !x.properties.method.enum.includes('turn/interrupt'),
        );
      }).join(' '),
    ).toContain('turn/interrupt:request');
    expect(
      check((d) => {
        delete d.v2.Thread.properties.cwd;
      }).join(' '),
    ).toContain('cwd');
  });
  it('blocks loss of required output, type changes, enum changes and unresolved references', () => {
    expect(
      check((d) => {
        d.v2.Thread.required = d.v2.Thread.required.filter((x) => x !== 'cwd');
      }).join(' '),
    ).toContain('required output lost cwd');
    expect(
      check((d) => {
        d.v2.Thread.properties.cwd = { type: 'number' };
      }).length,
    ).toBeGreaterThan(0);
    expect(
      check((d) => {
        d.v2.TurnStatus.enum.push('abandoned');
      }).length,
    ).toBeGreaterThan(0);
    expect(
      check((d) => {
        d.v2.ThreadReadResponse.properties.thread = { $ref: '#/definitions/DoesNotExist' };
      }).length,
    ).toBeGreaterThan(0);
  });
  it('does not ignore newly added permissions or constraints beside references', () => {
    expect(
      check((d) => {
        d.v2.SandboxPolicy.oneOf[0].properties.bypass = { type: 'boolean' };
      }).length,
    ).toBeGreaterThan(0);
    expect(
      check((d) => {
        d.v2.ThreadReadResponse.properties.thread.extraConstraint = true;
      }).length,
    ).toBeGreaterThan(0);
  });
  it('rejects malformed required metadata rather than treating it as optional', () => {
    expect(
      check((d) => {
        d.v2.ThreadStartParams.required = 'threadId';
      }).length,
    ).toBeGreaterThan(0);
  });
  it('fails closed on malformed exports', () => {
    expect(compareContract(profile, {}).length).toBeGreaterThan(0);
  });
});
describe('Codex executable discovery', () => {
  it('repairs only a missing old entry inside the same known app bundle', () => {
    const root = temporary(),
      resources = join(root, '中文 路径/ChatGPT.app/Contents/Resources');
    const next = join(resources, 'codex-cli/bin/codex');
    mkdirSync(join(resources, 'codex-cli/bin'), { recursive: true });
    writeFileSync(next, '#!/bin/sh\n', { mode: 0o700 });
    const old = join(resources, 'codex');
    expect(resolveCodexBinary(old)).toBe(next);
    writeFileSync(old, '#!/bin/sh\n', { mode: 0o700 });
    expect(resolveCodexBinary(old)).toBe(old);
    expect(resolveCodexBinary(join(root, 'custom-codex'))).toBe(join(root, 'custom-codex'));
    expect(resolveCodexBinary(join(root, 'My.app/Contents/Resources/codex'))).toBe(
      join(root, 'My.app/Contents/Resources/codex'),
    );
  });
  it('discovers both layouts in system and user application directories', () => {
    const candidates = codexCandidates('/Users/中文 用户');
    expect(candidates).toHaveLength(8);
    expect(candidates).toContain(
      '/Users/中文 用户/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    );
  });
});
describe('version gate and diagnostic errors', () => {
  it('accepts an unlisted version only after schema inspection and cleans the temporary home', async () => {
    const { binary, root } = fakeBinary('codex-cli 9.9.9-alpha.1');
    const r = await inspectCodex(binary);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('compatible');
    expect(r.message).toContain('尚未完成完整联调');
    expect(existsSync(readFileSync(join(root, 'home.txt'), 'utf8'))).toBe(false);
  });
  it('does not trust even a verified version string when its schema is incompatible', async () => {
    const schema = clone();
    delete schema.definitions.v2.Thread.properties.cwd;
    const { binary } = fakeBinary('codex-cli 0.155.0-alpha.9.2', schema);
    const r = await inspectCodex(binary);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('incompatible');
    expect(r.message).toContain('cwd');
  });
  it('keeps verified and merely compatible evidence separate', async () => {
    const { binary } = fakeBinary('codex-cli 0.155.0-alpha.9.2', oldSchema);
    expect((await inspectCodex(binary)).status).toBe('verified');
  });
  it.each(['fail', 'malformed'])('rejects %s schema export without bypass', async (mode) => {
    const { binary } = fakeBinary('codex-cli 0.158.0-alpha.2.1', newSchema, mode);
    const r = await inspectCodex(binary);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('无法导出或读取');
  });
  it('distinguishes missing binary, wrong program and Node mismatch', async () => {
    const r = await runDoctor(join(temporary(), 'missing'));
    expect(r.checks.codex.actual).toBeNull();
    expect(doctorMessage(r)).toContain('无法执行 Codex');
    const { binary } = fakeBinary('not codex');
    expect((await inspectCodex(binary)).message).toContain('无法识别');
    r.checks.node = { expected: '24.15.0', actual: '22.0.0', ok: false };
    expect(doctorMessage(r)).toContain('实际 22.0.0');
  });
  it('rechecks changed contents instead of reusing a cached success', async () => {
    const { binary, root } = fakeBinary('codex-cli 0.158.0-alpha.2.1');
    expect((await inspectCodex(binary)).ok).toBe(true);
    const schema = clone();
    delete schema.definitions.v2.Thread.properties.cwd;
    writeFileSync(join(root, 'schema.json'), JSON.stringify(schema));
    expect((await inspectCodex(binary)).ok).toBe(false);
  });
});
