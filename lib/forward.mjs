// How the wrapper (bin/ship.mjs) passes a signal on to ship. The first one goes to ship's whole
// process group: the running step and everything it started stop together. Later ones go to ship
// alone. Ship ignores a repeated signal, while by then the group also holds the helpers of its
// unwind (gh posting the error status, git removing the worktree), which a repeated group signal
// would kill and leave the status at "pending".
export function signalForwarder(pid, kill = process.kill.bind(process)) {
  let first = true;
  return (sig) => {
    const target = first ? -pid : pid;
    first = false;
    try {
      kill(target, sig);
    } catch { /* already gone */ }
  };
}
