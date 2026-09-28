import { URL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { buildContract } from '../src/codex/contract.ts';
import baseline from '../src/runtime-baseline.json' with { type: 'json' };
const source = JSON.parse(
  readFileSync(
    new URL(`../schemas/codex/${baseline.codex}/protocol.schema.json`, import.meta.url),
    'utf8',
  ),
);
const content = `${JSON.stringify(buildContract(source, baseline.codex), null, 2)}\n`;
const target = new URL('../src/codex/compatibility-profile.json', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== content)
    throw Error('Compatibility profile is stale; review before regenerating');
} else writeFileSync(target, content);
console.log(`Compatibility profile ${process.argv.includes('--check') ? 'verified' : 'generated'}`);
