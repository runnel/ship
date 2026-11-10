import { mkdir, mkdtemp, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

// --- the line ----------------------------------------------------------------------------------
// A lock that is only polled goes to whoever polls first, so a waiter can lose for as long as new
// ones keep arriving. With a `priority` the waiters line up instead: each files a ticket next to
// the lock directory, `<lock>.q-<priority>-<arrival ms>-<sequence>-<nonce>.json`, and only the
// first ticket in name order (lowest priority number, then earliest arrival) tries the lock. The
// tickets decide who tries; the lock directory alone still decides who holds, so mutual exclusion
// does not depend on them, and a waiter that files no ticket (an older ship) can still take the
// lock. A ticket whose process is gone is removed by whoever finds it ahead of them.

const MAX_PRIORITY = 99;
const TMP_TICKET_GRACE_MS = 5 * 60_000; // a ticket being written takes milliseconds; older leftovers are debris
let ticketSeq = 0; // orders tickets of one process that arrive within the same millisecond
const ticketPrefix = (dir) => `${basename(dir)}.q-`;

// A waiter is gone when its process is. Unlike a lock holder, whose orphaned children may still be
// doing its work (isStale), a waiter has no work for anyone to wait for: a process left in its
// group must not keep its ticket, and so the line, alive.
export async function waiterGone(owner) {
  if (!owner?.pid) return true;
  const start = await psField('lstart', owner.pid);
  if (start === UNKNOWN) return false;
  if (start === NONE) return true;
  return Boolean(owner.startTime) && start !== owner.startTime;
}

// What a ticket's file name says: `<lane>.q-<priority>-<arrival ms>-<sequence>-<nonce>.json`.
// null for any other name (a half-written `.tmp`, a lock directory, a lane's own leftovers).
export function parseTicketName(name) {
  const m = /^(.+)\.q-(\d{2})-(\d{15})-(\d{6})-([^.]+)\.json$/.exec(name);
  return m ? { lane: m[1], priority: Number(m[2]), arrivedAt: Number(m[3]), nonce: m[5] } : null;
}

// The ticket appears fully formed (written aside, then renamed), so a reader never sees half of one.
async function writeTicket(path, owner) {
  await writeFile(`${path}.tmp`, JSON.stringify(owner));
  await rename(`${path}.tmp`, path);
}

async function fileTicket(dir, owner, priority, arrivedAt) {
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) throw new RangeError(`lock priority must be an integer from 0 to ${MAX_PRIORITY}`);
  const num = (n, width) => String(n).padStart(width, '0');
  const name = `${ticketPrefix(dir)}${num(priority, 2)}-${num(arrivedAt, 15)}-${num(ticketSeq++ % 1_000_000, 6)}-${owner.nonce}.json`;
  // Without a start time a reused pid could keep the ticket alive: ask once more if ps failed before.
  const startTime = owner.startTime ?? await processStartTime(owner.pid);
  const ticket = { name, path: join(dirname(dir), name), owner: { ...owner, startTime, priority }, left: false };
  ticket.leave = async () => { // idempotent: the flow's own exit and an interrupt's unwind may both call it
    ticket.left = true;
    await rm(ticket.path, { force: true });
  };
  await writeTicket(ticket.path, ticket.owner);
  return ticket;
}

// The tickets in order. A ticket that cannot be parsed counts as gone; one that cannot be read for
// another reason (out of file handles, say) says nothing about its waiter and counts as live.
// Leftovers of a ticket that was never renamed into place are removed once they are old.
async function readLine(dir) {
  const parent = dirname(dir);
  const prefix = ticketPrefix(dir);
  const line = [];
  for (const name of (await readdir(parent).catch(() => [])).filter((n) => n.startsWith(prefix)).sort()) {
    const path = join(parent, name);
    if (name.endsWith('.tmp')) {
      const st = await stat(path).catch(() => null);
      if (st && Date.now() - st.mtimeMs > TMP_TICKET_GRACE_MS) await rm(path, { force: true });
      continue;
    }
    if (!name.endsWith('.json')) continue;
    try {
      line.push({ name, path, owner: JSON.parse(await readFile(path, 'utf8')) });
    } catch (e) {
      if (e instanceof SyntaxError) line.push({ name, path, owner: null });
      else if (e.code !== 'ENOENT') line.push({ name, path, unreadable: true });
    }
  }
  return line;
}

