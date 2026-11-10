import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isStale, readOwner, waiterGone, parseTicketName } from './lock.mjs';
import { SHIP_TMP, SHIP_HOME } from './paths.mjs';
import { duration, timeOr } from './report.mjs';
import { LANE_PRIORITY } from './shared.mjs';

// `ship queue`: who holds each lane, who waits in which order, and when the line is likely to move,
// from what is on disk. It writes nothing and removes nothing, not even the ticket of a waiter that
// is gone (the next waiter in line does that).

const RECENT_RUNS = 20; // how many of the latest runs of a kind say what is usual
const MIN_RUNS = 3; // fewer than this say nothing
const STUCK_OVER_MEDIAN = 3; // a holder is possibly stuck past this many times the usual (median) run time,
const STUCK_OVER_HIGH = 1.5; // and past this many times the 90th percentile of the latest runs (one freak run must not hide it),
const STUCK_FLOOR_MS = 5 * 60_000; // and at least this long
const GUESS_AFTER_MS = 120_000; // a log that began this long after the lane was taken is not the holder's
const LANES = ['heavy', 'light']; // always listed; any other lane found on disk follows

// A place for a run on a remote (GitHub or Cloudflare, see overflow.mjs) is a lock in the same directory,
// but no lane: nothing waits for it, and the machine's run times say nothing about it.
const REMOTES = { github: 'GitHub', cloudflare: 'Cloudflare' };
const remoteOf = (name) => REMOTES[/^(github|cloudflare)-\d+$/.exec(name)?.[1]] ?? null;

// --- the lanes ----------------------------------------------------------------------------------

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

// The lanes on disk as [{ name, holder, stale, waiters }]. A waiter is a ticket whose process is
// alive, in the order of its file name: lowest priority number first, then the earlier arrival.
export async function readLanes(tmpRoot, { isStaleFn = isStale, waiterGoneFn = waiterGone } = {}) {
  const dir = join(tmpRoot, 'lanes');
  const found = new Map(LANES.map((name) => [name, { name, holder: null, stale: false, waiters: [] }]));
  const lane = (name) => {
    if (!found.has(name)) found.set(name, { name, holder: null, stale: false, waiters: [] });
    return found.get(name);
  };
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    const ticket = parseTicketName(name);
    if (ticket) {
      const owner = await readJson(join(dir, name));
      if (!owner || (await waiterGoneFn(owner))) continue;
      lane(ticket.lane).waiters.push({ ...ticket, owner });
    } else if (!/\.(q-|new-|gone-|takeover)/.test(name)) {
      const holder = await readOwner(join(dir, name));
      const l = lane(name);
      l.holder = holder;
      l.stale = holder ? await isStaleFn(holder) : false;
      if (remoteOf(name)) l.run = await readJson(join(dir, name, 'run.json'));
    }
  }
  return [...found.values()];
}

// --- what is usual ------------------------------------------------------------------------------

// A log is named `<owner>__<repo>-[deploy-]<sha7>-<UTC stamp>.log` (see newLogFile).
const LOG_NAME = /^([A-Za-z0-9-]+)__(.+?)-(deploy-)?([0-9a-f]{7})-(\d{8}T\d{6}Z)\.log$/;

