// Times are shown in the machine's time zone; SHIP_TZ (an IANA name such as "UTC") overrides it. A
// zone the runtime does not know falls back to the machine's: a typo must not break a running check.
export function localTime(iso, { timeZone = process.env.SHIP_TZ || undefined } = {}) {
  const format = (zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let formatter;
  try {
    formatter = format(timeZone);
  } catch {
    formatter = format(undefined);
  }
  return formatter.format(new Date(iso));
}

// A time read from a record that may be missing or damaged must not stop the command reporting it.
export const timeOr = (iso, fallback = '?') => (typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? localTime(iso) : fallback);

export function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Text that becomes a public commit status must not carry local paths (git and node errors quote
// them): the longest root is replaced first, the home directory last. sysTmp is the system temp
// directory, where configs are evaluated.
export function scrubPaths(text, { tmp, mirrors, logs, sysTmp, home }) {
  const pairs = [[tmp, '$SHIP_TMP'], [mirrors, '$SHIP_MIRRORS'], [logs, '$SHIP_LOGS'], [sysTmp, '$TMPDIR'], [home, '~']]
    .map(([path, label]) => [path && path.length > 1 ? path.replace(/\/+$/, '') : path, label])
    .filter(([path]) => path)
    .sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [path, label]) => out.split(path).join(label), String(text));
}
