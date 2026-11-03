import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { billingUsage, cancelRun, dispatchWorkflow, redStep, workflowRun } from './github.mjs';
import { acquire, ownerInfo, tryLock } from './lock.mjs';
import { isInterrupted } from './interrupt.mjs';
import { capture } from './proc.mjs';
import { firstLine, sharedCleanup } from './shared.mjs';

// A check that would wait long for the heavy lane can run on the account's free GitHub Actions minutes
// instead. The minutes are shared with everything else the account runs on Actions, so the rule is
// that this never eats into what that other work needs: when in doubt, the check stays in line here.
// See docs/overflow.md, "Overflow to GitHub Actions".

const DAY_MS = 24 * 60 * 60 * 1000;
// A run started here counts this long on top of the usage report, which may not show it yet.
export const PENDING_WINDOW_MS = DAY_MS;

// How much of the included minutes one minute of a runner uses. A kind of minute that is not known
// counts high: it is more likely to be a dearer one than a cheaper one.
const MINUTE_WEIGHT = { 'Actions Linux': 1, 'Actions Windows': 2, 'Actions macOS': 10 };
const UNKNOWN_WEIGHT = 10;

// The Actions minutes in a usage report. Throws when the report does not say: nightly jobs put a row
// in it from the first day of a month, so no row means the report cannot be trusted, not that nothing
// has been used.
export function minutesUsed(report) {
  const items = report?.usageItems;
  if (!Array.isArray(items)) throw new Error('the usage report has no items');
  const rows = items.filter((i) => String(i.product).toLowerCase() === 'actions' && String(i.unitType).toLowerCase() === 'minutes');
  if (rows.length === 0) throw new Error('the usage report has no Actions minutes');
  let total = 0;
  for (const r of rows) {
    if (typeof r.quantity !== 'number' || !(r.quantity >= 0)) throw new Error('the usage report has a row without a quantity');
    total += r.quantity * (MINUTE_WEIGHT[r.sku] ?? UNKNOWN_WEIGHT);
  }
  return total;
}

// Whole days left in this UTC month, today included.
export function daysLeftInMonth(now) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.ceil((next - now.getTime()) / DAY_MS);
}

// Whether one more run leaves the reserve untouched: { ok, left, reserve }, in minutes.
export function reserveVerdict({ used, pendingRuns, overflow, now }) {
  const reserve = overflow.reserveFloor + overflow.reservePerDay * daysLeftInMonth(now);
  const left = overflow.includedMinutes - used - (pendingRuns + 1) * overflow.runMinutes;
  return { ok: left >= reserve, left, reserve };
}

// One line per run this machine has decided to start, written with the decision, so that a run whose
// start was lost on the way is still counted. Kept outside the temporary directory: a reboot must not
// forget what was spent. A line that cannot be read throws, and then no run starts.
const ledgerFile = (d) => join(d.overflowRoot, 'runs.jsonl');

export async function recentRuns(file, now, windowMs) {
  const text = await readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; });
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let at;
    try {
      ({ at } = JSON.parse(line));
    } catch {
      throw new Error(`${file} has a line that cannot be read`);
    }
    if (typeof at !== 'number') throw new Error(`${file} has a line without a time`);
    if (at >= now - windowMs) n++;
  }
  return n;
}

async function recordRun(file, entry) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Whether the minutes allow one more run, and if they do, that run is entered. Reading the entries and
// adding one is a single step between processes: two checks at once cannot both spend the last room.
async function spendOneRun({ d, owner, overflow }) {
  const now = new Date(d.now());
  const report = await billingUsage({ owner: owner.repo.split('/')[0], year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, gh: d.gh });
  const used = minutesUsed(report);
  const release = await acquire(join(d.tmpRoot, 'locks', 'overflow-ledger'), await ownerInfo({ repo: owner.repo, pr: owner.pr }), { pollMs: 50 });
  try {
    const pendingRuns = await recentRuns(ledgerFile(d), now.getTime(), PENDING_WINDOW_MS);
    const verdict = { used, pendingRuns, ...reserveVerdict({ used, pendingRuns, overflow, now }) };
    if (verdict.ok) await recordRun(ledgerFile(d), { at: now.getTime(), repo: owner.repo, pr: owner.pr, sha: owner.sha });
    return verdict;
  } finally {
    await release();
  }
}

// One of the machine-wide places for a run on a remote (`kind`: github, cloudflare, each with its own
// count): { dir, release }, or null when all are taken. They are locks in the lanes directory, so a place
// whose process is gone frees itself.
export async function takePlace(d, count, owner, kind = 'github') {
  for (let i = 0; i < count; i++) {
    const dir = join(d.tmpRoot, 'lanes', `${kind}-${i}`);
    const release = await tryLock(dir, owner);
    if (release) return { dir, release: sharedCleanup(release) };
  }
  return null;
}

