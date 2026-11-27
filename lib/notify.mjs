import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEnv, isPid } from './proc.mjs';
import { firstLine, repoKeyOf } from './shared.mjs';

// Telling the owner, outside ship's own output, that a land has merged and now waits on them: ship
// land usually runs in the background of some other session, where nobody reads its lines.
//
// `config.notify` (optional): { command: [file, ...args], desktop: true }. The command gets the
// message on stdin and is run without a shell, with ship's plain child environment, for at most
// `timeoutSec` (default 30). `desktop` (default true) shows a macOS notification when there is no
// command or the command fails. Without a notify block ship sends nothing.

const DEFAULT_TIMEOUT_SEC = 30;

// One marker per migration file and hold, in the durable state directory: the first land that sees
// the file waiting creates it (exclusively) and sends; every other land, and every later tick, finds
// it there. Whoever removes it once the file is cleared and live sends the second message.
const markerDir = (root, repo) => join(root, 'notified', repoKeyOf(repo));
const markerFile = (root, repo, file) => join(markerDir(root, repo), `${encodeURIComponent(file)}.json`);

// True when this caller made the marker (and so sends), false when it was there already.
export async function claimMarker(root, repo, file, value) {
  await mkdir(markerDir(root, repo), { recursive: true, mode: 0o700 });
  try {
    await writeFile(markerFile(root, repo, file), `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  }
}

// The files with a marker, by their repository path.
export async function markedFiles(root, repo) {
  const names = await readdir(markerDir(root, repo)).catch(() => []);
  return names.filter((n) => n.endsWith('.json')).map((n) => decodeURIComponent(n.slice(0, -'.json'.length)));
}

// When the marker of `file` was made, in ms (NaN when it cannot be read).
export async function markedAtMs(root, repo, file) {
  try {
    return Date.parse(JSON.parse(await readFile(markerFile(root, repo, file), 'utf8')).at);
  } catch {
    return NaN;
  }
}

// True when this caller removed the marker (and so sends the second message).
export async function releaseMarker(root, repo, file) {
  try {
    await rm(markerFile(root, repo, file));
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

// Runs `command` with `text` on stdin. Resolves to null on exit 0, else to why it failed. The command
// leads a process group of its own, so a timeout kills everything it started (a shell script's curl
// too), and its pipes are closed so nothing it left can keep the land's process alive.
export function runNotifyCommand(command, text, { timeoutMs, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd, env: buildEnv(), stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    } catch (e) {
      resolve(firstLine(e.message));
      return;
    }
    let err = '';
    let settled = false;
    const done = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(why);
    };
    const timer = setTimeout(() => {
      if (isPid(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
      child.stderr?.destroy();
      child.stdin?.destroy();
      done(`timed out after ${timeoutMs / 1000} s`);
    }, timeoutMs);
    child.stderr.on('data', (b) => { if (err.length < 4096) err += b; });
    child.on('error', (e) => done(firstLine(e.message)));
    child.on('close', (code, signal) => done(code === 0 ? null : `exit ${code ?? signal}${err.trim() ? `: ${firstLine(err)}` : ''}`));
    child.stdin.on('error', () => {}); // a command that does not read stdin closes it early
    child.stdin.end(text);
  });
}

// A macOS notification (Notification Center). Elsewhere, or when osascript fails, nothing.
export function desktopNotify(title, text) {
  if (process.platform !== 'darwin') return Promise.resolve('not macOS');
  const q = (s) => JSON.stringify(String(s)); // an AppleScript string literal: "…" with \" and \\
  const body = text.split('\n').slice(0, 3).join(' · ');
  return runNotifyCommand(['osascript', '-e', `display notification ${q(body)} with title ${q(title)}`], '', { timeoutMs: 10_000 });
}

// Sends `text` through the configured channel(s). Never throws: a notification that cannot be sent
// is said in the land's own output and the land goes on. → true when one was sent.
export async function notifyOwner({ d, notify, title, text, cwd }) {
  if (!notify) return false;
  const run = d.notifyCommand ?? runNotifyCommand;
  const desktop = d.desktopNotify ?? desktopNotify;
  let failed = null;
  if (notify.command) {
    failed = await run(notify.command, text, { timeoutMs: (notify.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000, cwd }).catch((e) => firstLine(e?.message));
    if (!failed) return true;
    d.out(`! the notify command failed (${failed})${notify.desktop ? '; showing a desktop notification instead' : ''}`);
  }
  if (!notify.desktop) return false;
  const why = await desktop(title, text).catch((e) => firstLine(e?.message));
  if (why) d.out(`! the desktop notification failed (${why})`);
  return !why;
}
