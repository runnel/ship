import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { capture } from './proc.mjs';
import { matchesAny } from './glob.mjs';

const GITHUB_ACCOUNT_NOREPLY = /@users\.noreply\.github\.com$/i; // GitHub's per-account address form
const GITHUB_COMMITTER = 'GitHub <noreply@github.com>'; // the committer line of every commit GitHub makes

export const EMAIL_ALLOW = [
  /@example\.(com|org|net)$/i,
  /^noreply@anthropic\.com$/i,
  GITHUB_ACCOUNT_NOREPLY,
  /^git@github\.com$/i, // the user part of an SSH remote, not a person
  /^noreply@github\.com$/i, // the committer of every merge made in GitHub's web UI or by `gh pr merge`
];

// Generic shapes that must never reach this public repository. Findings report the rule and the
// line, never the matched text, so a CI log cannot republish what it caught.
export const GENERIC_RULES = [
  { name: 'absolute user path', re: /\/Users\/[A-Za-z0-9._-]+\//g },
  { name: 'absolute home path', re: /\/home\/[A-Za-z0-9._-]+\//g },
  { name: 'e-mail address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, allow: (m) => EMAIL_ALLOW.some((r) => r.test(m)) },
  { name: 'Supabase project URL', re: /\b[a-z0-9]{20}\.supabase\.co\b/g },
  { name: 'Cloudflare account id', re: /\b[0-9a-f]{32}\b/g },
  { name: 'named workers.dev subdomain', re: /\b([a-z0-9-]+)\.workers\.dev\b/g, allow: (m, sub) => sub === 'example' },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Stripe live key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { name: 'Slack token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/g },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

// Whole-word match: a short first name must not fire inside an ordinary word.
const termRegExp = (term) => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');

export function scanText(text, { denylist = [], source = '' } = {}) {
  const terms = denylist.map(termRegExp);
  const findings = [];
  text.split('\n').forEach((line, i) => {
    for (const rule of GENERIC_RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.allow && rule.allow(m[0], m[1])) continue;
        findings.push({ source, line: i + 1, rule: rule.name });
      }
    }
    for (const re of terms) if (re.test(line)) findings.push({ source, line: i + 1, rule: 'denylist' });
  });
  return findings;
}

// One term per line (project, client and people names, service refs). Lives outside the repo:
// committing it would be the leak it exists to prevent. Missing file = refuse, not pass.
export async function loadDenylist(path = process.env.SHIP_DENYLIST ?? join(homedir(), '.config', 'ship', 'denylist')) {
  const raw = await readFile(path, 'utf8');
  const terms = raw.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
  if (terms.length === 0) throw new Error(`${path} is empty`); // a guard with nothing to look for guards nothing
  return terms;
}

async function readStdin(stream) {
  let data = '';
  for await (const chunk of stream) data += chunk;
  return data;
}

// Blobs that may be binary (root-anchored globs, see glob.mjs). Empty on purpose: a binary file
// cannot be scanned for the shapes above, so it is reported unless someone names it here.
export const BINARY_ALLOW = [];

const ZERO = /^0+$/;
const NUL = '\u0000';
const BINARY_RULE = 'binary file — not scannable';
const ENCODING_RULE = 'message encoding is not UTF-8 — not scannable';
const UTF8 = /^utf-?8$/i;

const hasCommit = (git, sha) => git(['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

// For the commits it creates itself (a squash or merge commit from the web UI or `gh pr merge`),
// GitHub fills the author line from the account: a display name that is public anyway, with the
// account's noreply address. (A "Rebase and merge" keeps the pull request commits' own authors,
// which were scanned on the branch.) Such a commit is recognised by the exact GitHub committer
// line plus that address form. Both are self-asserted, so neither is proof of origin: a local
// commit can set them too. What the match earns is small: denylist matches on the author line are
// dropped; the message, the patch and the generic rules still apply. `text` starts with the author
// line, then the committer line.
function madeByGitHub(text) {
  const [author = '', committer = ''] = text.split('\n', 2);
  const email = author.match(/<([^<>]*)>$/)?.[1] ?? '';
  return committer === GITHUB_COMMITTER && GITHUB_ACCOUNT_NOREPLY.test(email);
}

// Splits `git log` output at `mark` into one record per commit, and proves the split: each record
// must name a commit of `shas` (the same range from `git rev-list`), every one of them exactly once,
// with nothing before the first. Anything else is refused, never guessed at. The error names no
// record: a forged one would choose what a CI log prints.
export function parseCommitLog(raw, mark, shas) {
  const refuse = () => new Error('git log does not split into the commits git rev-list names');
  const [head, ...records] = raw.split(mark);
  const units = records.map((r) => {
    const nl = r.indexOf('\n'); // the format puts one right after the sha; no line break, no commit
    return nl < 0 ? { sha: '', text: r } : { sha: r.slice(0, nl), text: r.slice(nl + 1) };
  });
  const expected = new Set(shas);
  const seen = new Set();
  for (const { sha } of units) {
    if (!expected.has(sha) || seen.has(sha)) throw refuse();
    seen.add(sha);
  }
  if (head !== '' || seen.size !== expected.size) throw refuse();
  return units;
}

// Patches show the stored changes, whatever this clone's config says: the root commit's patch too
// (log.showRoot), the stored text (no textconv, no external diff: neither may start a process that
// could read the per-run mark from our arguments), the whole tree (diff.relative), and a/ and b/
// prefixes (diff.srcPrefix and diff.dstPrefix could turn a path into "/dev/null"). Merges print no
// patch here; mergeUnits reads what they change.
const PATCH = ['-p', '--diff-merges=off', '--root', '--no-textconv', '--no-ext-diff', '--no-relative', '--default-prefix'];

// One unit per commit: identity lines, message and (optionally) the patch. Git errors propagate:
// a range that cannot be read must never look like a clean one. A message or a patch can hold any
// fixed separator (a NUL too: git shows a file as text when its first 8000 bytes have none), so the
// records are marked with a token drawn for this run, which no commit can have been written to contain.
// `--no-show-signature`: with log.showSignature set, git prints signature checks outside the records.
// `--encoding=UTF-8`: i18n.logOutputEncoding (or i18n.commitEncoding) would re-encode the whole output.
// A commit whose own encoding header names anything else is re-encoded all the same, and then the
// scan would read git's conversion, not the stored bytes: such a commit is a finding.
async function commitUnits(git, revs, { patch }) {
  const mark = `\x1eSHIPCOMMIT ${randomBytes(16).toString('hex')} `;
  const shown = ['--no-show-signature', '--no-color', '--encoding=UTF-8'];
  const [raw, list] = await Promise.all([
    git(['log', ...shown, ...(patch ? PATCH : []), `--format=${mark}%H%n%an <%ae>%n%cn <%ce>%n%B`, ...revs]),
    git(['rev-list', '--encoding=UTF-8', '--no-commit-header', '--format=%H%x09%P%x09%e', ...revs]),
  ]);
  const commits = new Map(list.split('\n').filter(Boolean).map((l) => {
    const [sha, parents, ...encoding] = l.split('\t');
    return [sha, { merge: parents.includes(' '), encoding: encoding.join('\t') }];
  }));
  const units = parseCommitLog(raw, mark, [...commits.keys()]).map(({ sha, text }) => ({
    source: `commit ${sha.slice(0, 7)}`, text, kind: patch ? 'patch' : 'message', accountAuthor: madeByGitHub(text),
    foreignEncoding: commits.get(sha).encoding !== '' && !UTF8.test(commits.get(sha).encoding),
  }));
  if (patch) for (const [sha, { merge }] of commits) if (merge) units.push(...(await mergeUnits(git, sha)));
  return units;
}

// A merge's own changes are the files in which it differs from every parent: whatever else it holds
// comes from a parent. They are read whole, as stored. A combined diff (`--cc`) would cut each line
// at its first NUL and follow diff attributes, and `-m` prints a merge once per parent.
async function mergeUnits(git, merge) {
  const fields = (await git(['diff-tree', '-c', '--raw', '-r', '-z', '--no-commit-id', merge])).split('\0');
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // "::<mode per parent> <result mode> <sha per parent> <result sha> <status>", then the path
    const parents = fields[i].match(/^:+/)?.[0].length ?? 0;
    const f = fields[i].slice(parents).split(' ');
    const [mode, sha] = [f[parents], f[2 * parents + 1]];
    if (!parents || !/^[0-9a-f]+$/.test(sha ?? '')) throw new Error(`cannot read the changes of merge ${merge.slice(0, 7)}`);
    if (!ZERO.test(sha)) entries.push({ mode, sha, path: fields[i + 1] }); // a deleted file publishes nothing
  }
  return (await blobUnits(git, entries)).map((u) => ({ ...u, via: `merge ${merge.slice(0, 7)}` }));
}

// Index entries, NUL-separated so that names are never quoted.
async function indexEntries(git) {
  const raw = await git(['ls-files', '-z', '--stage']);
  return raw.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, sha] = rec.slice(0, tab).split(' ');
    return { mode, sha, path: rec.slice(tab + 1) };
  });
}

// A tree's blobs, NUL-separated like the index entries.
async function treeEntries(git, tree) {
  const raw = await git(['ls-tree', '-r', '-z', tree]);
  return raw.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    return { mode, sha, path: rec.slice(tab + 1) };
  });
}

