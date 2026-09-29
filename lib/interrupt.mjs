import { killActiveChildren } from './proc.mjs';

// On SIGINT/SIGTERM/SIGHUP (bin/ship.mjs forwards them to ship's process group): stop the running
// command, then unwind in reverse registration order — post an error status, remove the
// worktree, release locks — and exit 130. If the wrapper itself is killed with SIGKILL nothing is
// forwarded, and ship finishes its run and posts its status as usual.
//
// From the first moment the process counts as interrupted (isInterrupted): no new command is
// started, and the check flow posts no verdict of its own, so the only status an interrupted run
// leaves behind is the error posted by the unwind. A repeated signal does not start a second
// unwind (the first repeat says why nothing happens); a hard deadline keeps a hung handler from
// holding the process forever.
const UNWIND_LIMIT_MS = 30_000;
const handlers = [];
let installed = false;
let interrupted = false;
let toldRepeat = false;

export const isInterrupted = () => interrupted;

async function unwind() {
  await killActiveChildren();
  for (const h of [...handlers].reverse()) {
    try { await h(); } catch { /* keep unwinding */ }
  }
}

export function onInterrupt(fn) {
  handlers.push(fn);
  if (!installed) {
    installed = true;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        if (interrupted) {
          if (!toldRepeat) {
            toldRepeat = true;
            process.stderr.write('ship: already interrupted, cleaning up (at most 30 s); Ctrl-\\ leaves the wrapper and lets it finish in the background\n');
          }
          return;
        }
        interrupted = true; // before anything asynchronous
        setTimeout(() => process.exit(130), UNWIND_LIMIT_MS).unref();
        unwind().finally(() => process.exit(130));
      });
    }
  }
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}
