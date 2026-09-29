import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture } from './proc.mjs';

const OWNERLESS_GRACE_MS = 30_000; // a lock dir without owner.json is mid-creation, unless older
// ps prints lstart in the local time zone and locale: pin both, or two processes with different
// TZ settings read different values for the same process and steal a live lock.
const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };

export async function processStartTime(pid) {
  try {
    return (await capture('ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENV })).trim() || null;
  } catch {
    return null;
  }
}

async function processGroup(pid) {
  try {
    return Number((await capture('ps', ['-o', 'pgid=', '-p', String(pid)], { env: PS_ENV })).trim()) || null;
  } catch {
    return null;
  }
}

async function groupAlive(pgid) {
  if (!pgid) return false;
  try {
    return (await capture('pgrep', ['-g', String(pgid)])).trim().length > 0;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
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
export async function isStale(owner) {
  if (!owner || !owner.pid) return true;
  const start = await processStartTime(owner.pid);
  if (start && owner.startTime && start !== owner.startTime) return true;
  if (start) return false;
  return !(await groupAlive(owner.pgid));
}

async function tryAcquire(dir, owner) {
  try {
    await mkdir(dir);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  // `since` = when the lock was taken, not when the owner started waiting for it.
  await writeFile(join(dir, 'owner.json'), JSON.stringify({ ...owner, since: new Date().toISOString() }));
  return true;
}

// Takeovers are serialised by a second, short-lived mutex, and only proceed if the lock still
// belongs to the stale holder we inspected — so two waiters cannot both win.
async function takeOver(dir, owner, staleNonce) {
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
    if ((current?.nonce ?? null) !== staleNonce) return false;
    await rm(dir, { recursive: true, force: true });
    return await tryAcquire(dir, owner);
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

async function release(dir, nonce) {
  const current = await readOwner(dir);
  if (current?.nonce === nonce) await rm(dir, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function acquire(dir, owner, { pollMs = 5000, onWait = () => {} } = {}) {
  await mkdir(dirname(dir), { recursive: true });
  for (;;) {
    if (await tryAcquire(dir, owner)) return () => release(dir, owner.nonce);
    const holder = await readOwner(dir);
    let stale;
    if (holder) {
      stale = await isStale(holder);
    } else {
      const st = await stat(dir).catch(() => null);
      stale = !st || Date.now() - st.mtimeMs > OWNERLESS_GRACE_MS;
    }
    if (stale && (await takeOver(dir, owner, holder?.nonce ?? null))) {
      if ((await readOwner(dir))?.nonce === owner.nonce) return () => release(dir, owner.nonce);
    }
    if (!stale) onWait(holder);
    await sleep(pollMs);
  }
}
