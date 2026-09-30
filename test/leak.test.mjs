import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, symlink, unlink, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, loadDenylist, runLeak, parseCommitLog } from '../lib/leak.mjs';
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

test('flags more secret shapes', () => {
  assert.deepEqual(rules('key ' + 'sk-' + 'ant-' + 'api03-' + 'a'.repeat(30)), ['Anthropic API key']);
  assert.deepEqual(rules('key ' + 'sk_' + 'live_' + 'a'.repeat(24)), ['Stripe live key']);
  assert.deepEqual(rules('key ' + 'rk_' + 'live_' + 'a'.repeat(24)), ['Stripe live key']);
  assert.deepEqual(rules('token ' + 'xox' + 'b-' + '1234567890-abcdefghij'), ['Slack token']);
  assert.deepEqual(rules('token ' + 'npm' + '_' + 'a'.repeat(36)), ['npm token']);
  assert.deepEqual(rules('key ' + 'AI' + 'za' + 'a'.repeat(35)), ['Google API key']);
  assert.deepEqual(rules('sk-learn and npm_config are ordinary words'), []);
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

test('an empty denylist is refused like a missing one', async () => {
  const dir = await tempDir();
  const file = join(dir, 'denylist');
  await writeFile(file, '# only comments\n\n');
  await assert.rejects(() => loadDenylist(file), /empty/);
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

// The published set is what git tracks: ignored files, editor leftovers and local notes are not it.
test("this repository's own tracked files pass the generic rules", async (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  let files;
  try {
    files = (await capture('git', ['-C', root, 'ls-files', '-z'])).split('\0').filter(Boolean);
  } catch {
    return t.skip('not a git checkout');
  }
  assert.ok(files.length > 10, 'expected a populated repository');
  const findings = [];
  for (const f of files) {
    const text = await readFile(join(root, f), 'utf8').catch(() => null);
    if (text !== null && !text.includes('\u0000')) findings.push(...scanText(text, { source: f }));
  }
  assert.deepEqual(findings, []);
});

// --- fail-closed behaviour (scratch repositories) ---------------------------------------------

const NOREPLY = '1+x' + AT + 'users.noreply.github.com';
const LEAKY = 'mail bob' + AT + 'corp.ee\n';
const git = (dir, ...args) => capture('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args]);

async function scratchRepo(files = {}) {
  const dir = await tempDir('leak-');
  await capture('git', ['init', '--quiet', '--initial-branch=main', dir]);
  await git(dir, 'config', 'user.name', 'x');
  await git(dir, 'config', 'user.email', NOREPLY);
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await writeAll(dir, files);
  return dir;
}
async function writeAll(dir, files) {
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
}
async function commitAll(dir, message = 'm') {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}
const collect = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(l) };
};

test('--pre-push still scans when the remote tip is unknown locally (force push, GitHub-side commit)', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeAll(dir, { 'b.txt': LEAKY });
  const tip = await commitAll(dir, 'two');
  const c = collect();
  const stdin = Readable.from([`refs/heads/main ${tip} refs/heads/main ${'f'.repeat(40)}\n`]);
  assert.equal(await runLeak(['--pre-push', 'origin', '--generic-only'], { cwd: dir, out: c.out, stdin }), 1);
  assert.ok(c.lines.some((l) => l.includes('e-mail address')), c.lines.join('\n'));
});

test('--pre-push: a clean range passes, a deleted ref is skipped, a new branch is scanned', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const first = await commitAll(dir, 'one');
  await writeAll(dir, { 'b.txt': 'also clean\n' });
  const second = await commitAll(dir, 'two');
  const run = (line) => runLeak(['--pre-push', 'origin', '--generic-only'], { cwd: dir, out: () => {}, stdin: Readable.from([line]) });
  assert.equal(await run(`refs/heads/main ${second} refs/heads/main ${first}\n`), 0);
  assert.equal(await run(`(delete) ${'0'.repeat(40)} refs/heads/gone ${first}\n`), 0);
  await writeAll(dir, { 'c.txt': LEAKY });
  const third = await commitAll(dir, 'three');
  assert.equal(await run(`refs/heads/feat ${third} refs/heads/feat ${'0'.repeat(40)}\n`), 1);
  assert.equal(await run(`refs/heads/main ${third} refs/heads/main ${second}\n`), 1);
});

test('--history and --all refuse, instead of reporting clean, when git cannot be read', async () => {
  const notARepo = await tempDir('nogit-');
  for (const mode of ['--history', '--all']) {
    const c = collect();
    assert.equal(await runLeak([mode, '--generic-only'], { cwd: notARepo, out: c.out }), 1, mode);
    assert.ok(c.lines.some((l) => l.includes('cannot verify')), c.lines.join('\n'));
    assert.ok(!c.lines.some((l) => l.includes('clean')), c.lines.join('\n'));
  }
});

test('a binary blob is a finding unless its path is allowlisted', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await writeFile(join(dir, 'blob.bin'), Buffer.from('bin\0ary ' + LEAKY));
  await git(dir, 'add', '-A');
  const c = collect();
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: c.out }), 1);
  assert.ok(c.lines.some((l) => l.includes('blob.bin') && l.includes('binary file')), c.lines.join('\n'));
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: () => {}, binaryAllow: ['*.bin'] }), 0);
});

