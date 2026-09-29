import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { capture } from './proc.mjs';

export const EMAIL_ALLOW = [
  /@example\.(com|org|net)$/i,
  /^noreply@anthropic\.com$/i,
  /@users\.noreply\.github\.com$/i,
  /^git@github\.com$/i, // the user part of an SSH remote, not a person
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
  return raw.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
}

async function readStdin(stream) {
  let data = '';
  for await (const chunk of stream) data += chunk;
  return data;
}

const ZERO = /^0+$/;
const MARK = '\x1eSHIPCOMMIT ';

// One [source, text] per commit: identity lines, message and (optionally) the patch.
async function commitTexts(git, revs, { patch }) {
  const raw = await git(['log', ...(patch ? ['-p'] : []), '--format=%x1eSHIPCOMMIT %H%n%an <%ae>%n%cn <%ce>%n%B', ...revs]).catch(() => '');
  return raw.split(MARK).filter((c) => c.trim()).map((c) => [`commit ${c.slice(0, 7)}`, c.slice(41)]);
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

export async function runLeak(args, { cwd = process.cwd(), out = (s) => process.stdout.write(`${s}\n`), stdin = process.stdin } = {}) {
  const MODES = ['--staged', '--msg', '--pre-push', '--all', '--history'];
  if (!MODES.some((m) => args.includes(m))) {
    out('usage: ship leak --staged | --msg <file> | --pre-push | --all | --history [--generic-only]');
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
  const texts = [];
  const extra = [];
  if (args.includes('--staged')) {
    const files = (await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])).split('\n').filter(Boolean);
    for (const f of files) texts.push([f, await git(['show', `:${f}`])]);
    extra.push(...(await identityFindings(git)));
  } else if (args.includes('--msg')) {
    texts.push(['commit message', await readFile(args[args.indexOf('--msg') + 1], 'utf8')]);
  } else if (args.includes('--pre-push')) {
    for (const line of (await readStdin(stdin)).split('\n').filter(Boolean)) {
      const [, localSha, , remoteSha] = line.split(' ');
      if (ZERO.test(localSha)) continue; // deleting a remote ref
      const range = ZERO.test(remoteSha) ? [localSha, '--not', '--remotes'] : [`${remoteSha}..${localSha}`];
      texts.push(...(await commitTexts(git, range, { patch: true })));
    }
  } else if (args.includes('--all')) {
    for (const f of (await git(['ls-files'])).split('\n').filter(Boolean)) {
      texts.push([f, await readFile(join(cwd, f), 'utf8').catch(() => '')]);
    }
    texts.push(...(await commitTexts(git, ['--all'], { patch: false })));
  } else if (args.includes('--history')) {
    texts.push(...(await commitTexts(git, ['--all'], { patch: true })));
  } else {
    out('usage: ship leak --staged | --msg <file> | --pre-push | --all | --history [--generic-only]');
    return 2;
  }
  const findings = [...extra, ...texts.flatMap(([source, text]) => (text.includes('\u0000') ? [] : scanText(text, { denylist, source })))];
  for (const f of findings) out(`✗ ${f.source}:${f.line}: ${f.rule}`);
  if (findings.length === 0) out('✓ leak guard: clean');
  return findings.length ? 1 : 0;
}
