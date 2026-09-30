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

const isMissing = (err) => err?.code === 'ENOENT';

const asHold = (text) => {
  try {
    const hold = JSON.parse(text);
    const plain = hold !== null && typeof hold === 'object' && !Array.isArray(hold);
    return plain && typeof hold.reason === 'string' ? hold : null;
  } catch {
    return null;
  }
};

// Only a missing file means "no hold": a file that is present but cannot be read, or does not
// hold a hold object, still holds.
export async function readHold(root, repo, name) {
  const file = holdFile(root, repo, name);
  const unreadable = { reason: `unreadable hold file ${file}`, versionId: null, sha: null, at: null };
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    return isMissing(err) ? null : unreadable;
  }
  return asHold(text) ?? unreadable;
}

export async function writeHold(root, repo, name, { reason, versionId = null, sha = null, at = new Date().toISOString() }) {
  const hold = { reason, versionId, sha, at };
  await atomicWrite(holdFile(root, repo, name), `${JSON.stringify(hold, null, 2)}\n`);
  return hold;
}

export async function clearHold(root, repo, name) {
  try {
    await rm(holdFile(root, repo, name));
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export async function listHolds(root, repo) {
  let files;
  try {
    files = await readdir(holdDir(root, repo));
  } catch (err) {
    if (isMissing(err)) return {};
    throw err;
  }
  const out = {};
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -'.json'.length);
    const hold = await readHold(root, repo, name);
    if (hold !== null) out[name] = hold; // null only when the file vanished after the listing
  }
  return out;
}

export async function readAcks(root, repo) {
  let text;
  try {
    text = await readFile(ackFile(root, repo), 'utf8');
  } catch (err) {
    if (isMissing(err)) return new Set();
    throw err;
  }
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
