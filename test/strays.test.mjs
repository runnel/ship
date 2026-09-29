import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { capture } from '../lib/proc.mjs';
import { setupCheck, spawnCheckLeader, tempDir } from './helpers.mjs';

const deadline = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms).unref());

// A step that starts a background process without holding its output (a dev server, a build worker)
// and exits 0: the check passes, and nothing it started may outlive it. The process is still there
// for the next step, and is gone when the check ends.
test('background processes left by a passing check are stopped when it ends, not before', { timeout: 60_000 }, async () => {
  const dir = await tempDir('strays-');
  const pidFile = join(dir, 'pid');
  const s = await setupCheck({
    steps: [`(sleep 62.2718 >/dev/null 2>&1 & echo $! > ${pidFile})`, `kill -0 $(cat ${pidFile})`],
  });
  const run = await spawnCheckLeader(s, dir);
  try {
    const code = await Promise.race([run.exited, deadline(40_000, 'ship exit')]);
    assert.equal(code, 0, run.out.text);
    assert.equal((await s.statuses()).at(-1).state, 'success'); // the next step saw the process
    assert.match(run.out.text, /! 1 background process\(es\) .* stopped/);
    assert.equal((await capture('pgrep', ['-f', 'sleep 62.2718']).catch(() => '')).trim(), '');
  } finally {
    run.kill();
  }
});
