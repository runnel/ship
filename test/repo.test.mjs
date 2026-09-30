import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGh, makeOrigin } from './helpers.mjs';
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
