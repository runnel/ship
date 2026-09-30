import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeHold } from '../lib/state.mjs';
import { runStatus } from '../lib/status.mjs';
import { at, setupDeploy } from './deploy-fixture.mjs';

test('status shows live, pending, holds, an undeployed newest version and migrations', async () => {
  const s = await setupDeploy({ seed: ({ first, head }) => ({ 'example-app': at(first), 'example-tick': at(head) }), change: { 'app/src/a.ts': '2' } });
  await writeHold(s.deps.stateRoot, 't/r', 'tick', { reason: 'checking something' });
  s.cloud.addVersion('example-app', { message: 'Updated secret "K"' });
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  const text = s.lines.join('\n');
  assert.match(text, new RegExp(`· app: live ${s.first.slice(0, 7)} "initial" · pending: 1 commit\\(s\\) #9 · newest version [0-9a-f]{8} \\(.*\\) is not deployed`));
  assert.match(text, /! tick: live [0-9a-f]{7} #9 · held since .*checking something/);
  assert.match(text, /! migrations not cleared for deploy: db\/001.sql/);
});

test('status reports a held deployable whose live commit is not in the repository instead of failing', async () => {
  const gone = 'a'.repeat(40);
  const s = await setupDeploy({ seed: ({ head }) => ({ 'example-app': at(gone), 'example-tick': at(head) }), change: { 'app/src/a.ts': '2' } });
  await writeHold(s.deps.stateRoot, 't/r', 'app', { reason: 'looking into it' });
  assert.equal(await runStatus({ cwd: s.work, deps: s.deps }), 0);
  assert.match(s.lines.join('\n'), /! app: live aaaaaaa · held since .*looking into it/);
});
