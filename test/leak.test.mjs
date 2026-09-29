import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, loadDenylist, runLeak } from '../lib/leak.mjs';
import { capture } from '../lib/proc.mjs';
import { tempDir } from './helpers.mjs';

const rules = (text, opts) => scanText(text, opts).map((f) => f.rule);
const USERS = '/Us' + 'ers/';
const AT = '@';

test('flags absolute user paths but not placeholders', () => {
  assert.deepEqual(rules(`see ${USERS}alice/x`), ['absolute user path']);
  assert.deepEqual(rules(`see ${USERS}<name>/x`), []);
});

test('flags e-mail addresses except allowed ones', () => {
  assert.deepEqual(rules(`mail bob${AT}corp.ee`), ['e-mail address']);
  assert.deepEqual(rules(`noreply${AT}anthropic.com`), []);
  assert.deepEqual(rules(`12+x${AT}users.noreply.github.com`), []);
  assert.deepEqual(rules(`x${AT}example.com`), []);
  assert.deepEqual(rules(`ship${AT}localhost`), []);
  assert.deepEqual(rules('git' + AT + 'github.com:acme/app.git'), []);
});

test("GitHub's own committer address (web merges, squash merges) is allowed", () => {
  assert.deepEqual(rules('GitHub <noreply' + AT + 'github.com>'), []);
  assert.deepEqual(rules('other-noreply' + AT + 'github.com'), ['e-mail address']);
});

test('flags service identifiers', () => {
  assert.deepEqual(rules('https://' + 'abcdefghij0123456789' + '.supa' + 'base.co'), ['Supabase project URL']);
  assert.deepEqual(rules('id ' + '0123456789abcdef'.repeat(2)), ['Cloudflare account id']);
  assert.deepEqual(rules('https://v1-app.' + 'acme' + '.workers.dev'), ['named workers.dev subdomain']);
  assert.deepEqual(rules('https://v1-app.' + 'example' + '.workers.dev'), []);
  assert.deepEqual(rules('gh' + 'p_' + 'a'.repeat(36)), ['GitHub token']);
});

test('denylist terms match whole words, case-insensitively, reported without the term', () => {
  assert.deepEqual(scanText('Hello Acme-Client world', { denylist: ['acme-client'], source: 'x.md' }), [{ source: 'x.md', line: 1, rule: 'denylist' }]);
  assert.deepEqual(rules('Canada day', { denylist: ['ada'] }), []);
  assert.deepEqual(rules('ask Ada', { denylist: ['ada'] }), ['denylist']);
  assert.deepEqual(rules('ada-sync job', { denylist: ['ada'] }), ['denylist']);
});

test('loadDenylist ignores comments and blanks, and fails closed when missing', async () => {
  const dir = await tempDir();
  const file = join(dir, 'denylist');
  await writeFile(file, '# terms\nAcme\n\n  Other Corp \n');
  assert.deepEqual(await loadDenylist(file), ['acme', 'other corp']);
  await assert.rejects(() => loadDenylist(join(dir, 'missing')));
});

test('--staged refuses a commit identity that is not a noreply address', async () => {
  const dir = await tempDir();
  await capture('git', ['init', '--quiet', dir]);
  await capture('git', ['-C', dir, 'config', 'user.name', 'x']);
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  await capture('git', ['-C', dir, 'add', 'a.txt']);
  await capture('git', ['-C', dir, 'config', 'user.email', 'x' + AT + 'corp.ee']);
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: () => {} }), 1);
  await capture('git', ['-C', dir, 'config', 'user.email', '1+x' + AT + 'users.noreply.github.com']);
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: () => {} }), 0);
});

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

test("this repository's own files pass the generic rules", async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const findings = [];
  for (const f of await walk(root)) findings.push(...scanText(await readFile(f, 'utf8'), { source: f.slice(root.length) }));
  assert.deepEqual(findings, []);
});