export function parseLogName(name) {
  const m = LOG_NAME.exec(name);
  if (!m) return null;
  const s = m[5];
  const parsed = {
    repo: `${m[1]}/${m[2]}`,
    kind: m[3] ? 'deploy' : 'check',
    stampMs: Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`),
  };
  // `acme__infra-deploy-<sha>-<stamp>` is a deploy of acme/infra or a check of acme/infra-deploy:
  // the name cannot say which, so both readings are kept and the one that is asked about is used.
  if (m[3]) parsed.alt = { repo: `${m[1]}/${m[2]}-deploy`, kind: 'check' };
  return parsed;
}

// When the run began writing and how long it wrote. The log is created by its first step, which
// starts once the lane is won, so its birth is a better start than the name's stamp (taken before
// the wait for the lane); a file system without a usable birth time falls back to the stamp.
export function runtimeOf({ stampMs, birthMs, mtimeMs }) {
  const startMs = birthMs > 0 && birthMs <= mtimeMs ? birthMs : stampMs;
  return { startMs, endMs: mtimeMs, ms: Math.max(0, mtimeMs - startMs) };
}

// Every log in the directory as [{ repo, kind, file, startMs, endMs, ms }], newest first.
export async function readHistory(logRoot) {
  const runs = [];
  for (const name of await readdir(logRoot).catch(() => [])) {
    const parsed = parseLogName(name);
    if (!parsed) continue;
    const st = await stat(join(logRoot, name)).catch(() => null);
    if (!st) continue;
    // Where the file system has no birth time, libuv may report the change time in its place; a
    // birth that equals it is as good as unknown (the log was begun, then written, so they differ).
    const birthMs = st.birthtimeMs === st.ctimeMs ? 0 : st.birthtimeMs;
    runs.push({ repo: parsed.repo, kind: parsed.kind, alt: parsed.alt, file: join(logRoot, name), ...runtimeOf({ stampMs: parsed.stampMs, birthMs, mtimeMs: st.mtimeMs }) });
  }
  return runs.sort((a, b) => b.endMs - a.endMs);
}

// The usual run time of one kind of work in one repository, from its latest runs: { n, median, high }
// (high = the 90th percentile) or null when there are too few. A deploy's log spans all of its turns at the lane, so a deploy's
// figure is for the whole deploy and an upper bound for any one turn.
const isRun = (r, repo, kind) => (r.repo === repo && r.kind === kind) || (r.alt?.repo === repo && r.alt.kind === kind);

export function usualFor(history, repo, kind) {
  const ms = history.filter((r) => isRun(r, repo, kind)).slice(0, RECENT_RUNS).map((r) => r.ms).sort((a, b) => a - b);
  if (ms.length < MIN_RUNS) return null;
  return { n: ms.length, median: ms[Math.floor(ms.length / 2)], high: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.9))] };
}

// What a lane user is doing: a check names its pull request, a deploy its command.
export function workOf(owner) {
  const repo = owner?.repo ?? '?';
  if (owner?.pr) return { repo, kind: 'check', text: `${repo} PR #${owner.pr}` };
  if (owner?.command) return { repo, kind: 'deploy', text: `${repo} ${owner.command}` };
  return { repo, kind: 'other', text: repo };
}

// The log a holder is writing: the one it recorded, else (a holder from before ship recorded it) the
// latest log of its repository and kind that was begun around the time it took the lane.
function logOf(holder, work, history, nowMs) {
  if (holder.log) return { file: holder.log, guessed: false };
  const since = Date.parse(holder.since);
  if (Number.isNaN(since) || work.kind === 'other') return null;
  const run = history.find((r) => isRun(r, work.repo, work.kind) && r.startMs <= since + GUESS_AFTER_MS && r.endMs >= since - 10_000 && r.startMs <= nowMs);
  return run ? { file: run.file, guessed: true } : null;
}

// --- the picture --------------------------------------------------------------------------------

// Everything `ship queue` says as data: for each lane its holder (how long, what is usual, whether
// it looks stuck, when its log was last written) and its waiters in order (how long each has waited,
// and when it should start if nothing is put in front of it).
export async function snapshot({ tmpRoot, logRoot, nowMs = Date.now(), lanes, history }) {
  lanes ??= await readLanes(tmpRoot);
  history ??= await readHistory(logRoot);
  const out = [];
  for (const l of lanes) {
    if (remoteOf(l.name)) {
      if (!l.holder) continue;
      const since = Date.parse(l.holder.since);
      out.push({ name: l.name, onRemote: { remote: remoteOf(l.name), text: workOf(l.holder).text, since: l.holder.since, heldMs: Number.isNaN(since) ? null : Math.max(0, nowMs - since), url: l.run?.url ?? null, stale: l.stale } });
      continue;
    }
    const entry = { name: l.name, holder: null, waiters: [] };
    let wait = 0; // until the next in line can start; null once it cannot be told
    let overdue = false;
    if (l.holder) {
      const work = workOf(l.holder);
      const since = Date.parse(l.holder.since);
      const heldMs = Number.isNaN(since) ? null : Math.max(0, nowMs - since);
      const usual = usualFor(history, work.repo, work.kind);
      const log = logOf(l.holder, work, history, nowMs);
      const mtime = log ? (await stat(log.file).catch(() => null))?.mtimeMs : undefined;
      entry.holder = {
        text: work.text, since: l.holder.since, heldMs, usual, stale: l.stale,
        stuck: !l.stale && heldMs !== null && usual !== null && heldMs > Math.max(STUCK_OVER_MEDIAN * usual.median, STUCK_OVER_HIGH * usual.high, STUCK_FLOOR_MS),
        log: log ? { ...log, quietMs: mtime === undefined ? null : Math.max(0, Math.round(nowMs - mtime)) } : null,
      };
      if (l.stale) wait = 0;
      else if (heldMs === null || usual === null) wait = null;
      else {
        overdue = heldMs >= usual.median;
        wait = Math.max(0, usual.median - heldMs);
      }
    }
    for (const w of l.waiters) {
      const work = workOf(w.owner);
      const usual = usualFor(history, work.repo, work.kind);
      entry.waiters.push({ text: work.text, priority: w.priority, waitedMs: Math.max(0, nowMs - w.arrivedAt), startsInMs: wait, atLeast: overdue });
      wait = wait === null || usual === null ? null : wait + usual.median;
    }
    out.push(entry);
  }
  return out;
}

// --- the screen ---------------------------------------------------------------------------------

const minutes = (ms) => `${Math.max(1, Math.round(ms / 60_000))}m`;
const tilde = (path) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

// What a waiter in a lane is, by its priority (see LANE_PRIORITY).
export const kindOf = (priority) => (priority <= LANE_PRIORITY.deploy ? 'deploy work, ahead of checks'
  : priority <= LANE_PRIORITY.land ? 'land check, ahead of other checks' : 'check');

export function render(lanes) {
  const lines = [];
  for (const l of lanes) {
    if (l.onRemote) {
      const g = l.onRemote;
      lines.push(`on ${g.remote}: ${g.text}  ${g.heldMs === null ? '' : `for ${duration(g.heldMs)} (since ${timeOr(g.since)})  ·  `}${g.url ?? 'starting'}`);
      if (g.stale) lines.push('  ✗ the check that started it is gone: nothing posts its result');
      continue;
    }
    if (!l.holder && l.waiters.length === 0) {
      lines.push(`${l.name} lane: free`);
      continue;
    }
    lines.push(`${l.name} lane: ${l.holder ? 'in use' : 'free, the first waiter is taking it'}${l.waiters.length ? `, ${l.waiters.length} waiting` : ''}`);
    const h = l.holder;
    if (h) {
      const held = h.heldMs === null ? 'for an unknown time' : `for ${duration(h.heldMs)} (since ${timeOr(h.since)})`;
      const usual = h.usual ? `usual ${minutes(h.usual.median)}, 9 in 10 of the last ${h.usual.n} within ${minutes(h.usual.high)}` : 'no run history to compare with';
      lines.push(`  holds     ${h.text}  ${held}  ·  ${usual}`);
      if (h.log) {
        const quiet = h.log.quietMs === null ? 'log not found' : `output ${duration(h.log.quietMs)} ago`;
        lines.push(`            ${quiet}${h.log.guessed ? ' (log guessed from its start time)' : ''}  ·  ${tilde(h.log.file)}`);
      }
      if (h.stale) lines.push('  ✗ the holder\'s process is gone: the next in line takes the lane over');
      else if (h.stuck) {
        // Whether the log is still being written is the best sign of life there is.
        const quiet = h.log?.quietMs ?? null;
        const alive = quiet === null ? '' : quiet < 60_000 ? ', but its log is still being written' : quiet >= 5 * 60_000 ? `, and its log has been quiet for ${duration(quiet)}` : '';
        lines.push(`  ! possibly stuck: held for ${duration(h.heldMs)}, well over the usual ${minutes(h.usual.median)} (9 in 10 runs end within ${minutes(h.usual.high)})${alive}`);
      }
    }
    l.waiters.forEach((w, i) => {
      const starts = w.startsInMs === null ? 'start unknown' : `starts in ~${minutes(w.startsInMs)}${w.atLeast ? '+' : ''}`;
      lines.push(`  ${String(i + 1).padStart(2)}. ${w.text}  ·  ${kindOf(w.priority)}  ·  waited ${duration(w.waitedMs)}  ·  ${starts}`);
    });
  }
  return lines;
}

export async function runQueue({ deps = {} } = {}) {
  const d = { tmpRoot: SHIP_TMP, logRoot: join(SHIP_HOME, 'logs'), out: (line) => process.stdout.write(`${line}\n`), nowMs: Date.now(), ...deps };
  const lanes = await snapshot({ tmpRoot: d.tmpRoot, logRoot: d.logRoot, nowMs: d.nowMs });
  for (const line of render(lanes)) d.out(line);
  if (lanes.some((l) => l.waiters?.length > 0)) d.out('Estimates use the median run time of the latest runs in the logs, and assume no deploy work is put in front.');
  return 0;
}
