import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { repoKeyOf } from './shared.mjs';

const holdDir = (root, repo) => join(root, 'holds', repoKeyOf(repo));
const holdFile = (root, repo, name) => join(holdDir(root, repo), `${name}.json`);
const ackFile = (root, repo) => join(root, 'acks', repoKeyOf(repo));

async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

export async function readHold(root, repo, name) {
  const file = holdFile(root, repo, name);
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { reason: `unreadable hold file ${file}`, versionId: null, sha: null, at: null };
  }
}

export async function writeHold(root, repo, name, { reason, versionId = null, sha = null, at = new Date().toISOString() }) {
  const hold = { reason, versionId, sha, at };
  await atomicWrite(holdFile(root, repo, name), `${JSON.stringify(hold, null, 2)}\n`);
  return hold;
}

export async function clearHold(root, repo, name) {
  const file = holdFile(root, repo, name);
  const existed = await readFile(file).then(() => true, () => false);
  await rm(file, { force: true });
  return existed;
}

export async function listHolds(root, repo) {
  const out = {};
  for (const f of await readdir(holdDir(root, repo)).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    out[name] = await readHold(root, repo, name);
  }
  return out;
}

export async function readAcks(root, repo) {
  const text = await readFile(ackFile(root, repo), 'utf8').catch(() => '');
  return new Set(text.split('\n').filter(Boolean).map((line) => line.split('\t')[0]));
}

export async function addAcks(root, repo, files) {
  const have = await readAcks(root, repo);
  const added = [...new Set(files)].filter((f) => !have.has(f));
  if (added.length > 0) {
    await mkdir(join(root, 'acks'), { recursive: true });
    const at = new Date().toISOString();
    await appendFile(ackFile(root, repo), added.map((f) => `${f}\t${at}\n`).join(''), { mode: 0o600 });
  }
  return added;
}
