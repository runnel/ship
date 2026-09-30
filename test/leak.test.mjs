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

async function scratchRepo(files = {}, init = []) {
  const dir = await tempDir('leak-');
  await capture('git', ['init', '--quiet', '--initial-branch=main', ...init, dir]);
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
  { mode: '--pre-push', args: ['--pre-push', 'origin'], stdin: () => Readable.from([`refs/heads/main ${tip} refs/heads/main ${'0'.repeat(tip.length)}\n`]) },
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

// --- what a push sends that `git log -p` leaves out -------------------------------------------
// A merge's own changes, annotated tags, and blobs or trees that a ref names are published like any
// commit; the scan must read them, and read file names as they are stored.

const zeros = (sha) => '0'.repeat(sha.length);
const commitFindings = (lines, sha, rule) => lines.filter((l) => new RegExp(`^✗ commit ${sha.slice(0, 7)}:\\d+: ${rule}$`).test(l));

// main and a side branch each add a file; `resolve` then edits the merge before it is committed.
async function mergeSide(dir, resolve) {
  await git(dir, 'checkout', '--quiet', '-b', 'side');
  await writeAll(dir, { 'side.txt': 'side\n' });
  await commitAll(dir, 'side');
  await git(dir, 'checkout', '--quiet', 'main');
  await writeAll(dir, { 'main.txt': 'main\n' });
  await commitAll(dir, 'main');
  await git(dir, 'merge', '--quiet', '--no-ff', '--no-commit', 'side');
  await resolve();
  return commitAll(dir, 'merge side');
}

test('text that a merge commit adds itself (an "evil merge") is scanned by --history and --pre-push', async () => {
  const dir = await scratchRepo({ 'a.txt': 'one\ntwo\n' });
  await commitAll(dir, 'root');
  const merge = await mergeSide(dir, () => writeAll(dir, {
    'a.txt': 'one\n' + LEAKY, // a line the merge changed
    'new.txt': LEAKY, // a file the merge added
    'late.txt': 'x'.repeat(9000) + '\nok\0 ' + LEAKY, // text to git, but a combined diff cuts the line at the NUL
  }));
  const m = merge.slice(0, 7);
  for (const { mode, args, stdin } of commitModes(merge).filter((x) => x.mode !== '--all')) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
    const printed = c.lines.join('\n');
    assert.equal(code, 1, `${mode}: ${printed}`);
    assert.deepEqual(c.lines.toSorted(), [
      `✗ merge ${m} a.txt:2: e-mail address`,
      `✗ merge ${m} late.txt:0: binary file — not scannable`,
      `✗ merge ${m} new.txt:1: e-mail address`,
    ], `${mode}: ${printed}`);
  }
});

test('a binary file that a merge commit adds itself is a finding, and one it deletes is not', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await writeFile(join(dir, 'old.bin'), Buffer.from('old\0bin\n'));
  const root = await commitAll(dir, 'root');
  const merge = await mergeSide(dir, async () => {
    await rm(join(dir, 'old.bin')); // deleting a binary publishes nothing
    await writeFile(join(dir, 'new.bin'), Buffer.from('bin\0ary ' + LEAKY));
  });
  // the remote has the root commit, so the push is side, main and the merge
  const push = async (binaryAllow) => {
    const c = collect();
    const stdin = Readable.from([`refs/heads/main ${merge} refs/heads/main ${root}\n`]);
    const code = await runLeak(['--pre-push', 'origin', '--generic-only'], { cwd: dir, out: c.out, stdin, binaryAllow });
    return { code, lines: c.lines, printed: c.lines.join('\n') };
  };
  const r = await push([]);
  assert.equal(r.code, 1, r.printed);
  assert.deepEqual(r.lines, [`✗ merge ${merge.slice(0, 7)} new.bin:0: binary file — not scannable`], r.printed);
  assert.equal((await push(['new.bin'])).code, 0);
});

