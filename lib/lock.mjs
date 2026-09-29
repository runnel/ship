import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture } from './proc.mjs';

const OWNERLESS_GRACE_MS = 30_000; // a lock directory without owner.json is left alone until this old
const NONE = 'none'; // ps/pgrep say there is no such process
const UNKNOWN = 'unknown'; // ps/pgrep failed: says nothing about the process

// ps prints lstart in the local time zone and locale: pin both, or two processes with different
// TZ settings read different values for the same process and steal a live lock. (Read at call time.)
const psEnv = () => ({ ...process.env, TZ: 'UTC', LC_ALL: 'C' });

// Exit status 1 is "no such process". Anything else (EAGAIN under fork pressure during a heavy
// build, a missing binary) tells nothing about the process, and a lock we cannot judge is a held one.
async function psField(field, pid) {
  try {
    return (await capture('ps', ['-o', `${field}=`, '-p', String(pid)], { env: psEnv() })).trim() || NONE;
  } catch (e) {
    return e.code === 1 ? NONE : UNKNOWN;
  }
}

async function groupState(pgid) {
  if (!pgid) return NONE;
  try {
    return (await capture('pgrep', ['-g', String(pgid)])).trim() ? 'alive' : NONE;
  } catch (e) {
    return e.code === 1 ? NONE : UNKNOWN; // pgrep exits 1 when nothing matches
  }
}

export async function processStartTime(pid) {
  const v = await psField('lstart', pid);
  return v === NONE || v === UNKNOWN ? null : v;
}

async function processGroup(pid) {
  const v = await psField('pgid', pid);
  return Number(v) || null;
}

export async function ownerInfo(extra = {}) {
  return {
    pid: process.pid,
    pgid: await processGroup(process.pid),
    startTime: await processStartTime(process.pid),
    nonce: randomUUID(),
    since: new Date().toISOString(),
    ...extra,
  };
}

export async function readOwner(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Stale = the holder is gone AND nothing in its process group survives (an orphaned child such
// as a half-finished deploy keeps the lock), or the pid now belongs to a different process.
// Only a definite "no such process" counts as gone.
export async function isStale(owner) {
  if (!owner || !owner.pid) return true;
  const start = await psField('lstart', owner.pid);
  if (start === UNKNOWN) return false;
  if (start !== NONE) return Boolean(owner.startTime) && start !== owner.startTime;
  return (await groupState(owner.pgid)) === NONE;
}

// The lock directory appears fully formed: owner.json is written into a sibling directory, which
// is then renamed into place. rename() onto an existing lock (a non-empty directory) fails, so
// there is neither a moment at which the lock exists without an owner nor a window in which a
// takeover could mistake a lock that is being created for an abandoned one.
async function tryAcquire(dir, owner) {
  const staging = await mkdtemp(`${dir}.new-`);
  try {
    // `since` = when the lock was taken, not when the owner started waiting for it.
    await writeFile(join(staging, 'owner.json'), JSON.stringify({ ...owner, since: new Date().toISOString() }));
    await rename(staging, dir);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return false;
    throw e;
  }
  return (await readOwner(dir))?.nonce === owner.nonce;
}

// Removal is a rename too: the lock is either there with its owner or gone.
async function removeLock(dir) {
  const trash = `${dir}.gone-${randomUUID()}`;
  try {
    await rename(dir, trash);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  await rm(trash, { recursive: true, force: true });
}

// Takeovers are serialised by a second, short-lived mutex, and only proceed if the lock is still
// what we inspected — the same stale holder (same nonce), or a directory that is still without an
// owner and still old — so two waiters cannot both win and a lock created in the meantime is
// never removed.
async function takeOver(dir, owner, inspected) {
  const mutex = `${dir}.takeover`;
  try {
    await mkdir(mutex);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const st = await stat(mutex).catch(() => null);
    if (st && Date.now() - st.mtimeMs > OWNERLESS_GRACE_MS) await rm(mutex, { recursive: true, force: true });
    return false;
  }
  try {
    const current = await readOwner(dir);
    if (inspected) {
      if (!current || (current.nonce ?? null) !== (inspected.nonce ?? null)) return false;
    } else {
      if (current) return false;
      const st = await stat(dir).catch(() => null);
      if (!st || Date.now() - st.mtimeMs <= OWNERLESS_GRACE_MS) return false;
    }
    await removeLock(dir);
    return await tryAcquire(dir, owner);
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

async function release(dir, nonce) {
  const current = await readOwner(dir);
  if (current?.nonce === nonce) await removeLock(dir);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function acquire(dir, owner, { pollMs = 5000, onWait = () => {} } = {}) {
  await mkdir(dirname(dir), { recursive: true });
  const done = () => release(dir, owner.nonce);
  for (;;) {
    if (await tryAcquire(dir, owner)) return done;
    const holder = await readOwner(dir);
    let stale = false;
    if (holder) {
      stale = await isStale(holder);
    } else {
      const st = await stat(dir).catch(() => null);
      if (!st) continue; // released between our attempt and our look: try again at once
      stale = Date.now() - st.mtimeMs > OWNERLESS_GRACE_MS;
    }
    if (stale && (await takeOver(dir, owner, holder))) return done;
    if (!stale) onWait(holder);
    await sleep(pollMs);
  }
}