test('binary files added in history are findings too (git log -p only says "Binary files differ")', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeFile(join(dir, 'blob.bin'), Buffer.from('bin\0ary ' + LEAKY));
  await commitAll(dir, 'two');
  const c = collect();
  assert.equal(await runLeak(['--history', '--generic-only'], { cwd: dir, out: c.out }), 1);
  assert.ok(c.lines.some((l) => l.includes('binary file')), c.lines.join('\n'));
  assert.equal(await runLeak(['--history', '--generic-only'], { cwd: dir, out: () => {}, binaryAllow: ['*.bin'] }), 0);
});

test('a NUL byte later in a text patch does not exempt the whole commit from scanning', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeFile(join(dir, 'late.txt'), LEAKY + 'x'.repeat(9000) + '\0tail\n');
  await commitAll(dir, 'two');
  assert.equal(await runLeak(['--history', '--generic-only'], { cwd: dir, out: () => {} }), 1);
});

test('--all scans the committed blobs, not the working tree', async () => {
  const dir = await scratchRepo({ 'notes.txt': LEAKY, 'gone.txt': LEAKY });
  await commitAll(dir);
  await writeAll(dir, { 'notes.txt': 'clean now\n' }); // edited after the commit, never staged
  await rm(join(dir, 'gone.txt'));
  const c = collect();
  assert.equal(await runLeak(['--all', '--generic-only'], { cwd: dir, out: c.out }), 1);
  assert.ok(c.lines.some((l) => l.startsWith('✗ notes.txt:1')), c.lines.join('\n'));
  assert.ok(c.lines.some((l) => l.startsWith('✗ gone.txt:1')), c.lines.join('\n'));
});

test('--msg scans the message file and refuses an unreadable one', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'ok'), 'fix: something\n');
  await writeFile(join(dir, 'bad'), 'fix: ' + LEAKY);
  assert.equal(await runLeak(['--msg', join(dir, 'ok'), '--generic-only'], { cwd: dir, out: () => {} }), 0);
  assert.equal(await runLeak(['--msg', join(dir, 'bad'), '--generic-only'], { cwd: dir, out: () => {} }), 1);
  assert.equal(await runLeak(['--msg', join(dir, 'missing'), '--generic-only'], { cwd: dir, out: () => {} }), 1);
});

test('.gitignore keeps Finder metadata out of the published tree', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.ok((await readFile(join(root, '.gitignore'), 'utf8')).split('\n').includes('.DS_Store'));
});

test('file names are scanned too, and a staged type change is not skipped', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n', 'link': 'clean\n' });
  await commitAll(dir);
  await writeFile(join(dir, 'bob' + AT + 'corp.ee.txt'), 'clean\n');
  await git(dir, 'add', '-A');
  const c = collect();
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: c.out }), 1);
  assert.ok(c.lines.some((l) => l.includes('e-mail address (in the file name)')), c.lines.join('\n'));
  await git(dir, 'reset', '--quiet');
  await rm(join(dir, 'bob' + AT + 'corp.ee.txt'));

  // regular file -> symlink whose target text leaks: a "T" entry in the index diff
  await unlink(join(dir, 'link'));
  await symlink('x/bob' + AT + 'corp.ee', join(dir, 'link'));
  await git(dir, 'add', '-A');
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: () => {} }), 1);
});

