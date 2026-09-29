import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers.mjs';

test('interrupt handlers run last-registered first, then the process exits 130', async () => {
  const dir = await tempDir();
  const out = join(dir, 'out');
  const script = join(dir, 's.mjs');
  const mod = new URL('../lib/interrupt.mjs', import.meta.url).href;
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { onInterrupt } from ${JSON.stringify(mod)};
onInterrupt(() => appendFileSync(${JSON.stringify(out)}, 'a,'));
onInterrupt(() => appendFileSync(${JSON.stringify(out)}, 'b,'));
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 130);
  assert.equal(await readFile(out, 'utf8'), 'b,a,');
});