test('--history and --all leave a stash alone: local work that a push does not send', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeAll(dir, { 'a.txt': LEAKY }); // an unstaged edit, then stashed
  await git(dir, 'stash', '--quiet');
  for (const mode of ['--history', '--all']) {
    const c = collect();
    assert.equal(await runLeak([mode, '--generic-only'], { cwd: dir, out: c.out }), 0, `${mode}: ${c.lines.join('\n')}`);
  }
});

test('an annotated tag is scanned: its tagger line and its message', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const tip = await commitAll(dir, 'one');
  await git(dir, 'update-ref', 'refs/remotes/origin/main', tip); // the commit itself is on the remote
  await git(dir, '-c', 'user.email=' + 'bob' + AT + 'corp.ee', 'tag', '-a', '-m', 'release\n\n' + LEAKY, 'v1');
  const tag = (await git(dir, 'rev-parse', 'v1')).trim();
  const modes = [
    { mode: '--all', args: ['--all'] },
    { mode: '--history', args: ['--history'] },
    { mode: '--pre-push', args: ['--pre-push', 'origin'], stdin: () => Readable.from([`refs/tags/v1 ${tag} refs/tags/v1 ${zeros(tag)}\n`]) },
  ];
  for (const { mode, args, stdin } of modes) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
    const printed = c.lines.join('\n');
    assert.equal(code, 1, `${mode}: ${printed}`);
    // line 1 object, 2 type, 3 tag name, 4 tagger, 5 blank, 6 subject, 7 blank, 8 the address
    assert.deepEqual(c.lines, [`✗ tag ${tag.slice(0, 7)}:4: e-mail address`, `✗ tag ${tag.slice(0, 7)}:8: e-mail address`], `${mode}: ${printed}`);
  }
});

test('a blob or a tree that a ref or a tag names is scanned, through nested tags too', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const tip = await commitAll(dir, 'one');
  await git(dir, 'update-ref', 'refs/remotes/origin/main', tip);
  const loose = join(await tempDir(), 'loose.txt');
  await writeFile(loose, 'blob ' + LEAKY);
  const blob = (await git(dir, 'hash-object', '-w', loose)).trim();
  await writeAll(dir, { 'in-tree.txt': 'tree ' + LEAKY });
  await git(dir, 'add', 'in-tree.txt');
  const tree = (await git(dir, 'write-tree')).trim(); // a tree no commit has
  await git(dir, 'rm', '--quiet', '--cached', 'in-tree.txt');
  await rm(join(dir, 'in-tree.txt'));
  await git(dir, 'tag', 'plain', blob); // a lightweight tag: the ref names the blob itself
  await git(dir, 'tag', '-a', '-m', 'a tree', 'tree-tag', tree);
  await git(dir, 'tag', '-a', '-m', 'inner', 'inner', blob);
  await git(dir, 'tag', '-a', '-m', 'outer', 'outer', 'inner');
  await git(dir, 'tag', '-d', 'inner'); // only the outer tag still leads to it
  const refs = await Promise.all(['plain', 'tree-tag', 'outer'].map(async (t) => [t, (await git(dir, 'rev-parse', t)).trim()]));
  const pushLines = refs.map(([t, sha]) => `refs/tags/${t} ${sha} refs/tags/${t} ${zeros(sha)}\n`);
  for (const [mode, args, stdin] of [['--all', ['--all']], ['--history', ['--history']], ['--pre-push', ['--pre-push', 'origin'], pushLines]]) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin && Readable.from(stdin) });
    const printed = c.lines.join('\n');
    assert.equal(code, 1, `${mode}: ${printed}`);
    assert.deepEqual(c.lines.toSorted(), [`✗ blob ${blob.slice(0, 7)}:1: e-mail address`, '✗ in-tree.txt:1: e-mail address'], `${mode}: ${printed}`);
  }
});