// Decides whether this check goes to GitHub. `ask(line)` is what the wait for the lane polls: true once
// the line is long enough and a place and the minutes are there. `claim()` skips the look at the line.
// When either is true the check holds a place until `release()`. A reason not to go is said once, and
// again only when the reason changes.
export function overflowGate({ d, owner, overflow }) {
  let askedAt = 0;
  let said = null;
  let place = null;
  const stay = (kind, why) => {
    if (kind !== said) d.out(`· stays on this machine: ${why}`);
    said = kind;
    return false;
  };
  const claim = async () => {
    let free = null;
    let v;
    try {
      free = await takePlace(d, overflow.maxRunning, await ownerInfo(owner));
      if (!free) return stay('places', `${overflow.maxRunning} GitHub run(s) going already`);
      v = await spendOneRun({ d, owner, overflow });
    } catch (e) {
      if (free) await free.release().catch(() => {});
      return stay('unread', `GitHub minutes could not be read (${firstLine(e.stderr) || firstLine(e.message)})`);
    }
    if (!v.ok) {
      await free.release().catch(() => {});
      return stay('reserve', `GitHub minutes are at the reserve (${Math.round(v.used)} used, ${v.pendingRuns} recent run(s), ${v.reserve} kept free)`);
    }
    place = free;
    d.out(`▸ running on GitHub instead (${Math.round(v.used)} of ${overflow.includedMinutes} minutes used, ${v.reserve} kept free)`);
    return true;
  };
  return {
    claim,
    ask: async (line) => {
      if (!line || line.ahead.length < overflow.minAhead) return false;
      if (Date.now() - askedAt < d.overflowAskMs) return false;
      askedAt = Date.now();
      return claim();
    },
    get place() { return place; },
    release: async () => {
      const held = place;
      place = null;
      if (held) await held.release().catch(() => {}); // what is left of it frees itself with this process
    },
  };
}

// One gate for all the places a check may go to (see check.mjs), `remotes` in the order they are tried:
// [{ name, gate }]. A check goes at most once, so there is one gate for the lot: `ask(line)` (as the wait
// for the lane polls it) and `claim(name)` (a named remote, without looking at the line; no name: the
// first that takes it) say whether a remote took the check, which `chosen` then is, and `release()`
// gives back what it holds.
export function firstGate(remotes) {
  let chosen = null;
  const take = async (ask, only = null) => {
    for (const r of remotes) {
      if ((only === null || r.name === only) && await ask(r.gate)) {
        chosen = r;
        return true;
      }
    }
    return false;
  };
  return {
    get chosen() { return chosen; },
    claim: (name = null) => take((g) => g.claim(), name),
    ask: (line) => take((g) => g.ask(line)),
    release: async () => { for (const r of remotes) await r.gate.release(); },
  };
}

// The check as a run on GitHub, from the copy of the workflow on main: a pull request cannot change
// what judges it. Green is the only answer taken from GitHub. { ok: true, runId, url }, or
// { ok: false, why, url } for everything else, which the caller answers by checking here. Once
// `isStopped()` is true the run is cancelled and the answer has `stopped: true`.
// `onStarted(run)` is told the run as soon as it exists.
export async function runOnGitHub({ d, repo, main, mainSha, headSha, tree, groups, overflow, place, isStopped = () => false, onStarted }) {
  const nonce = randomBytes(6).toString('hex');
  const started = Date.now();
  let run;
  try {
    const inputs = { head_sha: headSha, main_sha: mainSha, tree_sha: (await capture('git', ['-C', tree, 'rev-parse', 'HEAD^{tree}'])).trim(), groups: groups.join(','), ship_sha: await d.shipSha(), nonce };
    if (isInterrupted()) return { ok: false, why: 'interrupted' };
    if (isStopped()) return { ok: false, why: 'stopped', stopped: true };
    run = await dispatchWorkflow({ repo, workflow: overflow.workflow, ref: main, inputs, gh: d.gh });
  } catch (e) {
    return { ok: false, why: `the GitHub run could not be started (${firstLine(e.stderr) || firstLine(e.message)})` };
  }
  const { runId, url } = run;
  d.out(`· GitHub run: ${url}`);
  await writeFile(join(place.dir, 'run.json'), JSON.stringify({ runId, url, startedAt: new Date().toISOString() })).catch(() => {});
  await onStarted(run);

  const give = (why) => ({ ok: false, why, url });
  const stop = async (why) => {
    await cancelRun({ repo, runId, gh: d.gh }).catch(() => {});
    return give(why);
  };
  // The answer must come from the run this call started, from the workflow on main. Until a run starts
  // GitHub shows the workflow's name in place of its `run-name`, so the name counts from then on.
  const isOurs = (r) => r.id === runId && r.path === `.github/workflows/${overflow.workflow}` && r.event === 'workflow_dispatch' && r.head_branch === main;
  const isNamed = (r) => r.display_title === `ship check ${nonce}`;
  const hasStarted = (r) => r.status === 'in_progress' || r.conclusion === 'success';
  let answered = Date.now();
  for (;;) {
    if (isInterrupted()) return stop('interrupted');
    if (isStopped()) return { ...(await stop('stopped')), stopped: true };
    await d.sleep(d.githubPollMs);
    const now = Date.now();
    let r;
    try {
      r = await workflowRun({ repo, runId, gh: d.gh });
      answered = Date.now();
    } catch (e) {
      if (now - answered >= d.githubBlindMs) return stop(`GitHub has not answered for ${Math.round(d.githubBlindMs / 60_000)} min (${firstLine(e.stderr) || firstLine(e.message)})`);
      continue;
    }
    if (!isOurs(r) || (hasStarted(r) && !isNamed(r))) return stop(`run ${runId} is not the run ship started`);
    if (r.status === 'completed') {
      if (r.conclusion === 'success') return { ok: true, runId, url };
      if (r.conclusion !== 'failure') return give(`the GitHub run ended as ${r.conclusion}`);
      const red = await redStep({ repo, runId, gh: d.gh }).catch(() => ({ step: null, line: null }));
      return give(`the GitHub run was red${red.line ? ` (${red.line})` : red.step ? ` at ${red.step}` : ''}`);
    }
    if (r.status !== 'in_progress' && now - started >= d.githubQueueMs) return stop(`the GitHub run had not started after ${Math.round(d.githubQueueMs / 60_000)} min`);
    if (now - started >= overflow.timeoutMin * 60_000) return stop(`the GitHub run had no result after ${overflow.timeoutMin} min`);
  }
}