// The tickets of live waiters in front of `ticket`. Tickets of dead ones are removed on the way,
// and so that a ticket removed in error does not cost the place in line, ours is filed again.
// With a ticket that sorts after every real one ({ name: '\uffff', left: true }) it is the whole line.
export async function liveAhead(dir, ticket) {
  const line = await readLine(dir);
  const ahead = [];
  for (const t of line) {
    if (t.name >= ticket.name) break;
    if (!t.unreadable && (await waiterGone(t.owner))) await rm(t.path, { force: true });
    else ahead.push(t.owner ?? {});
  }
  if (!ticket.left && !line.some((t) => t.name === ticket.name)) {
    await writeTicket(ticket.path, ticket.owner);
    if (ticket.left) await rm(ticket.path, { force: true }); // withdrawn while it was being filed
  }
  return ahead;
}

// `isAborted` is polled between attempts: once it is true the wait ends with an error that has
// `aborted: true`, and the lock is not taken.
// `priority` (0 = first, up to 99) joins the line described above; `onQueue(leave)` is given the
// function that withdraws the ticket, for a caller that must do so itself (an interrupt). The
// ticket is withdrawn however the wait ends. `onWait(holder, line)` gets `line` =
// { position, ahead } (position 1 = next to take the lock) when there is a line, else undefined.
// `arrivedAt` (ms) is the place in the line: a waiter that comes back keeps the one it had.
// `leaveWhen(line)` is asked on every round of the wait: once it is true the wait ends with null, the
// ticket is withdrawn and the lock is not taken.
export async function acquire(dir, owner, { pollMs = 5000, onWait = () => {}, isAborted = () => false, priority, onQueue = () => {}, arrivedAt = Date.now(), leaveWhen = null } = {}) {
  await mkdir(dirname(dir), { recursive: true });
  const done = () => release(dir, owner.nonce);
  const ticket = priority === undefined ? null : await fileTicket(dir, owner, priority, arrivedAt);
  if (ticket) onQueue(ticket.leave);
  try {
    for (;;) {
      if (isAborted()) throw Object.assign(new Error('acquire aborted'), { aborted: true });
      const ahead = ticket ? await liveAhead(dir, ticket) : [];
      const line = ticket ? { position: ahead.length + 1, ahead } : undefined;
      const myTurn = ahead.length === 0;
      if (myTurn && (await tryAcquire(dir, owner))) return done;
      const holder = await readOwner(dir);
      let stale = false;
      if (holder) {
        stale = await isStale(holder);
      } else {
        const st = await stat(dir).catch(() => null);
        if (!st && myTurn) continue; // released between our attempt and our look: try again at once
        stale = Boolean(st) && Date.now() - st.mtimeMs > OWNERLESS_GRACE_MS;
      }
      if (stale && myTurn && (await takeOver(dir, owner, holder))) return done;
      if (!stale || !myTurn) onWait(holder, line);
      if (leaveWhen && (await leaveWhen(line))) return null;
      await sleep(pollMs);
    }
  } finally {
    // A ticket that cannot be removed is swept once this process is gone; that must not turn a lock
    // that was just won into a failure that nothing releases.
    if (ticket) await ticket.leave().catch(() => {});
  }
}

// One attempt at a lock, without waiting: the function that releases it, or null while it is held.
// A holder that is gone loses it, as in `acquire`.
export async function tryLock(dir, owner) {
  await mkdir(dirname(dir), { recursive: true });
  const done = () => release(dir, owner.nonce);
  if (await tryAcquire(dir, owner)) return done;
  const holder = await readOwner(dir);
  if (holder) return (await isStale(holder)) && (await takeOver(dir, owner, holder)) ? done : null;
  const st = await stat(dir).catch(() => null);
  if (!st) return (await tryAcquire(dir, owner)) ? done : null; // released between the two looks
  return Date.now() - st.mtimeMs > OWNERLESS_GRACE_MS && (await takeOver(dir, owner, null)) ? done : null;
}
