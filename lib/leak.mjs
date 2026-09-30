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
const MARK = '\x1eSHIPCOMMIT ';
const NUL = '\u0000';
const BINARY_RULE = 'binary file — not scannable';

const hasCommit = (git, sha) => git(['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);

// GitHub fills the author of the commits it makes (a web merge, `gh pr merge`) from the account's
// profile: a display name that is public anyway, with the account's noreply address. Such a
// commit is recognised by both the exact GitHub committer line and that address form, so a local
// commit cannot borrow the exemption with a look-alike identity. `text` starts with the author
// line, then the committer line.
function madeByGitHub(text) {
  const [author = '', committer = ''] = text.split('\n', 2);
  const email = author.match(/<([^<>]*)>$/)?.[1] ?? '';
  return committer === GITHUB_COMMITTER && GITHUB_ACCOUNT_NOREPLY.test(email);
}

// One unit per commit: identity lines, message and (optionally) the patch. Git errors propagate:
// a range that cannot be read must never look like a clean one.
async function commitUnits(git, revs, { patch }) {
  const raw = await git(['log', ...(patch ? ['-p'] : []), '--format=%x1eSHIPCOMMIT %H%n%an <%ae>%n%cn <%ce>%n%B', ...revs]);
  return raw.split(MARK).filter((c) => c.trim()).map((c) => {
    const text = c.slice(41);
    return { source: `commit ${c.slice(0, 7)}`, text, kind: patch ? 'patch' : 'message', accountAuthor: madeByGitHub(text) };
  });
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

// What is committed or staged, not what happens to be on disk. Submodule entries are not blobs.
const blobUnits = (git, entries) =>
  Promise.all(entries.filter((e) => e.mode !== '160000').map(async (e) => ({ source: e.path, sha: e.sha, text: await git(['cat-file', 'blob', e.sha]), kind: 'blob' })));

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
  const source = named.length ? `blob ${unit.sha.slice(0, 7)} (name withheld)` : unit.source;
  const nameFindings = named.map((f) => ({ ...f, source, line: 0, rule: `${f.rule} (in the file name)` }));
  if (unit.kind === 'blob' && unit.text.includes(NUL)) {
    return [...nameFindings, ...(matchesAny(unit.source, binaryAllow) ? [] : [{ source, line: 0, rule: BINARY_RULE }])];
  }
  const found = [...nameFindings, ...scanText(unit.text, { denylist, source })]
    // The author line of a commit GitHub made holds public profile data: the generic rules still
    // read it, the denylist does not. The message and the patch of that commit are scanned in full.
    .filter((f) => !(unit.accountAuthor && f.line === 1 && f.rule === 'denylist'));
  if (unit.kind === 'patch') found.push(...binaryPatchFindings(unit, binaryAllow));
  return found;
}

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
    for (const line of (await readStdin(stdin)).split('\n').filter(Boolean)) {
      const [, localSha, , remoteSha] = line.split(' ');
      if (ZERO.test(localSha)) continue; // deleting a remote ref
      // A remote tip that is not in the local object store (a force push after "Update branch",
      // a commit made on GitHub) cannot bound the range: scan everything not on the remote.
      const known = !ZERO.test(remoteSha) && (await hasCommit(git, remoteSha));
      units.push(...(await commitUnits(git, known ? [`${remoteSha}..${localSha}`] : [localSha, '--not', remotes], { patch: true })));
    }
  } else if (args.includes('--all')) {
    units.push(...(await blobUnits(git, await indexEntries(git))));
    units.push(...(await commitUnits(git, ['--all'], { patch: false })));
  } else if (args.includes('--history')) {
    units.push(...(await commitUnits(git, ['--all'], { patch: true })));
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
  const git = (a) => capture('git', ['-C', cwd, ...a]);
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