// What is committed or staged, not what happens to be on disk. Submodule entries are not blobs.
const blobUnits = (git, entries) =>
  Promise.all(entries.filter((e) => e.mode !== '160000').map(async (e) => ({ source: e.path, sha: e.sha, text: await git(['cat-file', 'blob', e.sha]), kind: 'blob' })));

// What a ref can publish that `git log` never prints: an annotated tag (its tagger line and message)
// and a blob or tree that a ref or a tag names. Tags are followed to what they name; the commits
// they lead to are left to `git log`, which peels tags itself.
async function objectUnits(git, shas) {
  const units = [];
  const seen = new Set();
  for (const queue = [...shas]; queue.length > 0; ) {
    const sha = queue.shift();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const type = (await git(['cat-file', '-t', sha])).trim();
    if (type === 'tag') {
      const text = await git(['cat-file', 'tag', sha]);
      const target = text.match(/^object ([0-9a-f]+)\n/)?.[1];
      if (!target) throw new Error(`tag ${sha.slice(0, 7)} names no object`);
      units.push({ source: `tag ${sha.slice(0, 7)}`, text, kind: 'message' });
      queue.push(target);
    } else if (type === 'blob') {
      units.push({ source: `blob ${sha.slice(0, 7)}`, sha, text: await git(['cat-file', 'blob', sha]), kind: 'blob' });
    } else if (type === 'tree') {
      units.push(...(await blobUnits(git, await treeEntries(git, sha))));
    }
  }
  return units;
}

