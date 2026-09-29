import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../lib/config.mjs';
import { classify, laneFor } from '../lib/classify.mjs';

const config = validateConfig({
  repo: 'acme/app',
  docsOnly: ['*.md', 'app/docs/**'],
  checks: [
    { name: 'app', lane: 'heavy', paths: ['app/**', 'workers/**'], steps: ['true'] },
    { name: 'workers', paths: ['workers/**'], steps: ['true'] },
    { name: 'db', paths: ['db/**'], steps: ['true'] },
    { name: 'unchecked', paths: ['scripts/**'], steps: ['true'] },
  ],
});

test('a docs-only diff', () => {
  assert.equal(classify(['README.md', 'app/docs/x.md'], config).docsOnly, true);
});

test('docs inside a group path are removed before matching', () => {
  const r = classify(['app/docs/x.md', 'db/1.sql'], config);
  assert.equal(r.docsOnly, false);
  assert.deepEqual(r.groups, ['db']);
});

test('the union of matching groups, in config order', () => {
  assert.deepEqual(classify(['workers/a/index.ts'], config).groups, ['app', 'workers']);
});

test('a file no group matches selects every group', () => {
  assert.deepEqual(classify(['package.json'], config).groups, ['app', 'workers', 'db', 'unchecked']);
});

test('.github and ship.config.mjs select every group', () => {
  assert.equal(classify(['.github/workflows/x.yml'], config).groups.length, 4);
  assert.equal(classify(['ship.config.mjs'], config).groups.length, 4);
});

test('the lane is heavy when any selected group is heavy', () => {
  assert.equal(laneFor(['db'], config), 'light');
  assert.equal(laneFor(['db', 'app'], config), 'heavy');
});
