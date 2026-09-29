const TALLINN = new Intl.DateTimeFormat('et-EE', {
  timeZone: 'Europe/Tallinn',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function tallinn(iso) {
  return TALLINN.format(new Date(iso));
}

export function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