// Every ref that names something other than a commit.
async function refObjects(git) {
  const raw = await git(['for-each-ref', '--format=%(objectname) %(objecttype)']);
  return raw.split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, type]) => type !== 'commit').map(([sha]) => sha);
}

async function identityFindings(git) {
  const findings = [];
  for (const v of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const ident = await git(['var', v]).catch(() => '');
    const email = (ident.match(/<([^>]*)>/) ?? [])[1] ?? '';
    if (!EMAIL_ALLOW.some((r) => r.test(email))) findings.push({ source: v, line: 1, rule: 'commit identity is not a noreply address' });
  }
  return findings;
}

// `git log -p` prints a binary file as "Binary files a and b differ": its content never reaches
// the scan, so the file itself is the finding. A deleted binary was reported when it was added.
const BINARY_DIFF = /^Binary files (.+) and (.+) differ$/;
function binaryPatchFindings({ source, text }, binaryAllow) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(BINARY_DIFF);
    if (!m || m[2] === '/dev/null') return;
    if (matchesAny(m[2].replace(/^b\//, ''), binaryAllow)) return;
    found.push({ source, line: i + 1, rule: BINARY_RULE });
  });
  return found;
}

function unitFindings(unit, { denylist, binaryAllow }) {
  // A file's name is published with it. A finding about the name must not print it, and neither
  // may any other finding of that file: such a file is identified by its blob instead.
  const named = unit.kind === 'blob' ? scanText(unit.source, { denylist, source: unit.source }) : [];
  const shown = named.length ? `blob ${unit.sha.slice(0, 7)} (name withheld)` : unit.source;
  const source = unit.via ? `${unit.via} ${shown}` : shown; // e.g. the merge that holds this file
  const nameFindings = named.map((f) => ({ ...f, source, line: 0, rule: `${f.rule} (in the file name)` }));
  if (unit.kind === 'blob' && unit.text.includes(NUL)) {
    return [...nameFindings, ...(matchesAny(unit.source, binaryAllow) ? [] : [{ source, line: 0, rule: BINARY_RULE }])];
  }
  const found = [...nameFindings, ...scanText(unit.text, { denylist, source })]
    // The author line of a commit GitHub made holds public profile data: the generic rules still
    // read it, the denylist does not. The message and the patch of that commit are scanned in full.
    .filter((f) => !(unit.accountAuthor && f.line === 1 && f.rule === 'denylist'));
  if (unit.kind === 'patch') found.push(...binaryPatchFindings(unit, binaryAllow));
  if (unit.foreignEncoding) found.push({ source, line: 0, rule: ENCODING_RULE });
  return found;
}

