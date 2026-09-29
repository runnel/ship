import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoFromUrl, prInfo, defaultBranch, postStatus, nightlyFailures } from '../lib/github.mjs';
import { fakeGh, tempDir } from './helpers.mjs';

test('parseRepoFromUrl handles https and ssh remotes', () => {
  assert.equal(parseRepoFromUrl('https://github.com/acme/app.git\n'), 'acme/app');
  assert.equal(parseRepoFromUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(parseRepoFromUrl('https://github.com/acme/app'), 'acme/app');
  assert.throws(() => parseRepoFromUrl('https://example.org/x.git'), /GitHub/);
});

test('prInfo, defaultBranch, postStatus and nightlyFailures call gh as expected', async () => {
  const pr = { number: 5, headRefOid: 'a'.repeat(40), headRefName: 'feat', baseRefName: 'main', isCrossRepository: false, state: 'OPEN' };
  const runs = [
    { workflowName: 'verify', conclusion: 'failure', createdAt: '2026-09-29T01:30:00Z', url: 'u1' },
    { workflowName: 'verify', conclusion: 'success', createdAt: '2026-09-28T01:30:00Z', url: 'u0' },
    { workflowName: 'workers', conclusion: 'success', createdAt: '2026-09-29T01:30:00Z', url: 'u2' },
  ];
  const fake = await fakeGh(await tempDir(), { pr, runs });
  assert.deepEqual(await prInfo({ repo: 'acme/app', pr: 'feat', gh: fake.gh }), {
    number: 5, headSha: 'a'.repeat(40), headRef: 'feat', base: 'main', fork: false, state: 'OPEN',
  });
  assert.equal(await defaultBranch({ repo: 'acme/app', gh: fake.gh }), 'main');
  await postStatus({ repo: 'acme/app', sha: 'b'.repeat(40), state: 'success', description: 'x'.repeat(200), gh: fake.gh });
  const red = await nightlyFailures({ repo: 'acme/app', branch: 'main', gh: fake.gh });
  assert.deepEqual(red.map((r) => r.url), ['u1']);

  const api = (await fake.calls()).find((c) => c[0] === 'api');
  assert.ok(api.includes(`repos/acme/app/statuses/${'b'.repeat(40)}`));
  assert.ok(api.includes('context=local-ci'));
  const desc = api.find((a) => a.startsWith('description='));
  assert.equal(desc.length - 'description='.length, 140);
});
