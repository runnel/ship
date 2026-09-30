import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import config from '../ship.config.mjs';
import { validateConfig } from '../lib/config.mjs';
import { buildEnv, capture, run } from '../lib/proc.mjs';
import { tempDir } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AT = '@';

const scratchGit = (dir, ...args) => capture('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=1+x' + AT + 'users.noreply.github.com', '-c', 'commit.gpgsign=false', ...args]);

test("ship's own config validates", () => {
  const c = validateConfig(config);
  assert.equal(c.mainBranch, 'main');
  assert.ok(c.checks.some((k) => k.steps.some((s) => s.run.includes('leak --all'))));
});

// A pull request must not weaken its own gate: the leak step judges the tree with the guard that
// is on main, so a PR that gutters lib/leak.mjs and adds a leak is still caught.
test("the self-check's leak step runs main's guard, not the tree's own", { timeout: 60_000 }, async () => {
  const step = validateConfig(config).checks.flatMap((k) => k.steps).find((s) => s.run.includes('leak --all')).run;
  const dir = await tempDir('selfcheck-');
  await capture('git', ['init', '--quiet', '--initial-branch=main', dir]);
  await cp(join(ROOT, 'lib'), join(dir, 'lib'), { recursive: true });
  await cp(join(ROOT, 'bin'), join(dir, 'bin'), { recursive: true });
  await scratchGit(dir, 'add', '-A');
  await scratchGit(dir, 'commit', '--quiet', '-m', 'main has the real guard');
  await scratchGit(dir, 'checkout', '--quiet', '-b', 'feat');
  await writeFile(join(dir, 'lib', 'leak.mjs'), "export async function runLeak() { console.log('gutted guard: clean'); return 0; }\n");
  await writeFile(join(dir, 'notes.txt'), 'mail bob' + AT + 'corp.ee\n');
  await scratchGit(dir, 'add', '-A');
  await scratchGit(dir, 'commit', '--quiet', '-m', 'a PR that guts the guard and leaks');

  const denylist = join(await tempDir(), 'denylist');
  await writeFile(denylist, 'zebra\n');
  const r = await run(step, { cwd: dir, env: buildEnv({ SHIP_DENYLIST: denylist }), logFile: join(dir, '..', 'selfcheck.log'), timeoutMs: 45_000 });
  assert.notEqual(r.code, 0, r.tail.join('\n'));
  assert.ok(r.tail.some((l) => l.includes('e-mail address')), r.tail.join('\n'));
  assert.ok(!r.tail.some((l) => l.includes('gutted guard')), r.tail.join('\n'));
});
