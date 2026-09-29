import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Short-lived state (locks, lanes, worktrees). On macOS /private/tmp is wiped at reboot, which
// is what we want for locks; it is also short enough for unix-socket paths.
export const SHIP_TMP =
  process.env.SHIP_TMP ?? (process.platform === 'darwin' ? '/private/tmp/ship' : join(tmpdir(), 'ship'));

// Durable state (mirrors, logs).
export const SHIP_HOME = process.env.SHIP_HOME ?? join(homedir(), '.ship');
