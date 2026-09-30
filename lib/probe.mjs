const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_CACHE = { 'cache-control': 'no-cache' };

export async function probeOnce(base, probe, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  try {
    const res = await fetchImpl(`${base}${probe.path}`, {
      method: probe.method ?? 'GET',
      redirect: probe.followRedirects ? 'follow' : 'manual',
      headers: NO_CACHE,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
    return res.status;
  } catch (e) {
    return `error: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`;
  }
}

export async function probeAll(base, probes, { fetchImpl, windowMs = 60_000, intervalMs = 3000, sleep = realSleep, now = Date.now } = {}) {
  const started = now();
  const results = probes.map((p) => ({ path: p.path, method: p.method ?? 'GET', want: p.status, got: null, ok: false }));
  for (;;) {
    for (const [i, p] of probes.entries()) {
      if (results[i].ok) continue;
      results[i].got = await probeOnce(base, p, { fetchImpl });
      results[i].ok = results[i].got === p.status;
    }
    const ok = results.every((r) => r.ok);
    if (ok || now() - started >= windowMs) return { ok, results };
    await sleep(intervalMs);
  }
}

export async function warm(base, paths, { fetchImpl } = {}) {
  for (const path of paths) await probeOnce(base, { path, followRedirects: true }, { fetchImpl });
}

export async function waitForText(base, path, text, { fetchImpl = globalThis.fetch, windowMs = 60_000, intervalMs = 3000, sleep = realSleep, now = Date.now } = {}) {
  const started = now();
  for (;;) {
    try {
      const res = await fetchImpl(`${base}${path}`, { headers: NO_CACHE, signal: AbortSignal.timeout(15_000) });
      if ((await res.text()).includes(text)) return true;
    } catch { /* retried below */ }
    if (now() - started >= windowMs) return false;
    await sleep(intervalMs);
  }
}

export const describeProbes = (results) =>
  results.filter((r) => !r.ok).map((r) => `${r.method} ${r.path} want ${r.want} got ${r.got}`).join('; ');

export const probeOptions = (d) => ({ fetchImpl: d.fetch, windowMs: d.probeWindowMs, intervalMs: d.probeIntervalMs, sleep: d.sleep });
