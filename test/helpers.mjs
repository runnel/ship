import { mkdtemp, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { capture } from '../lib/proc.mjs';

// One scratch root per test process, removed when the process exits.
const ROOT = mkdtempSync(join(tmpdir(), 'ship-tests-'));
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

export const tempDir = (prefix = 't-') => mkdtemp(join(ROOT, prefix));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost',
};
export const git = (args, cwd) => capture('git', args, { cwd, env: GIT_ENV });

export async function commitFiles(work, files, message) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await git(['add', '-A'], work);
  await git(['commit', '--quiet', '-m', message], work);
  return (await git(['rev-parse', 'HEAD'], work)).trim();
}

// A bare "origin" whose main holds `files`, plus a working clone (on main) to commit from.
export async function makeOrigin(files) {
  const root = await tempDir();
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  await git(['init', '--bare', '--quiet', '--initial-branch=main', origin]);
  await git(['clone', '--quiet', origin, work]);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], work);
  await commitFiles(work, files, 'initial');
  await git(['push', '--quiet', 'origin', 'main'], work);
  return { root, origin, work };
}

// A fake `gh` executable: answers the calls ship makes and records every invocation.
export async function fakeGh(dir, { pr, repo = { defaultBranchRef: { name: 'main' } }, runs = [] }) {
  const log = join(dir, 'gh.log');
  const script = join(dir, 'gh');
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const reply = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args[0] === 'pr' && args[1] === 'view') reply(${JSON.stringify(pr)});
if (args[0] === 'repo' && args[1] === 'view') reply(${JSON.stringify(repo)});
if (args[0] === 'run' && args[1] === 'list') reply(${JSON.stringify(runs)});
if (args[0] === 'api') reply({});
process.stderr.write('fake gh: unhandled ' + args.join(' '));
process.exit(1);
`);
  await chmod(script, 0o755);
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { gh: script, calls };
}