test('a denylisted term in a file name is a finding', async () => {
  const dir = await scratchRepo({});
  await writeFile(join(dir, 'zebra-notes.txt'), 'clean\n');
  await git(dir, 'add', '-A');
  const list = join(await tempDir(), 'denylist');
  await writeFile(list, 'zebra\n');
  const saved = process.env.SHIP_DENYLIST;
  process.env.SHIP_DENYLIST = list;
  try {
    const c = collect();
    assert.equal(await runLeak(['--staged'], { cwd: dir, out: c.out }), 1);
    assert.ok(c.lines.some((l) => l.endsWith(': denylist (in the file name)')), c.lines.join('\n'));
  } finally {
    if (saved === undefined) delete process.env.SHIP_DENYLIST;
    else process.env.SHIP_DENYLIST = saved;
  }
});

test('--pre-push trusts only the remote being pushed to', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeAll(dir, { 'b.txt': LEAKY });
  const tip = await commitAll(dir, 'two');
  await git(dir, 'update-ref', 'refs/remotes/other/main', tip); // another remote already has it
  const push = (remote) => runLeak(['--pre-push', remote, '--generic-only'], {
    cwd: dir, out: () => {}, stdin: Readable.from([`refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`]),
  });
  assert.equal(await push('origin'), 1);
  assert.equal(await push('other'), 0);
});

test('findings about a file name never print the name, nor does any other finding of that file', async () => {
  const dir = await scratchRepo({});
  const emailName = 'bob' + AT + 'corp.ee.txt';
  await writeFile(join(dir, emailName), 'clean\n');
  await writeFile(join(dir, 'zebra-notes.txt'), LEAKY);
  await writeFile(join(dir, 'fine.txt'), LEAKY);
  await git(dir, 'add', '-A');
  const list = join(await tempDir(), 'denylist');
  await writeFile(list, 'zebra\n');
  const saved = process.env.SHIP_DENYLIST;
  process.env.SHIP_DENYLIST = list;
  try {
    const c = collect();
    assert.equal(await runLeak(['--staged'], { cwd: dir, out: c.out }), 1);
    const printed = c.lines.join('\n');
    assert.ok(!printed.includes('corp.ee'), printed);
    assert.ok(!printed.includes('zebra'), printed);
    assert.ok(c.lines.some((l) => l.includes('(name withheld):0: e-mail address (in the file name)')), printed);
    assert.ok(c.lines.some((l) => l.includes('(name withheld):0: denylist (in the file name)')), printed);
    assert.ok(c.lines.some((l) => l.includes('(name withheld):1: e-mail address')), printed); // zebra-notes.txt's content
    assert.ok(c.lines.some((l) => l.startsWith('✗ fine.txt:1: e-mail address')), printed); // a clean name is still shown
  } finally {
    if (saved === undefined) delete process.env.SHIP_DENYLIST;
    else process.env.SHIP_DENYLIST = saved;
  }
});

// --- commits made by GitHub -------------------------------------------------------------------
// GitHub fills the author line (name and noreply address) of the commits it creates (web merges,
// `gh pr merge`) from the account, which is public. Line 1 of such a commit is not matched against
// the denylist; its message and patch are scanned as usual, and line 1 still faces the generic rules.

const GITHUB_COMMITTER = { name: 'GitHub', email: 'noreply' + AT + 'github.com' };
const ACCOUNT_AUTHOR = { name: 'Zelda Example', email: '1+zelda' + AT + 'users.noreply.github.com' };

async function commitAs(dir, author, committer, message, body = 'clean\n') {
  await writeAll(dir, { 'n.txt': body });
  await git(dir, 'add', '-A');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email,
  };
  await capture('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message], { env });
}

