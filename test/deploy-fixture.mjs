import { join } from 'node:path';
import { commitFiles, fakeGh, git, makeOrigin, tempDir } from './helpers.mjs';
import { runDeploy } from '../lib/deploy.mjs';
import { fakeCloud } from './fake-cloud.mjs';

// `docsOnly` and `appIgnore` are JS array literals for the config's docsOnly and the app's ignore.
// `third: true` adds `job`, a direct deployable that depends on nothing (its files and Worker are
// added by setupDeploy; the seed must name example-job).
export const configText = (bin, { guard = 'test -x tools/wrangler', tickPaths = "['workers/tick/**']", requires = '[]', migrationPaths = "['db/*.sql']", third = false, docsOnly = '[]', appIgnore = '[]' } = {}) => `export default {
  repo: 't/r',
  docsOnly: ${docsOnly},
  checks: [
    { name: 'unit', paths: ['**'], steps: ['true'] },
    { name: 'guard', paths: ['workers/**'], onDeploy: true, steps: [${JSON.stringify(guard)}] },
  ],
  deploySetup: ['mkdir -p tools && cp ${bin} tools/wrangler'],
  deployables: [
    { name: 'app', worker: 'example-app', cwd: 'app', paths: ['app/**'], ignore: ${appIgnore}, mode: 'versioned', wrangler: 'tools/wrangler',
      build: 'mkdir -p .next && echo BUILD42 > .next/BUILD_ID',
      probes: [{ path: '/health', status: 200 }], liveHost: 'https://app.example.com', liveMarker: { path: '/login', file: '.next/BUILD_ID' } },
    { name: 'tick', worker: 'example-tick', cwd: 'workers/tick', paths: ${tickPaths}, mode: 'direct', wrangler: 'tools/wrangler',
      probes: [{ path: '/', status: 403 }], liveHost: 'https://tick.example.com', after: ['app'] },${third ? `
    { name: 'job', worker: 'example-job', cwd: 'workers/job', paths: ['workers/job/**'], mode: 'direct', wrangler: 'tools/wrangler',
      probes: [{ path: '/', status: 403 }], liveHost: 'https://job.example.com' },` : ''}
  ],
  migrations: { paths: ${migrationPaths} },
  requires: ${requires},
  credentials: { file: '/unused/creds.env', map: { CLOUDFLARE_API_TOKEN: 'T', CLOUDFLARE_ACCOUNT_ID: 'A' } },
};\n`;
export const FILES = { 'app/wrangler.json': '{"name":"example-app"}', 'app/src/a.ts': 'export const a = 1;\n', 'workers/tick/wrangler.json': '{"name":"example-tick"}', 'workers/tick/src/index.ts': 'export default {};\n', 'db/001.sql': '' };
export const THIRD_FILES = { 'workers/job/wrangler.json': '{"name":"example-job"}', 'workers/job/src/index.ts': 'export default {};\n' };
export const healthy = ({ path }) => (path === '/login' ? { status: 200, body: '<!--BUILD42-->' } : path === '/' ? 403 : 200);
export const at = (sha) => ({ versions: [{ message: `sha:${sha} x` }], deployments: [{ versionId: null, message: `sha:${sha} x` }] });

// seed({ first, head }) → fakeCloud workers; change → files committed on main after the first commit.
export async function setupDeploy({ options = {}, seed, change = null, probe = healthy, clockStart } = {}) {
  const root = await tempDir('deploy-');
  const cloudDir = join(root, 'cloud');
  const { origin, work } = await makeOrigin({ 'ship.config.mjs': configText(join(cloudDir, 'bin', 'wrangler'), options), ...FILES, ...(options.third ? THIRD_FILES : {}) });
  const first = (await git(['rev-parse', 'HEAD'], work)).trim();
  const head = change ? await commitFiles(work, change, 'change (#9)') : first;
  await git(['push', '--quiet', 'origin', 'main'], work);
  await git(['remote', 'set-url', 'origin', 'https://github.com/t/r.git'], work);
  const cloud = await fakeCloud({ dir: cloudDir, workers: seed({ first, head }), probe, clockStart, hosts: { 'https://app.example.com': 'example-app', 'https://tick.example.com': 'example-tick', 'https://job.example.com': 'example-job' } });
  const { gh } = await fakeGh(root, { pr: null });
  const lines = [];
  const deps = {
    gh, remoteUrl: () => origin, mirrorRoot: join(root, 'm'), tmpRoot: join(root, 'tmp'), logRoot: join(root, 'logs'), stateRoot: join(root, 'state'),
    out: (l) => lines.push(l), pollMs: 10, fetch: cloud.fetch,
    readCredentials: async () => ({ CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'acc' }),
    probeWindowMs: 0, probeIntervalMs: 0, sleep: async () => {},
  };
  const deploy = (names = [], dryRun = false, redeploy = false) => runDeploy({ cwd: work, names, dryRun, redeploy, deps });
  return { cloud, lines, deploy, deps, first, head, root, work };
}