test('a denylisted term with non-ASCII letters in a file name is found in history (core.quotePath)', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await git(dir, 'config', 'core.quotePath', 'true'); // git's default, pinned against the user's own config
  await commitAll(dir, 'one');
  await writeAll(dir, { 'zebrä-notes.txt': 'clean\n' });
  const tip = await commitAll(dir, 'two');
  for (const { mode, args, stdin } of commitModes(tip).filter((m) => m.mode !== '--all')) {
    const r = await leakWithDenylist(dir, args, ['zebrä'], stdin?.());
    assert.equal(r.code, 1, `${mode}: ${r.printed}`);
    assert.ok(commitFindings(r.lines, tip, 'denylist').length > 0, `${mode}: ${r.printed}`);
  }
});

// --- local state and config -------------------------------------------------------------------
// What a push sends is the stored objects. A clone's own state (replace refs, grafts) or config
// (log.showRoot, textconv, diff.relative, message encodings) must not change what the scan reads.

async function expectLeakIn(dir, sha, modes, { cwd = dir } = {}) {
  for (const { mode, args, stdin } of modes) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd, out: c.out, stdin: stdin?.() });
    const printed = c.lines.join('\n');
    assert.equal(code, 1, `${mode}: ${printed}`);
    assert.ok(commitFindings(c.lines, sha, 'e-mail address').length > 0, `${mode}: ${printed}`);
  }
}

test('replace refs hide nothing: the scan reads the commits and blobs a push sends', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeAll(dir, { 'b.txt': LEAKY });
  const leaky = await commitAll(dir, 'two ' + LEAKY);
  const leakyBlob = (await git(dir, 'rev-parse', ':b.txt')).trim();
  const stand = join(await tempDir(), 'clean.txt');
  await writeFile(stand, 'clean\n');
  const cleanBlob = (await git(dir, 'hash-object', '-w', stand)).trim();
  const cleanCommit = (await git(dir, 'commit-tree', '-p', 'HEAD^', '-m', 'two', 'HEAD^^{tree}')).trim();
  await git(dir, 'replace', leaky, cleanCommit);
  await git(dir, 'replace', leakyBlob, cleanBlob);
  await expectLeakIn(dir, leaky, commitModes(leaky));
  const c = collect();
  await runLeak(['--all', '--generic-only'], { cwd: dir, out: c.out });
  assert.ok(c.lines.includes('✗ b.txt:1: e-mail address'), c.lines.join('\n')); // the committed blob itself

  await writeAll(dir, { 'staged.txt': 'staged ' + LEAKY }); // a blob of its own
  await git(dir, 'add', 'staged.txt');
  await git(dir, 'replace', (await git(dir, 'rev-parse', ':staged.txt')).trim(), cleanBlob);
  const s = collect();
  assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: dir, out: s.out }), 1, s.lines.join('\n'));
  assert.ok(s.lines.includes('✗ staged.txt:1: e-mail address'), s.lines.join('\n'));
});

test('grafts hide nothing: every commit a push sends is scanned', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const base = await commitAll(dir, 'one');
  await writeAll(dir, { 'b.txt': LEAKY });
  const leaky = await commitAll(dir, 'two');
  await writeAll(dir, { 'b.txt': 'clean\n' });
  const tip = await commitAll(dir, 'three');
  await writeFile(join(dir, '.git', 'info', 'grafts'), `${tip} ${base}\n`); // "three" claims "one" as its parent
  const pushFrom = (remoteSha) => () => Readable.from([`refs/heads/main ${tip} refs/heads/main ${remoteSha}\n`]);
  await expectLeakIn(dir, leaky, [
    { mode: '--history', args: ['--history'] },
    { mode: '--pre-push (remote at "one")', args: ['--pre-push', 'origin'], stdin: pushFrom(base) },
    { mode: '--pre-push (new branch)', args: ['--pre-push', 'origin'], stdin: pushFrom(zeros(tip)) },
  ]);
});

test('diff.srcPrefix and diff.dstPrefix hide nothing: a binary file at dev/null is still a finding', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await git(dir, 'config', 'diff.dstPrefix', '/'); // "b/dev/null" would read "/dev/null", as for a deleted file
  await mkdir(join(dir, 'dev'));
  await writeFile(join(dir, 'dev', 'null'), Buffer.from('bin\0ary ' + LEAKY));
  const tip = await commitAll(dir, 'two');
  for (const { mode, args, stdin } of commitModes(tip).filter((m) => m.mode !== '--all')) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
    assert.equal(code, 1, `${mode}: ${c.lines.join('\n')}`);
    assert.equal(commitFindings(c.lines, tip, 'binary file — not scannable').length, 1, `${mode}: ${c.lines.join('\n')}`);
  }
});