// Runs the guard with a throwaway denylist; never the user's own. `mode` is a flag or an argument list.
async function leakWithDenylist(dir, mode, terms = ['zelda'], stdin) {
  const list = join(await tempDir(), 'denylist');
  await writeFile(list, `${terms.join('\n')}\n`);
  const saved = process.env.SHIP_DENYLIST;
  process.env.SHIP_DENYLIST = list;
  try {
    const c = collect();
    const code = await runLeak([mode].flat(), { cwd: dir, out: c.out, stdin });
    return { code, lines: c.lines, printed: c.lines.join('\n') };
  } finally {
    if (saved === undefined) delete process.env.SHIP_DENYLIST;
    else process.env.SHIP_DENYLIST = saved;
  }
}

test('a commit GitHub made: the account name on its author line is not matched against the denylist', async () => {
  for (const mode of ['--all', '--history']) {
    const dir = await scratchRepo({});
    await commitAs(dir, ACCOUNT_AUTHOR, GITHUB_COMMITTER, 'squash merge');
    const r = await leakWithDenylist(dir, mode);
    assert.equal(r.code, 0, `${mode}: ${r.printed}`);
    assert.deepEqual(r.lines, ['✓ leak guard: clean']);
  }
});

test('the same author line on a commit made locally is still a denylist finding on line 1', async () => {
  const dir = await scratchRepo({});
  await commitAs(dir, ACCOUNT_AUTHOR, { name: 'dev', email: '1+dev' + AT + 'users.noreply.github.com' }, 'local commit');
  const r = await leakWithDenylist(dir, '--all');
  assert.equal(r.code, 1, r.printed);
  assert.ok(r.lines.some((l) => /^✗ commit [0-9a-f]{7}:1: denylist$/.test(l)), r.printed);
});

test("a committer that only resembles GitHub's does not earn the exemption", async () => {
  for (const committer of [
    { name: 'GitHub', email: '1+dev' + AT + 'users.noreply.github.com' },
    { name: 'GitHub Actions', email: GITHUB_COMMITTER.email },
    { name: 'dev', email: GITHUB_COMMITTER.email },
  ]) {
    const dir = await scratchRepo({});
    await commitAs(dir, ACCOUNT_AUTHOR, committer, 'borrowed committer');
    const r = await leakWithDenylist(dir, '--all');
    assert.equal(r.code, 1, `${committer.name} <${committer.email}>: ${r.printed}`);
    assert.ok(r.lines.some((l) => /^✗ commit [0-9a-f]{7}:1: denylist$/.test(l)), r.printed);
  }
});

test("an author address that is not a GitHub account's noreply address does not earn it either", async () => {
  const dir = await scratchRepo({});
  await commitAs(dir, { name: 'Zelda Example', email: 'zelda' + AT + 'example.com' }, GITHUB_COMMITTER, 'squash merge');
  const r = await leakWithDenylist(dir, '--all');
  assert.equal(r.code, 1, r.printed);
  assert.ok(r.lines.some((l) => /^✗ commit [0-9a-f]{7}:1: denylist$/.test(l)), r.printed);
});

test('a commit GitHub made is still scanned for its message and its patch', async () => {
  const inMessage = await scratchRepo({});
  await commitAs(inMessage, ACCOUNT_AUTHOR, GITHUB_COMMITTER, 'merge the zelda change');
  const m = await leakWithDenylist(inMessage, '--all');
  assert.equal(m.code, 1, m.printed);
  assert.ok(m.lines.some((l) => /^✗ commit [0-9a-f]{7}:3: denylist$/.test(l)), m.printed);

  const inPatch = await scratchRepo({});
  await commitAs(inPatch, ACCOUNT_AUTHOR, GITHUB_COMMITTER, 'squash merge', 'notes about zelda\n');
  const p = await leakWithDenylist(inPatch, '--history');
  assert.equal(p.code, 1, p.printed);
  assert.ok(p.lines.some((l) => /^✗ commit [0-9a-f]{7}:\d+: denylist$/.test(l) && !/:1: denylist$/.test(l)), p.printed);
});

