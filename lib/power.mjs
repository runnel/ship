import { capture } from './proc.mjs';

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
