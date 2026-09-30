import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4/accounts/acc/';

const wranglerSource = (events, calls, behaviour) => `
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cmd = args[0] === 'versions' ? 'versions ' + args[1] : args[0];
const worker = JSON.parse(readFileSync(flag('--config') ?? 'wrangler.json', 'utf8')).name;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cmd, args, cwd: process.cwd(), worker,
  envKeys: Object.keys(process.env).sort(), token: process.env.CLOUDFLARE_API_TOKEN ?? null }) + '\\n');
const b = JSON.parse(readFileSync(${JSON.stringify(behaviour)}, 'utf8'))[cmd] ?? {};
const event = (e) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ worker, ...e }) + '\\n');
const record = (r) => process.env.WRANGLER_OUTPUT_FILE_PATH && appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(r) + '\\n');
const message = flag('--message');
const id = randomUUID();
if (b.create !== false && cmd === 'versions upload') event({ type: 'version', id, message, triggered: 'version_upload' });
if (b.create !== false && cmd === 'deploy') {
  event({ type: 'version', id, message, triggered: 'upload' });
  event({ type: 'deployment', versionId: id, message: message && message.length > 50 ? message.slice(0, 47) + '...' : message, triggered: 'upload' });
}
if (b.sleepMs) await new Promise((r) => setTimeout(r, b.sleepMs));
if (b.exit) { process.stderr.write('fake wrangler: failing as told\\n'); process.exit(b.exit); }
if (b.create !== false && cmd === 'versions upload') record({ type: 'version-upload', version_id: id, preview_url: 'https://' + id.slice(0, 8) + '-' + worker + '.example.workers.dev' });
if (b.create !== false && cmd === 'deploy') record({ type: 'deploy', version_id: id, targets: [] });
`;

export async function fakeCloud({ dir, workers = {}, hosts = {}, probe = () => 200, wrangler = {}, clockStart = Date.UTC(2026, 0, 1) }) {
  await mkdir(join(dir, 'bin'), { recursive: true });
  const events = join(dir, 'events.jsonl');
  const callsFile = join(dir, 'wrangler-calls.jsonl');
  const behaviour = join(dir, 'wrangler-behaviour.json');
  await writeFile(events, '');
  await writeFile(callsFile, '');
  await writeFile(behaviour, JSON.stringify(wrangler));
  const script = join(dir, 'bin', 'wrangler.mjs');
  await writeFile(script, wranglerSource(events, callsFile, behaviour));
  const bin = join(dir, 'bin', 'wrangler');
  await writeFile(bin, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`);
  await chmod(bin, 0o755);

  let second = 0;
  const now = () => new Date(clockStart + 1000 * second++).toISOString(); // one second per event
  const state = {};
  const ensure = (name) => (state[name] ??= { versions: [], deployments: [], previews: true, crons: [] });
  const annotations = (message, triggered) => ({ ...(message ? { 'workers/message': message } : {}), 'workers/triggered_by': triggered });
  const addVersion = (name, { id = randomUUID(), message = null, triggered = 'version_upload' } = {}) => {
    const w = ensure(name);
    const v = { id, number: w.versions.length + 1, metadata: { created_on: now(), source: 'wrangler' }, annotations: annotations(message, triggered) };
    w.versions.push(v);
    return v;
  };
  const addDeployment = (name, versionId, { message = null, triggered = 'deployment', source = 'wrangler' } = {}) => {
    const d = { id: randomUUID(), created_on: now(), source, strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }], annotations: annotations(message, triggered) };
    ensure(name).deployments.push(d);
    return d;
  };
  for (const [name, spec] of Object.entries(workers)) {
    ensure(name).previews = spec.previews ?? true;
    state[name].crons = spec.crons ?? [];
    for (const v of spec.versions ?? []) addVersion(name, v);
    for (const d of spec.deployments ?? []) addDeployment(name, d.versionId ?? state[name].versions.at(-1).id, d);
  }
  // Events the fake wrangler appended are applied once, in order; concurrent calls may read the
  // file at different moments, so the count of applied lines only ever grows.
  let applied = 0;
  const sync = async () => {
    const lines = (await readFile(events, 'utf8')).split('\n').filter(Boolean);
    for (const line of lines.slice(applied)) {
      const e = JSON.parse(line);
      if (e.type === 'version') addVersion(e.worker, e);
      else addDeployment(e.worker, e.versionId, e);
    }
    applied = Math.max(applied, lines.length);
  };
  const live = (name) => state[name]?.deployments.at(-1)?.versions[0].version_id ?? null;
  const apiCalls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => json({ success: false, errors: [{ code: 10007, message: 'This Worker does not exist' }] }, 404);

  const cloud = {
    bin, apiCalls, addVersion, addDeployment, live,
    state: async (name) => { await sync(); return state[name]; },
    wranglerCalls: async () => (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    setWrangler: (b) => writeFile(behaviour, JSON.stringify(b)),
    async fetch(url, init = {}) {
      await sync();
      const method = init.method ?? 'GET';
      if (url.startsWith(API)) {
        const path = url.slice(API.length);
        apiCalls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
        if (path === 'workers/subdomain') return json({ success: true, result: { subdomain: 'example' } });
        const m = path.match(/^workers\/scripts\/([^/?]+)\/(deployments|versions|subdomain|schedules)(?:\?(.*))?$/);
        const name = m && decodeURIComponent(m[1]);
        if (!m || !state[name]) return notFound();
        const w = state[name];
        if (m[2] === 'subdomain') return json({ success: true, result: { enabled: true, previews_enabled: w.previews } });
        if (m[2] === 'schedules') return json({ success: true, result: { schedules: w.crons.map((cron) => ({ cron })) } });
        const params = new URLSearchParams(m[3] ?? '');
        if (m[2] === 'deployments' && method === 'POST') {
          const body = JSON.parse(init.body);
          const target = w.versions.find((v) => v.id === body.versions[0].version_id);
          if (!target) return json({ success: false, errors: [{ code: 10210, message: 'Invalid deployment' }] }, 400);
          const liveNumber = w.versions.find((v) => v.id === live(name))?.number ?? 0;
          const secretSince = w.versions.some((v) => v.annotations['workers/triggered_by'] === 'secret' && v.number > target.number && v.number <= liveNumber);
          if (secretSince && params.get('force') !== 'true') {
            return json({ success: false, errors: [{ code: 10220, message: 'A secret has changed since this version was active. The following secrets have changed: K' }] }, 400);
          }
          return json({ success: true, result: addDeployment(name, target.id, { message: body.annotations['workers/message'], source: 'api' }) });
        }
        if (m[2] === 'deployments') return json({ success: true, result: { deployments: [...w.deployments].reverse() } });
        const per = Number(params.get('per_page') ?? 10);
        const page = Number(params.get('page') ?? 1);
        return json({ success: true, result: { items: [...w.versions].reverse().slice((page - 1) * per, page * per) } });
      }
      // A probe: a preview host names its version; a live host serves the current deployment.
      const u = new URL(url);
      const preview = u.hostname.match(/^([0-9a-f]{8})-(.+)\.example\.workers\.dev$/);
      const worker = preview ? preview[2] : hosts[u.origin];
      const versionId = preview ? state[worker]?.versions.find((v) => v.id.startsWith(preview[1]))?.id ?? null : live(worker);
      const answer = await probe({ worker, versionId, path: u.pathname, method, preview: Boolean(preview), cloud });
      const { status, body = '' } = typeof answer === 'number' ? { status: answer } : answer;
      return new Response(status === 204 || status === 304 ? null : body, { status });
    },
  };
  return cloud;
}
