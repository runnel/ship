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

// The clearance of each migration file: a line of two fields (file, time) is a bare ack, the owner's
// word that the file may be deployed past. A line whose third field is `applied` is a file that
// `ship migrations apply` ran and then proved from the database; `verified` is one it did not run:
// the database already satisfied every declared post-condition and the owner said to record that.
// Proof outranks an ack whatever their order.
export async function readClearances(root, repo) {
  let text;
  try {
    text = await readFile(ackFile(root, repo), 'utf8');
  } catch (err) {
    if (isMissing(err)) return new Map();
    throw err;
  }
  const out = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const [file, at, kind, by, sha256, mainSha, checks] = line.split('\t');
    const proof = kind === 'applied' || kind === 'verified';
    const record = proof
      ? { kind, at, by: by ?? null, sha256: sha256 ?? null, mainSha: mainSha ?? null, checks: Number(checks) || 0 }
      : { kind: 'ack', at: at ?? null };
    if (!out.has(file) || (proof && out.get(file).kind === 'ack')) out.set(file, record);
  }
  return out;
}

export const isProof = (record) => record?.kind === 'applied' || record?.kind === 'verified';

const field = (v) => String(v).replace(/[\t\r\n]+/g, ' ');

// Appends the proof for a file (`kind` is `applied` or `verified`); a file that already has one is
// left as it is and false is returned.
export async function addProof(root, repo, { kind, file, at = new Date().toISOString(), by, sha256, mainSha, checks }) {
  if (kind !== 'applied' && kind !== 'verified') throw new Error(`unknown proof kind ${kind}`);
  if (isProof((await readClearances(root, repo)).get(file))) return false;
  await mkdir(join(root, 'acks'), { recursive: true });
  await appendFile(ackFile(root, repo), `${[file, at, kind, by, sha256, mainSha, checks].map(field).join('\t')}\n`, { mode: 0o600 });
  return true;
}

// Attempts live beside the acks, not in them: an attempt clears nothing. One is written before the
// SQL is sent and settled once the outcome is known (the database answered), so a request that
// got no answer stays visible as an attempt that may still be running or may have committed.
const attemptFile = (root, repo) => join(root, 'attempts', repoKeyOf(repo));

async function appendAttempt(root, repo, fields) {
  await mkdir(join(root, 'attempts'), { recursive: true });
  await appendFile(attemptFile(root, repo), `${fields.map(field).join('\t')}\n`, { mode: 0o600 });
}

export const recordAttempt = (root, repo, { file, sha256, by, at = new Date().toISOString() }) => appendAttempt(root, repo, [file, at, 'attempt', by, sha256]);
export const settleAttempt = (root, repo, { file, sha256, by, outcome, at = new Date().toISOString() }) => appendAttempt(root, repo, [file, at, 'settled', by, sha256, outcome]);

// The latest attempt at this exact content that was never settled, or null.
export async function unsettledAttempt(root, repo, file, sha256) {
  let text;
  try {
    text = await readFile(attemptFile(root, repo), 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  let open = null;
  for (const line of text.split('\n').filter(Boolean)) {
    const [f, at, kind, by, sha] = line.split('\t');
    if (f !== file || sha !== sha256) continue;
    open = kind === 'attempt' ? { at, by } : null;
  }
  return open;
}
