import { killActiveChildren } from './proc.mjs';

// On SIGINT/SIGTERM/SIGHUP (bin/ship.mjs forwards them to ship's process group): stop the running
// command, then unwind in reverse registration order — post an error status, remove the
// worktree, release locks — and exit 130. If the wrapper itself is killed with SIGKILL nothing is
// forwarded, and ship finishes its run and posts its status as usual.
const handlers = [];
let installed = false;

export function onInterrupt(fn) {
  handlers.push(fn);
  if (!installed) {
    installed = true;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(sig, async () => {
        await killActiveChildren();
        for (const h of [...handlers].reverse()) {
          try { await h(); } catch { /* keep unwinding */ }
        }
        process.exit(130);
      });
    }
  }
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}
