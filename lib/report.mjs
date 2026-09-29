// Times are shown in the machine's time zone; SHIP_TZ (an IANA name such as "UTC") overrides it.
export function localTime(iso, { timeZone = process.env.SHIP_TZ || undefined } = {}) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Text that becomes a public commit status must not carry local paths (git and node errors quote
// them): the longest root is replaced first, the home directory last.
export function scrubPaths(text, { tmp, mirrors, logs, home }) {
  const pairs = [[tmp, '$SHIP_TMP'], [mirrors, '$SHIP_MIRRORS'], [logs, '$SHIP_LOGS'], [home, '~']]
    .filter(([path]) => path)
    .sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [path, label]) => out.split(path).join(label), String(text));
}