test("log.showRoot=false hides nothing: the root commit's patch is scanned", async () => {
  const dir = await scratchRepo({ 'a.txt': LEAKY });
  await git(dir, 'config', 'log.showRoot', 'false');
  const root = await commitAll(dir, 'root');
  await expectLeakIn(dir, root, commitModes(root).filter((m) => m.mode !== '--all'));
});

test('a textconv driver hides nothing: the patch shows the stored text', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await writeFile(join(dir, '.git', 'info', 'attributes'), '*.txt diff=blank\n');
  await git(dir, 'config', 'diff.blank.textconv', 'true'); // shows every file as empty
  await writeAll(dir, { 'b.txt': LEAKY });
  const tip = await commitAll(dir, 'two');
  await expectLeakIn(dir, tip, commitModes(tip).filter((m) => m.mode !== '--all'));
});

test('diff.relative hides nothing when the guard runs in a subdirectory', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  await mkdir(join(dir, 'sub'));
  await writeAll(dir, { 'sub/s.txt': 'clean\n' });
  await commitAll(dir, 'one');
  await git(dir, 'config', 'diff.relative', 'true');
  await writeAll(dir, { 'b.txt': LEAKY });
  const tip = await commitAll(dir, 'two');
  await expectLeakIn(dir, tip, commitModes(tip).filter((m) => m.mode !== '--all'), { cwd: join(dir, 'sub') });
});

test('i18n.logOutputEncoding does not change what is scanned', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const tip = await commitWithMessageFile(dir, `subject\n\n${LEAKY}`);
  await git(dir, 'config', 'i18n.logOutputEncoding', 'UTF-16');
  for (const { mode, args, stdin } of commitModes(tip)) {
    const c = collect();
    const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
    assert.equal(code, 1, `${mode}: ${c.lines.join('\n')}`);
    assert.ok(c.lines.includes(`✗ commit ${tip.slice(0, 7)}:5: e-mail address`), `${mode}: ${c.lines.join('\n')}`);
  }
});

test('a commit message stored in another encoding is a finding: git would show it re-encoded', async () => {
  const dir = await scratchRepo({ 'a.txt': 'clean\n' });
  const file = join(await tempDir(), 'message');
  await writeFile(file, `subject ${LEAKY}`);
  // EBCDIC: re-encoded for display, the ASCII text of the message and of the author line is gone
  await git(dir, '-c', 'i18n.commitEncoding=CP037', 'commit', '--quiet', '--allow-empty', '-F', file);
  const tip = (await git(dir, 'rev-parse', 'HEAD')).trim();
  for (const config of ['made elsewhere', 'still configured']) {
    if (config === 'still configured') await git(dir, 'config', 'i18n.commitEncoding', 'CP037');
    for (const { mode, args, stdin } of commitModes(tip)) {
      const c = collect();
      const code = await runLeak([...args, '--generic-only'], { cwd: dir, out: c.out, stdin: stdin?.() });
      const printed = `${config}, ${mode}: ${c.lines.join('\n')}`;
      assert.equal(code, 1, printed);
      assert.ok(c.lines.includes(`✗ commit ${tip.slice(0, 7)}:0: message encoding is not UTF-8 — not scannable`), printed);
    }
  }
});

// --- sha256 repositories ----------------------------------------------------------------------

