import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, ownerInfo } from '../lib/lock.mjs';
import { fakeGh, makeOrigin, tempDir } from './helpers.mjs';
import { openTree, prRefs, syncMirror } from '../lib/repo.mjs';

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
  const release = await acquire(join(root, 'tmp', 'locks', 'mirror-t__r'), await ownerInfo({ label: 'other run' }), { pollMs: 10 });
  const pending = syncMirror({ repo: 't/r', d });
  try {
    const until = Date.now() + 5000;
    while (Date.now() < until && (await calls()).length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await calls()).length, 1, 'gh was asked while another run still holds the lock');
  } finally {
    await release(); // also when the assertion failed: the waiting sync must not poll forever
  }
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
