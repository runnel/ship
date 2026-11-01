import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquire, isStale, ownerInfo } from './lock.mjs';
import { isInterrupted } from './interrupt.mjs';
import { abortedError, repoKeyOf } from './shared.mjs';
import { localTime } from './report.mjs';

// One deploy per repository is wanted, however many sessions ask for one. The first `ship deploy`
// of a repository registers itself here as the leader; a later one that finds a leader that has not
// frozen its target yet joins it: it prints what the leader prints and exits with its status,
// instead of waiting for the deploy lock to deploy whatever is left. A leader is frozen from the
// moment it re-reads main to fix what it ships (see deploy.mjs), and a caller that finds one
// frozen starts a leader of its own.
//
// A registry entry is `<stamp>-<id>.json` (the leader's process, its arguments, its phase) with
// the leader's output in `<stamp>-<id>.out`, one JSON object per line: { line } for a line printed,
// { end: { code, froze, error? } } as the last one. Every change of phase and the end go through a
// short lock, the gate, which is also held while a caller reads the registry. So a caller either
// reads the leader before it froze (and the leader reads main afterwards, so the caller's merge is
// in what it ships) or after (and does not join).

const FEED_RETENTION_MS = 6 * 60 * 60_000; // a follower reads the end of a feed within seconds
const FOLLOW_POLL_MAX_MS = 1000;

const dirOf = (d, repo) => join(d.tmpRoot, 'deploys', repoKeyOf(repo));
const gateOf = (d, repo) => join(d.tmpRoot, 'locks', `deploy-intake-${repoKeyOf(repo)}`);

// Only a deploy that asks for the same thing gets another one's result.
const keyOf = (names, redeploy) => JSON.stringify({ names: [...names].sort(), redeploy: Boolean(redeploy) });

// The raw lock, not the interrupt-aware one: an interrupted leader still has to write its end.
async function underGate(d, repo, fn) {
  const release = await acquire(gateOf(d, repo), await ownerInfo({ repo, command: 'deploy intake' }), { pollMs: Math.min(d.pollMs, 200) });
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function writeAtomic(file, value) {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`);
  await rename(tmp, file);
}

// The leaders that are still there, oldest first. A leader whose process is gone is dropped.
async function liveLeaders(dir) {
  const out = [];
  for (const name of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort()) {
    const file = join(dir, name);
    let rec;
    try {
      rec = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue; // being replaced or unreadable: not a leader to join
    }
    if (await isStale(rec)) await rm(file, { force: true });
    else out.push(rec);
  }
  return out;
}

async function sweepFeeds(dir) {
  for (const name of await readdir(dir).catch(() => [])) {
    const st = await stat(join(dir, name)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > FEED_RETENTION_MS) await rm(join(dir, name), { force: true });
  }
}

// The leader's side: what the deploy that runs for everyone tells its followers.
async function startLeader({ d, repo, dir, key }) {
  const id = randomUUID();
  const stamp = String(Date.now()).padStart(15, '0');
  const file = join(dir, `${stamp}-${id}.json`);
  const feed = join(dir, `${stamp}-${id}.out`);
  const rec = { ...(await ownerInfo({ repo, command: 'deploy' })), id, key, phase: 'open', file, feed };
  await writeFile(feed, '');
  await writeAtomic(file, rec);
  let froze = false;
  let ended = false;
  return {
    // Synchronous, like the printing it follows, so lines keep their order.
    out(line) {
      if (ended) return;
      try {
        appendFileSync(feed, `${JSON.stringify({ line })}\n`);
      } catch { /* the leader's own output goes on */ }
    },
    // From here on nobody joins: what this deploy ships is decided after this returns.
    async freeze() {
      if (froze) return;
      await underGate(d, repo, () => writeAtomic(file, { ...rec, phase: 'frozen' }));
      froze = true;
    },
    // Once: the verdict goes to the followers and the leader leaves the registry, so nobody joins a
    // deploy that is over.
    async end({ code, error }) {
      if (ended) return;
      ended = true;
      await underGate(d, repo, async () => {
        appendFileSync(feed, `${JSON.stringify({ end: { code, froze, ...(error ? { error } : {}) } })}\n`);
        await rm(file, { force: true });
      });
    },
  };
}

// { lead } when this deploy is the one that runs, { follow } (the leader's record) when it joins one.
export async function enterDeploy({ d, repo, names, redeploy }) {
  const dir = dirOf(d, repo);
  const key = keyOf(names, redeploy);
  return await underGate(d, repo, async () => {
    await mkdir(dir, { recursive: true });
    await sweepFeeds(dir);
    const leader = (await liveLeaders(dir)).find((rec) => rec.phase !== 'frozen' && rec.key === key);
    return leader ? { follow: leader } : { lead: await startLeader({ d, repo, dir, key }) };
  });
}

// Prints what the leader prints. { code } once it has a verdict that came from a deploy that went
// as far as building; { code: null } when the leader ended before that (or vanished), and this
// caller has to deploy for itself.
export async function followDeploy({ d, repo, leader }) {
  d.out(`↪ ${repo}: a deploy started at ${localTime(leader.since)} (pid ${leader.pid}) has not begun building; this one joins it, with the same result`);
  const pollMs = Math.min(d.pollMs, FOLLOW_POLL_MAX_MS);
  let seen = 0;
  for (;;) {
    if (isInterrupted()) throw abortedError();
    // Read before asking whether the leader is alive: a verdict written just before it exited counts.
    const gone = await isStale(leader);
    const lines = (await readFile(leader.feed, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    for (const raw of lines.slice(seen)) {
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof item.line === 'string') d.out(item.line);
      if (item.end) {
        if (!item.end.froze) return { code: null };
        if (item.end.error) d.out(`✗ the deploy this one joined failed: ${item.end.error}`);
        return { code: item.end.code };
      }
    }
    seen = lines.length;
    if (gone) return { code: null };
    await new Promise((resolve) => setTimeout(resolve, pollMs)); // real time: d.sleep may be a test's clock
  }
}

// What a deploy that takes no part (a dry run) gets in the leader's place.
export const NO_LEADER = { out() {}, async freeze() {}, async end() {} };