test('a sha256 repository: line numbers hold, and a commit GitHub made keeps its exemption', async () => {
  const dir = await scratchRepo({}, ['--object-format=sha256']);
  await commitAs(dir, ACCOUNT_AUTHOR, GITHUB_COMMITTER, 'squash merge');
  const tip = await commitWithMessageFile(dir, 'subject\n\nnotes about zelda\n');
  assert.equal(tip.length, 64);
  for (const { mode, args, stdin } of commitModes(tip)) {
    const r = await leakWithDenylist(dir, args, ['zelda'], stdin?.());
    assert.equal(r.code, 1, `${mode}: ${r.printed}`);
    // line 1 author, 2 committer, 3 subject, 4 blank, 5 the term; the GitHub-made commit is clean
    assert.deepEqual(r.lines, [`✗ commit ${tip.slice(0, 7)}:5: denylist`], `${mode}: ${r.printed}`);
  }
});

// --- where the guard is started ---------------------------------------------------------------
// From a subdirectory, git reads less than the repository: `ls-files` lists that directory alone,
// and with diff.relative set, `diff` shows only its changes (and `log -p` would, unless told not to).
// A manual run from there must still read the whole repository.

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
  for (const relative of ['false', 'true']) { // diff.relative would narrow `git diff --cached` too
    await git(dir, 'config', 'diff.relative', relative);
    const staged = collect();
    assert.equal(await runLeak(['--staged', '--generic-only'], { cwd: sub, out: staged.out }), 1, `diff.relative=${relative}: ${staged.lines.join('\n')}`);
    assert.deepEqual(staged.lines, ['✗ other.txt:1: e-mail address', '✗ sub/new.txt:1: e-mail address'], `diff.relative=${relative}`);
  }
});

test('a tree that a ref names is read whole when it is pushed from a subdirectory', async () => {
  const { dir, sub } = await repoWithSubdir();
  const tree = (await git(dir, 'rev-parse', 'HEAD^{tree}')).trim();
  await git(dir, 'update-ref', 'refs/trees/t', tree);
  const c = collect();
  const stdin = Readable.from([`refs/trees/t ${tree} refs/trees/t ${zeros(tree)}\n`]);
  assert.equal(await runLeak(['--pre-push', 'origin', '--generic-only'], { cwd: sub, out: c.out, stdin }), 1, c.lines.join('\n'));
  assert.deepEqual(c.lines, ['✗ top.txt:1: e-mail address']);
});

// Git resolves a relative GIT_DIR or GIT_WORK_TREE against the directory it starts in. Started
// from inner/sub, these name inner; resolved from inner's top level, they would name outer.
test('a relative GIT_DIR and GIT_WORK_TREE name the same repository from the top level', async () => {
  const outer = await scratchRepo({ 'a.txt': 'clean\n' });
  await commitAll(outer);
  const inner = join(outer, 'inner');
  await capture('git', ['init', '--quiet', '--initial-branch=main', inner]);
  for (const [key, value] of [['user.name', 'x'], ['user.email', NOREPLY], ['commit.gpgsign', 'false']]) await git(inner, 'config', key, value);
  await mkdir(join(inner, 'sub'));
  await writeAll(inner, { 'top.txt': LEAKY, 'sub/s.txt': 'clean\n' });
  await commitAll(inner);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  Object.assign(process.env, { GIT_DIR: '../.git', GIT_WORK_TREE: '..' });
  try {
    const c = collect();
    assert.equal(await runLeak(['--all', '--generic-only'], { cwd: join(inner, 'sub'), out: c.out }), 1, c.lines.join('\n'));
    assert.ok(c.lines.includes('✗ top.txt:1: e-mail address'), c.lines.join('\n'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a bare repository: the commit modes read it, --all and --staged refuse instead of passing', async () => {
  const { dir, tip } = await repoWithSubdir();
  const bare = join(await tempDir('bare-'), 'repo.git');
  await capture('git', ['clone', '--quiet', '--bare', dir, bare]);
  await expectLeakIn(bare, tip, commitModes(tip).filter((m) => m.mode !== '--all'));
  // no work tree, so no index: an empty file list must not pass for a clean one
  for (const mode of ['--all', '--staged']) {
    const c = collect();
    assert.equal(await runLeak([mode, '--generic-only'], { cwd: bare, out: c.out }), 1, mode);
    assert.ok(c.lines.some((l) => l.includes('cannot verify')), `${mode}: ${c.lines.join('\n')}`);
  }
});
