import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isStale, liveAhead, parseTicketName, readOwner, waiterGone } from './lock.mjs';
import { checkKey, repoKeyOf } from './shared.mjs';

// ship land's line, one per repository, in `$SHIP_TMP/land/<owner>__<repo>/`. The land slot is the
// lock directory `slot`: its owner.json names the land that is checking or merging. The waiters are
// the tickets `acquire` files beside it (`slot.q-…json`): arrival order, and a ticket whose process is
// gone is skipped and removed by the next waiter that looks (lib/lock.mjs).

// The time `d` reads as an ISO string (d.now when a test or caller injects one).
export const iso = (d) => new Date((d.now ?? Date.now)()).toISOString();
export const landDir = (d, repo) => join(d.tmpRoot, 'land', repoKeyOf(repo));
export const slotDir = (d, repo) => join(landDir(d, repo), 'slot');
// The per-head check lock that ship check takes too: a land holds it from its start to its merge.
export const headLockDir = (d, repo, headSha) => join(d.tmpRoot, 'checks', checkKey(repo, headSha));

// A ticket that sorts after every real one: what is ahead of it is the whole line.
const END_OF_LINE = { name: '\uffff', left: true };

// The live holder of the slot (null when it is free or its process is gone) and the live waiters in
// line order. Dead tickets are removed on the way.
export async function lineState(d, repo) {
  const dir = slotDir(d, repo);
  // The tickets first: a waiter that takes the slot between the two reads is then seen as the holder
  // (or in both), never in neither.
  const waiters = await liveAhead(dir, END_OF_LINE);
  const owner = await readOwner(dir);
  const holder = owner && !(await isStale(owner)) ? owner : null;
  return { holder, waiters };
}

export const lineEmpty = ({ holder, waiters }) => holder === null && waiters.length === 0;

// Why a land of this pull request and head must not start because one is already under way, or null.
// An optional ship check holding the head lock is not a land: a land waits for it.
export async function alreadyLanding(d, repo, { pr, headSha }) {
  const head = await readOwner(headLockDir(d, repo, headSha));
  const landingHead = head?.land && !(await isStale(head)) ? head : null;
  const { holder, waiters } = await lineState(d, repo);
  const twin = [landingHead, holder, ...waiters].find((o) => o?.land && Number(o.pr) === Number(pr) && o.headSha === headSha);
  return twin ? `PR #${pr} @ ${headSha.slice(0, 7)} is already landing (pid ${twin.pid ?? '?'})` : null;
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// The live tickets among the file names `names` of `dir`, in the order given, as
// [{ lane, priority, arrivedAt, nonce, owner }]. Names that are no ticket, tickets that cannot be
// read and tickets whose process is gone are left out; nothing is removed.
export async function liveTickets(dir, names, waiterGoneFn = waiterGone) {
  const out = [];
  for (const name of names) {
    const ticket = parseTicketName(name);
    if (!ticket) continue;
    const owner = await readJson(join(dir, name));
    if (!owner || (await waiterGoneFn(owner))) continue;
    out.push({ ...ticket, owner });
  }
  return out;
}

// Every repository's land line that has a holder or a live waiter, for ship queue. Read only, like
// the lanes: a dead waiter's ticket is the next waiter's to remove.
export async function readLandLines(tmpRoot, { isStaleFn = isStale, waiterGoneFn = waiterGone } = {}) {
  const root = join(tmpRoot, 'land');
  const out = [];
  for (const key of (await readdir(root).catch(() => [])).sort()) {
    const dir = join(root, key);
    const holder = await readOwner(join(dir, 'slot'));
    const names = (await readdir(dir).catch(() => [])).sort();
    const waiters = (await liveTickets(dir, names, waiterGoneFn)).filter((t) => t.lane === 'slot').map((t) => ({ arrivedAt: t.arrivedAt, owner: t.owner }));
    if (!holder && waiters.length === 0) continue;
    out.push({ repo: holder?.repo ?? waiters[0]?.owner?.repo ?? key.replace('__', '/'), holder, stale: holder ? await isStaleFn(holder) : false, waiters });
  }
  return out;
}