test("a generic-rule finding on a GitHub-made commit's author line is still reported", async () => {
  const dir = await scratchRepo({});
  await commitAs(dir, { name: USERS + 'alice/x', email: ACCOUNT_AUTHOR.email }, GITHUB_COMMITTER, 'squash merge');
  const r = await leakWithDenylist(dir, '--all');
  assert.equal(r.code, 1, r.printed);
  assert.ok(r.lines.some((l) => /^✗ commit [0-9a-f]{7}:1: absolute user path$/.test(l)), r.printed);
  assert.ok(!r.lines.some((l) => /:1: denylist$/.test(l)), r.printed);
});

// --- record boundaries in `git log` output ----------------------------------------------------
// --all, --history and --pre-push read many commits from one `git log`. Text inside a commit (its
// message, or a file in its patch) must not end that commit's record early: what follows would be
// hidden from the scan, or read as another commit with an identity of the text's choosing.

const FIXED_MARK = '\x1eSHIPCOMMIT '; // a record separator without a per-run token

async function commitWithMessageFile(dir, message) {
  const file = join(await tempDir(), 'message');
  await writeFile(file, message);
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '--quiet', '--allow-empty', '-F', file);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

// Every mode that reads commits, pushing `tip` to a remote that has none of them.
const commitModes = (tip) => [
  { mode: '--all', args: ['--all'] },
  { mode: '--history', args: ['--history'] },
  { mode: '--pre-push', args: ['--pre-push', 'origin'], stdin: () => Readable.from([`refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`]) },
];

test('a git log that does not split into the commits rev-list names is refused, not guessed at', () => {
  const mark = '\x1eM ';
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(40));
  const rec = (sha, text) => `${mark}${sha}\n${text}`;
  assert.deepEqual(parseCommitLog(rec(a, 'one\n') + rec(b, 'two\n'), mark, [a, b]), [{ sha: a, text: 'one\n' }, { sha: b, text: 'two\n' }]);
  assert.deepEqual(parseCommitLog('', mark, []), []);
  for (const [why, raw, shas] of [
    ['unknown commit', rec(a, 'one\n') + rec(c, 'forged\n'), [a]],
    ['repeated commit', rec(a, 'one\n') + rec(a, 'forged\n'), [a]],
    ['missing commit', rec(a, 'one\n'), [a, b]],
    ['text before the first record', 'stray\n' + rec(a, 'one\n'), [a]],
    ['record without a line break', `${mark}${a}`, [a]],
  ]) assert.throws(() => parseCommitLog(raw, mark, shas), /does not split/, why);
});

test('a record separator in a commit message hides nothing from the commits it is in', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const tip = await commitWithMessageFile(dir, `subject\n\n${FIXED_MARK}${LEAKY}`);
  for (const { mode, args, stdin } of commitModes(tip)) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
    const printed = c.lines.join('\n');
    assert.equal(code, 1, `${mode}: ${printed}`);
    // line 1 author, 2 committer, 3 subject, 4 blank, 5 the separator and the address
    assert.ok(c.lines.includes(`✗ commit ${tip.slice(0, 7)}:5: e-mail address`), `${mode}: ${printed}`);
  }
});

test('a record separator in a committed file hides nothing from --history and --pre-push', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeAll(dir, { 'b.txt': `${FIXED_MARK}${LEAKY}` });
  const tip = await commitAll(dir, 'two');
  for (const { mode, args, stdin } of commitModes(tip).filter((m) => m.mode !== '--all')) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
    const printed = c.lines.join('\n');
    assert.equal(code, 1, `${mode}: ${printed}`);
    assert.ok(c.lines.some((l) => new RegExp(`^✗ commit ${tip.slice(0, 7)}:\\d+: e-mail address$`).test(l)), `${mode}: ${printed}`);
  }
});

