import { spawn } from 'node:child_process';
import { buildEnv, capture } from './proc.mjs';

// `pmset -g batt` (macOS) starts with "Now drawing from 'Battery Power'" or "'AC Power'" (a UPS
// reads "'UPS Power'").
export const drawsFromBattery = (pmsetOutput) => /^Now drawing from 'Battery Power'/m.test(String(pmsetOutput));

// True only when the machine says it is on battery. Anywhere pmset does not exist, or fails, the
// answer is no: this only ever feeds a warning.
export async function onBatteryPower({ platform = process.platform, run = capture } = {}) {
  if (platform !== 'darwin') return false;
  try {
    return drawsFromBattery(await run('pmset', ['-g', 'batt'], { timeout: 5000 }));
  } catch {
    return false;
  }
}

// macOS: no idle sleep while ship land's check runs (`caffeinate -i`), until stop() or until this
// process exits (`-w`). It does not keep a closed lid from sleeping. Detached, in a process group of
// its own, so the sweep that ends a check's strays leaves it alone. Elsewhere, or when caffeinate
// cannot be started, nothing.
export function keepAwake({ platform = process.platform, spawnFn = spawn, pid = process.pid } = {}) {
  if (platform !== 'darwin') return { stop() {} };
  let child;
  try {
    child = spawnFn('caffeinate', ['-i', '-w', String(pid)], { detached: true, stdio: 'ignore', env: buildEnv() });
    child.on('error', () => {});
    child.unref();
  } catch {
    return { stop() {} };
  }
  return { stop() { try { child.kill(); } catch { /* gone */ } } };
}
