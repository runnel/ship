import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { atTestEnd, fakeGh, makeOrigin, stopBackground, tempDir, tracked } from './helpers.mjs';
import { capture } from '../lib/proc.mjs';
import { ensureMirror } from '../lib/git.mjs';
import { openTree, prRefs, shipsText, syncMirror } from '../lib/repo.mjs';

// However a test ends, the lock it took and the sync waiting behind it end with it.
afterEach(stopBackground, { timeout: 30_000 });

const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

test('the package cannot be published to npm by accident, and has no runtime dependencies', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

const CONFIG = `export default ({ root }) => ({ repo: 't/r', checks: [{ name: 'u', paths: ['**'], steps: ['true'] }], runtime: { root } });\n`;

test('syncMirror finds main; openTree evaluates the config against the worktree and removes it', async () => {
  const { origin, root } = await makeOrigin({ 'ship.config.mjs': CONFIG, 'a.txt': 'a' });
  const { gh } = await fakeGh(root, { pr: null });
  const d = { gh, remoteUrl: () => origin, mirrorRoot: join(root, 'm'), tmpRoot: join(root, 'tmp'), pollMs: 10, out: () => {} };
  const r = await syncMirror({ repo: 't/r', d });
  assert.equal(r.mainBranch, 'main');
  assert.match(r.mainSha, /^[0-9a-f]{40}$/);
  const tree = await openTree({ d, r, sha: r.mainSha, label: 'd' });
  assert.equal(tree.config.runtime.root, tree.wt);
  await access(join(tree.wt, 'a.txt'));
  await tree.close();
  assert.deepEqual(await readdir(join(root, 'tmp', 'w')), []);
});

test('openTree refuses a commit without a config', async () => {
  const { origin, root } = await makeOrigin({ 'a.txt': 'a' });
  const { gh } = await fakeGh(root, { pr: null });
  const d = { gh, remoteUrl: () => origin, mirrorRoot: join(root, 'm'), tmpRoot: join(root, 'tmp'), pollMs: 10, out: () => {} };
  const r = await syncMirror({ repo: 't/r', d });
  await assert.rejects(openTree({ d, r, sha: r.mainSha, label: 'd' }), /no ship.config.mjs/);
  assert.deepEqual(await readdir(join(root, 'tmp', 'w')), []);
});

test('prRefs lists PR numbers from squash subjects', () => {
  assert.equal(prRefs(['feat: x (#1563)', 'fix: y', 'docs: z (#1564)']), '#1563 #1564');
  assert.equal(prRefs([]), '');
});

test('syncMirror asks GitHub for the default branch before it takes the mirror lock', async () => {
  const { origin, root } = await makeOrigin({ 'a.txt': 'a' });
  const { gh, calls } = await fakeGh(root, { pr: null });
  const d = { gh, remoteUrl: () => origin, mirrorRoot: join(root, 'm'), tmpRoot: join(root, 'tmp'), pollMs: 10, out: () => {} };
  const release = atTestEnd(await acquire(join(root, 'tmp', 'locks', 'mirror-t__r'), await ownerInfo({ label: 'other run' }), { pollMs: 10 }));
  const pending = tracked(syncMirror)({ repo: 't/r', d });
  const until = Date.now() + 30000;
  while (Date.now() < until && (await calls()).length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await calls()).length, 1, 'gh was asked while another run still holds the lock');
  await release();
  assert.equal((await pending).mainBranch, 'main');
});

test('openTree creates no worktree once the process is interrupted', { timeout: 30_000 }, async () => {
  const { origin, root } = await makeOrigin({ 'ship.config.mjs': CONFIG, 'a.txt': 'a' });
  const { gh } = await fakeGh(root, { pr: null });
  const dir = await tempDir();
  const out = join(dir, 'out');
  const script = join(dir, 'open.mjs');
  const href = (p) => new URL(p, import.meta.url).href;
  // Interrupts itself while a handler keeps the unwind pending, so the process stays alive and
  // interrupted for the openTree call, which must refuse instead of adding a worktree.
  await writeFile(script, `
import { appendFileSync } from 'node:fs';
import { isInterrupted, onInterrupt } from ${JSON.stringify(href('../lib/interrupt.mjs'))};
import { openTree, syncMirror } from ${JSON.stringify(href('../lib/repo.mjs'))};
const a = JSON.parse(process.argv[2]);
const d = { gh: a.gh, remoteUrl: () => a.origin, mirrorRoot: a.mirrorRoot, tmpRoot: a.tmpRoot, pollMs: 10, out: () => {} };
const r = await syncMirror({ repo: 't/r', d });
let finish;
const gate = new Promise((resolve) => { finish = resolve; });
onInterrupt(() => gate);
process.kill(process.pid, 'SIGTERM');
while (!isInterrupted()) await new Promise((resolve) => setTimeout(resolve, 5));
let outcome;
try {
  await openTree({ d, r, sha: r.mainSha, label: 'd' });
  outcome = 'opened';
} catch (e) {
  outcome = e.aborted ? 'aborted' : e.message;
}
appendFileSync(${JSON.stringify(out)}, outcome);
finish();
`);
  const arg = JSON.stringify({ gh, origin, mirrorRoot: join(root, 'm'), tmpRoot: join(root, 'tmp') });
  const child = spawn(process.execPath, [script, arg], { stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 130);
    assert.equal(await readFile(out, 'utf8'), 'aborted');
    assert.deepEqual(await readdir(join(root, 'tmp', 'w')).catch(() => []), []);
  } finally {
    child.kill('SIGKILL');
  }
});

test('shipsText names the PRs and counts commits without one', () => {
  assert.equal(shipsText(['a (#9)', 'b (#12)', 'direct fix']), 'ships 3 commit(s): #9 #12 + 1 without a PR number');
  assert.equal(shipsText(['a (#9)', 'b (#12)']), 'ships 2 commit(s): #9 #12');
  assert.equal(shipsText(['direct fix']), 'ships 1 commit(s)');
});

test('syncMirror passes the gh and fetch time limits on', async () => {
  const { origin, root } = await makeOrigin({ 'a.txt': 'a' });
  const bin = await tempDir('bin-');
  const pidFile = join(bin, 'helper.pids');
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexec sleep 5\n');
  await writeFile(join(bin, 'git-remote-hang'), `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 5\n`);
  await chmod(join(bin, 'gh'), 0o755);
  await chmod(join(bin, 'git-remote-hang'), 0o755);
  const mirrorRoot = join(root, 'm');
  const mirror = await ensureMirror('t/r', { root: mirrorRoot, url: origin });
  await capture('git', ['--git-dir', mirror, 'remote', 'set-url', 'origin', 'hang::nowhere']);
  const d = { gh: join(bin, 'gh'), remoteUrl: () => 'hang::nowhere', mirrorRoot, tmpRoot: join(root, 'tmp'), pollMs: 10, out: () => {} };
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    await assert.rejects(syncMirror({ repo: 't/r', d: { ...d, ghTimeoutMs: 300 } }), (e) => e.timedOut === true);
    await assert.rejects(syncMirror({ repo: 't/r', d: { ...d, fetchTimeoutMs: 1500 }, mainBranch: 'main' }),
      (e) => e.timedOut === true && /^git fetch of t\/r took longer than 1\.5 s$/.test(e.message));
  } finally {
    process.env.PATH = path;
    for (const p of (await readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number)) {
      try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    }
  }
});
