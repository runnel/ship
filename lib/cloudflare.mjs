import { readFile } from 'node:fs/promises';

const API = 'https://api.cloudflare.com/client/v4';

// KEY=VALUE lines (an optional `export ` prefix), matching surrounding quotes removed, nothing
// expanded: a value such as `a$9b` must arrive exactly as written, which a shell `source` breaks.
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Exactly the mapped keys, renamed to the names wrangler reads.
export async function readCredentials({ file, map }) {
  const parsed = parseEnvFile(await readFile(file, 'utf8'));
  const out = {};
  for (const [envName, fileKey] of Object.entries(map)) {
    if (!parsed[fileKey]) throw new Error(`${file}: ${fileKey} is missing or empty`);
    out[envName] = parsed[fileKey];
  }
  return out;
}

export class CloudflareError extends Error {
  constructor(message, codes) {
    super(message);
    this.codes = codes;
  }
}

export function cloudflare({ token, accountId, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${API}/accounts/${accountId}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!json?.success) {
      const errors = json?.errors ?? [];
      const text = errors.map((e) => `${e.message} [${e.code}]`).join('; ') || `HTTP ${res.status}`;
      throw new CloudflareError(`Cloudflare ${method} ${path}: ${text}`, errors.map((e) => e.code));
    }
    return json.result;
  };
  const script = (worker) => `workers/scripts/${encodeURIComponent(worker)}`;
  const missing = (e) => e instanceof CloudflareError && e.codes.includes(10007);
  return {
    async deployments(worker) {
      try {
        const r = await call('GET', `${script(worker)}/deployments?per_page=50`);
        return [...(r.deployments ?? [])].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
      } catch (e) {
        if (missing(e)) return [];
        throw e;
      }
    },
    async versions(worker) {
      const out = [];
      for (let page = 1; page <= 2; page++) {
        let r;
        try {
          r = await call('GET', `${script(worker)}/versions?per_page=100&page=${page}`);
        } catch (e) {
          if (missing(e)) return [];
          throw e;
        }
        const items = r.items ?? [];
        out.push(...items);
        if (items.length < 100) break;
      }
      return out.sort((a, b) => b.number - a.number);
    },
    subdomain: (worker) => call('GET', `${script(worker)}/subdomain`),
    schedules: async (worker) => ((await call('GET', `${script(worker)}/schedules`)).schedules ?? []).map((x) => x.cron),
    accountSubdomain: async () => (await call('GET', 'workers/subdomain')).subdomain,
    createDeployment: (worker, versionId, message, { force = false } = {}) => call('POST', `${script(worker)}/deployments${force ? '?force=true' : ''}`, {
      strategy: 'percentage',
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { 'workers/message': message },
    }),
  };
}
