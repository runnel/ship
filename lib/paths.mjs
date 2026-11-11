import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmod, lstat, mkdir } from 'node:fs/promises';

const uid = process.getuid?.() ?? 'user';

// Short-lived state (locks, lanes, worktrees). Per user: /private/tmp and /tmp are shared by every
// account on the machine, so a fixed name there would let whoever creates it first decide where
// ship writes and deletes (ensurePrivateDir verifies it before use). On macOS /private/tmp is
// wiped at reboot, which is what we want for locks; it is also short enough for unix-socket paths.
// Both roots are made absolute: git runs in the directory that holds a mirror, so a relative
// SHIP_HOME or SHIP_TMP would be read against that directory instead of the one it was given in.
export const SHIP_TMP = resolve(
  process.env.SHIP_TMP ?? join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), `ship-${uid}`));

// Durable state (mirrors, logs).
export const SHIP_HOME = resolve(process.env.SHIP_HOME ?? join(homedir(), '.ship'));

// A directory only this user can enter: created 0700, and refused if it is a symlink, a file, or
// owned by someone else. A looser mode on our own directory is tightened.
export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
}