test("a commit message cannot forge a record of its own, nor earn a GitHub-made commit's exemption", async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const ident = ({ name, email }) => `${name} <${email}>`;
  const forged = ['f'.repeat(40), ident(ACCOUNT_AUTHOR), ident(GITHUB_COMMITTER), '', 'forged body'].join('\n');
  const tip = await commitWithMessageFile(dir, `subject\n\n${FIXED_MARK}${forged}\n`);
  for (const { mode, args, stdin } of commitModes(tip)) {
    const r = await leakWithDenylist(dir, args, ['zelda'], stdin?.());
    assert.equal(r.code, 1, `${mode}: ${r.printed}`);
    // the forged author line is line 6 of the real commit's message, not line 1 of a commit "fffffff"
    assert.ok(r.lines.includes(`✗ commit ${tip.slice(0, 7)}:6: denylist`), `${mode}: ${r.printed}`);
    assert.ok(r.lines.every((l) => !l.startsWith('✗ commit ') || l.startsWith(`✗ commit ${tip.slice(0, 7)}:`)), `${mode}: ${r.printed}`);
  }
});

// --- where the guard is started ---------------------------------------------------------------
// From a subdirectory, git reads less than the repository: `ls-files` lists that directory alone,
// and with diff.relative set, `diff` and `log -p` show only its changes. A manual run from there
// must still read the whole repository.

async function repoWithSubdir() {
  const dir = await scratchRepo({ 'top.txt': LEAKY });
  await mkdir(join(dir, 'sub'));
  await writeAll(dir, { 'sub/s.txt': 'clean\n' });
  const tip = await commitAll(dir);
  return { dir, sub: join(dir, 'sub'), tip };
}

test('--all and --staged read the whole repository when run from a subdirectory', async () => {
  const { dir, sub } = await repoWithSubdir();
  const all = collect();
  assert.equal(await runLeak(['--all', '--generic-only'], { cwd: sub, out: all.out }), 1, all.lines.join('\n'));
  assert.ok(all.lines.includes('✗ top.txt:1: e-mail address'), all.lines.join('\n'));

  await writeAll(dir, { 'other.txt': LEAKY, 'sub/new.txt': LEAKY });
  await git(dir, 'add', '-A');
  const staged = collect();
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: sub, out: staged.out }), 1, staged.lines.join('\n'));
  assert.deepEqual(staged.lines, ['✗ other.txt:1: e-mail address', '✗ sub/new.txt:1: e-mail address']);
});

test('diff.relative does not narrow a scan run from a subdirectory', async () => {
  const { dir, sub, tip } = await repoWithSubdir();
  await git(dir, 'config', 'diff.relative', 'true');
  for (const { mode, args, stdin } of commitModes(tip).filter((m) => m.mode !== '--all')) {
    const c = collect();
    const printed = () => `${mode}: ${c.lines.join('\n')}`;
    assert.equal(await runLeak([...args, '--generic-only'], { cwd: sub, out: c.out, stdin: stdin?.() }), 1, printed());
    assert.ok(c.lines.some((l) => new RegExp(`^✗ commit ${tip.slice(0, 7)}:\\d+: e-mail address$`).test(l)), printed());
  }
  await writeAll(dir, { 'other.txt': LEAKY });
  await git(dir, 'add', '-A');
  const c = collect();
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: sub, out: c.out }), 1, c.lines.join('\n'));
  assert.deepEqual(c.lines, ['✗ other.txt:1: e-mail address']);
});

test('a bare repository: the commit modes read it, --all and --staged refuse instead of passing', async () => {
  const { dir, tip } = await repoWithSubdir();
  const bare = join(await tempDir('bare-'), 'repo.git');
  await capture('git', ['clone', '--quiet', '--bare', dir, bare]);
  for (const { mode, args, stdin } of commitModes(tip).filter((m) => m.mode !== '--all')) {
    const c = collect();
    const printed = () => `${mode}: ${c.lines.join('\n')}`;
    assert.equal(await runLeak([...args, '--generic-only'], { cwd: bare, out: c.out, stdin: stdin?.() }), 1, printed());
    assert.ok(c.lines.some((l) => new RegExp(`^✗ commit ${tip.slice(0, 7)}:\\d+: e-mail address$`).test(l)), printed());
  }
  // no work tree, so no index: an empty file list must not pass for a clean one
  for (const mode of ['--all', '--staged']) {
    const c = collect();
    assert.equal(await runLeak([mode, '--generic-only'], { cwd: bare, out: c.out }), 1, mode);
    assert.ok(c.lines.some((l) => l.includes('cannot verify')), `${mode}: ${c.lines.join('\n')}`);
  }
});
