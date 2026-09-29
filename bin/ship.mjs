#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signalForwarder } from '../lib/forward.mjs';

if (process.env.SHIP_GROUP_LEADER !== '1') {
  // Re-exec as the leader of a new process group: every child (npm, builds, wrangler) then
  // shares one group, which lock liveness tests. Signals sent to this wrapper are forwarded to
  // the group (the first one; see lib/forward.mjs); ship cleans up (lib/interrupt.mjs). If the
  // wrapper is SIGKILLed, the group keeps running and finishes its work.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, SHIP_GROUP_LEADER: '1' },
  });
  const forward = signalForwarder(child.pid);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => forward(sig));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  const { main } = await import('../lib/cli.mjs');
  process.exitCode = await main(process.argv.slice(2));
}
