import { parseArgs } from 'node:util';
import { inspectCodex } from '../src/codex/compatibility.ts';
const { values } = parseArgs({ options: { binary: { type: 'string' } } });
const result = await inspectCodex(values.binary ?? process.env.CODEX_BINARY);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
