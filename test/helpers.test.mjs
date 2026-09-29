import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers.mjs';

const deadline = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms).unref());

// process.kill(0, ...) signals the caller's whole process group; a negative pid a whole other
// group. A test that cleans up "by pid" after a failure must never do either, or a failing test
// takes down its own runner (and ship, when ship checks itself) and hides the failure.
test('the pid helpers refuse anything that is not a real pid, and a missing pid file is a no-op', { timeout: 30_000 }, async () => {
  const dir = await tempDir('pidhelpers-');
  const script = join(dir, 'check.mjs');
  const helpers = new URL('./helpers.mjs', import.meta.url).href;
  await writeFile(script, `
import { spawn } from 'node:child_process';
import { isAlive, killQuietly, readPid } from ${JSON.stringify(helpers)};
const sibling = spawn('sleep', ['41.5926'], { stdio: 'ignore' }); // same process group as this script
await new Promise((r) => setTimeout(r, 100));
for (const bad of [0, -1, NaN, null, undefined, '12', 1.5, process.pid]) killQuietly(bad);
killQuietly(await readPid(${JSON.stringify(join(dir, 'missing'))}));
process.stdout.write('missing pid file -> ' + (await readPid(${JSON.stringify(join(dir, 'missing'))})) + '\\n');
process.stdout.write('isAlive of invalid pids -> ' + [0, -1, NaN, null].map((p) => isAlive(p)).join(',') + '\\n');
process.stdout.write('sibling alive -> ' + isAlive(sibling.pid) + '\\n');
sibling.kill('SIGKILL');
`);
  // A group of its own, like ship's: the script has a sibling in it, and no way to tell from the outside.
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  try {
    const { code, signal } = await Promise.race([exited, deadline(20_000, 'the helper script')]);
    assert.deepEqual({ code, signal }, { code: 0, signal: null }, out);
    assert.match(out, /missing pid file -> null/);
    assert.match(out, /isAlive of invalid pids -> false,false,false,false/);
    assert.match(out, /sibling alive -> true/);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
});