// Every ref but refs/stash: a stash is local work (its worktree commit is a merge whose own changes
// are the unstaged edits), which a push sends only when told to, and then --pre-push reads it.
const ALL_REFS = ['--exclude=refs/stash', '--all'];

const reason = (e) => String(e?.stderr ?? '').trim().split('\n')[0] || String(e?.message ?? e).split('\n')[0];

async function collectUnits(args, { git, stdin }) {
  const units = [];
  const extra = [];
  if (args.includes('--staged')) {
    const changed = new Set((await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'])).split('\0').filter(Boolean));
    units.push(...(await blobUnits(git, (await indexEntries(git)).filter((e) => changed.has(e.path)))));
    extra.push(...(await identityFindings(git)));
  } else if (args.includes('--msg')) {
    units.push({ source: 'commit message', text: await readFile(args[args.indexOf('--msg') + 1], 'utf8'), kind: 'message' });
  } else if (args.includes('--pre-push')) {
    // The hook passes the remote's name as $1; commits already on that remote need no scan.
    const next = args[args.indexOf('--pre-push') + 1];
    const remotes = next && !next.startsWith('--') ? `--remotes=${next}` : '--remotes';
    const updates = (await readStdin(stdin)).split('\n').filter(Boolean).map((line) => line.split(' '))
      .filter(([, localSha]) => !ZERO.test(localSha)); // deleting a remote ref
    units.push(...(await objectUnits(git, updates.map(([, localSha]) => localSha))));
    for (const [, localSha, , remoteSha] of updates) {
      // A remote tip that is not in the local object store (a force push after "Update branch",
      // a commit made on GitHub) cannot bound the range: scan everything not on the remote.
      const known = !ZERO.test(remoteSha) && (await hasCommit(git, remoteSha));
      units.push(...(await commitUnits(git, known ? [`${remoteSha}..${localSha}`] : [localSha, '--not', remotes], { patch: true })));
    }
  } else if (args.includes('--all')) {
    units.push(...(await blobUnits(git, await indexEntries(git))));
    units.push(...(await commitUnits(git, ALL_REFS, { patch: false })));
    units.push(...(await objectUnits(git, await refObjects(git))));
  } else if (args.includes('--history')) {
    units.push(...(await commitUnits(git, ALL_REFS, { patch: true })));
    units.push(...(await objectUnits(git, await refObjects(git))));
  }
  return { units, extra };
}

export async function runLeak(args, { cwd = process.cwd(), out = (s) => process.stdout.write(`${s}\n`), stdin = process.stdin, binaryAllow = BINARY_ALLOW } = {}) {
  const MODES = ['--staged', '--msg', '--pre-push', '--all', '--history'];
  if (!MODES.some((m) => args.includes(m))) {
    out('usage: ship leak --staged | --msg <file> | --pre-push [remote] | --all | --history [--generic-only]');
    return 2;
  }
  const genericOnly = args.includes('--generic-only');
  let denylist = [];
  if (!genericOnly) {
    try {
      denylist = await loadDenylist();
    } catch {
      out('✗ leak guard: ~/.config/ship/denylist is missing (one term per line) — refusing to pass');
      return 1;
    }
  }
  // Every call reads the objects as stored, whatever this clone's state says about showing them:
  // replace refs and grafts put other commits and blobs in their place (the graft file is a path
  // that cannot exist, /dev/null being no directory), and core.quotePath escapes non-ASCII names.
  const env = { ...process.env, GIT_GRAFT_FILE: '/dev/null/no-grafts' };
  const git = (a) => capture('git', ['--no-replace-objects', '-c', 'core.quotePath=false', '-C', cwd, ...a], { env });
  let collected;
  try {
    collected = await collectUnits(args, { git, stdin });
  } catch (e) {
    out(`✗ leak guard: cannot verify (${reason(e)}) — refusing to pass`);
    return 1;
  }
  const findings = [...collected.extra, ...collected.units.flatMap((u) => unitFindings(u, { denylist, binaryAllow }))];
  for (const f of findings) out(`✗ ${f.source}:${f.line}: ${f.rule}`);
  if (findings.length === 0) out('✓ leak guard: clean');
  return findings.length ? 1 : 0;
}
