import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API = 'https://api.cloudflare.com/client/v4/accounts/acc/';

// The fake `wrangler`: what it does is appended to the events file (the API side applies it) and to
// the output file wrangler is given, in the shape wrangler 4.x writes: a `wrangler-session` record
// first, then a `version-upload` or `deploy` record.
const wranglerSource = (events, calls, behaviour, logPath) => `
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  if (i >= 0) return args[i + 1] ?? null;
  const eq = args.find((a) => a.startsWith(n + '='));
  return eq ? eq.slice(n.length + 1) : null;
};
const cmd = args[0] === 'versions' ? 'versions ' + args[1] : args[0];
const configPath = flag('--config') ?? 'wrangler.json';
let worker = null;
let configError = null;
try {
  worker = JSON.parse(readFileSync(configPath, 'utf8')).name;
  if (typeof worker !== 'string' || !worker) throw new Error('it has no "name"');
} catch (e) {
  worker = null;
  configError = String(e.message).split('\\n')[0];
}
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cmd, args, cwd: process.cwd(), worker,
  envKeys: Object.keys(process.env).sort(), token: process.env.CLOUDFLARE_API_TOKEN ?? null }) + '\\n');
const record = (r) => process.env.WRANGLER_OUTPUT_FILE_PATH
  && appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ ...r, timestamp: new Date().toISOString() }) + '\\n');
record({ type: 'wrangler-session', version: 1, wrangler_version: '4.0.0', command_line_args: args, log_file_path: ${JSON.stringify(logPath)} });
if (configError) { process.stderr.write('fake wrangler: cannot read the Worker name from ' + configPath + ': ' + configError + '\\n'); process.exit(1); }
const b = JSON.parse(readFileSync(${JSON.stringify(behaviour)}, 'utf8'))[cmd] ?? {};
const event = (e) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ worker, ...e }) + '\\n');
const message = flag('--message');
const id = randomUUID();
if (b.create !== false && cmd === 'versions upload') event({ type: 'version', id, message, triggered: 'version_upload' });
if (b.create !== false && cmd === 'deploy') {
  event({ type: 'version', id, message, triggered: 'upload' });
  event({ type: 'deployment', versionId: id, message: message && message.length > 50 ? message.slice(0, 47) + '...' : message, triggered: 'upload' });
}
if (b.sleepMs) await new Promise((r) => setTimeout(r, b.sleepMs));
if (b.exit) { process.stderr.write('fake wrangler: failing as told\\n'); process.exit(b.exit); }
const done = { version: 1, worker_name: worker, worker_tag: 'tag-' + worker, version_id: id };
if (b.create !== false && cmd === 'versions upload') record({ type: 'version-upload', ...done, preview_url: 'https://' + id.slice(0, 8) + '-' + worker + '.example.workers.dev' });
if (b.create !== false && cmd === 'deploy') record({ type: 'deploy', ...done, targets: [] });
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
  await writeFile(script, wranglerSource(events, callsFile, behaviour, join(dir, 'wrangler.log')));
  const bin = join(dir, 'bin', 'wrangler');
  await writeFile(bin, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`);
  await chmod(bin, 0o755);

  let second = 0;
  const now = () => new Date(clockStart + 1000 * second++).toISOString(); // one second per event
  const state = {};
  const ensure = (name) => (state[name] ??= { versions: [], deployments: [], previews: true, crons: [] });
  const annotations = (message, triggered) => ({ ...(message ? { 'workers/message': message } : {}), 'workers/triggered_by': triggered });
  const insertVersion = (name, { id = randomUUID(), message = null, triggered = 'version_upload' } = {}) => {
    const w = ensure(name);
    const v = { id, number: w.versions.length + 1, metadata: { created_on: now(), source: 'wrangler' }, annotations: annotations(message, triggered) };
    w.versions.push(v);
    return v;
  };
  const insertDeployment = (name, versionId, { message = null, triggered = 'deployment', source = 'wrangler' } = {}) => {
    const d = { id: randomUUID(), created_on: now(), source, strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }], annotations: annotations(message, triggered) };
    ensure(name).deployments.push(d);
    return d;
  };
  for (const [name, spec] of Object.entries(workers)) {
    ensure(name).previews = spec.previews ?? true;
    state[name].crons = spec.crons ?? [];
    for (const v of spec.versions ?? []) insertVersion(name, v);
    for (const d of spec.deployments ?? []) insertDeployment(name, d.versionId ?? state[name].versions.at(-1).id, d);
  }
  // Events the fake wrangler appended are applied once, in order, before anything reads or changes
  // the state. Only complete lines count (the last one may still be being written), and a line is
  // counted as applied only after it was, so a failure part-way never applies one twice.
  let applied = 0;
  const sync = () => {
    const text = readFileSync(events, 'utf8');
    const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
    while (applied < lines.length) {
      const e = JSON.parse(lines[applied]);
      if (e.type === 'version') insertVersion(e.worker, e);
      else if (e.type === 'deployment') insertDeployment(e.worker, e.versionId, e);
      else throw new Error(`fake cloud: unknown event type ${e.type}`);
      applied++;
    }
  };
  const liveOf = (name) => state[name]?.deployments.at(-1)?.versions[0].version_id ?? null;
  const apiCalls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => json({ success: false, errors: [{ code: 10007, message: 'This Worker does not exist' }] }, 404);
  const page = (items, params) => {
    const per = Number(params.get('per_page') ?? 10);
    const n = Number(params.get('page') ?? 1);
    return [...items].reverse().slice((n - 1) * per, n * per); // newest first
  };
  const METHODS = { 'account-subdomain': ['GET'], subdomain: ['GET'], schedules: ['GET'], versions: ['GET'], deployments: ['GET', 'POST'] };

  const cloud = {
    bin, apiCalls,
    addVersion: (name, v) => { sync(); return insertVersion(name, v); },
    addDeployment: (name, versionId, d) => { sync(); return insertDeployment(name, versionId, d); },
    live: (name) => { sync(); return liveOf(name); },
    state: async (name) => { sync(); return state[name]; },
    wranglerCalls: async () => (await readFile(callsFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    setWrangler: (b) => writeFile(behaviour, JSON.stringify(b)),
    async fetch(url, init = {}) {
      sync();
      const method = init.method ?? 'GET';
      if (url.startsWith(API)) {
        const path = url.slice(API.length);
        apiCalls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
        const m = path.match(/^workers\/scripts\/([^/?]+)\/(deployments|versions|subdomain|schedules)(?:\?(.*))?$/);
        const route = path === 'workers/subdomain' ? 'account-subdomain' : m?.[2];
        // A route the fake does not model is a mistake in the test, not a missing Worker.
        if (!METHODS[route]?.includes(method)) throw new Error(`fake cloud: no such API route: ${method} ${path}`);
        if (route === 'account-subdomain') return json({ success: true, result: { subdomain: 'example' } });
        const name = decodeURIComponent(m[1]);
        if (!state[name]) return notFound();
        const w = state[name];
        if (route === 'subdomain') return json({ success: true, result: { enabled: true, previews_enabled: w.previews } });
        if (route === 'schedules') return json({ success: true, result: { schedules: w.crons.map((cron) => ({ cron })) } });
        const params = new URLSearchParams(m[3] ?? '');
        if (route === 'deployments' && method === 'POST') {
          const body = JSON.parse(init.body);
          const target = w.versions.find((v) => v.id === body.versions[0].version_id);
          if (!target) return json({ success: false, errors: [{ code: 10209, message: 'Version not found' }] }, 400);
          const liveNumber = w.versions.find((v) => v.id === liveOf(name))?.number ?? 0;
          const secretSince = w.versions.some((v) => v.annotations['workers/triggered_by'] === 'secret' && v.number > target.number && v.number <= liveNumber);
          if (secretSince && params.get('force') !== 'true') {
            return json({ success: false, errors: [{ code: 10220, message: 'A secret has changed since this version was active. The following secrets have changed: K' }] }, 400);
          }
          return json({ success: true, result: insertDeployment(name, target.id, { message: body.annotations['workers/message'], source: 'api' }) });
        }
        if (route === 'deployments') return json({ success: true, result: { deployments: page(w.deployments, params) } });
        return json({ success: true, result: { items: page(w.versions, params) } });
      }
      // A probe: a preview host names its version; a live host serves the current deployment.
      const u = new URL(url);
      const preview = u.hostname.match(/^([0-9a-f]{8})-(.+)\.example\.workers\.dev$/);
      if (!preview && !Object.hasOwn(hosts, u.origin)) throw new Error(`fake cloud: no Worker is mapped to the host ${u.origin}`);
      const worker = preview ? preview[2] : hosts[u.origin];
      const versionId = preview ? state[worker]?.versions.find((v) => v.id.startsWith(preview[1]))?.id ?? null : liveOf(worker);
      const answer = await probe({ worker, versionId, path: u.pathname, method, preview: Boolean(preview), cloud });
      const { status, body = '' } = typeof answer === 'number' ? { status: answer } : answer;
      return new Response(status === 204 || status === 304 ? null : body, { status });
    },
  };
  return cloud;
}
