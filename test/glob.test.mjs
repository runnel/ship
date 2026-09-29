import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny } from '../lib/glob.mjs';

test('a single star is root-anchored and stays inside one segment', () => {
  assert.ok(matchesAny('README.md', ['*.md']));
  assert.ok(!matchesAny('docs/a.md', ['*.md']));
});

test('double star matches any depth', () => {
  assert.ok(matchesAny('app/a/b/c.ts', ['app/**']));
  assert.ok(matchesAny('app/x', ['app/**']));
  assert.ok(!matchesAny('apps/x', ['app/**']));
  assert.ok(matchesAny('a/b/c.md', ['**/*.md']));
  assert.ok(matchesAny('c.md', ['**/*.md']));
});

test('prefix star and question mark', () => {
  assert.ok(matchesAny('scripts/check-migrations.test.mjs', ['scripts/check-migrations*']));
  assert.ok(!matchesAny('scripts/sub/check-migrations.mjs', ['scripts/check-migrations*']));
  assert.ok(matchesAny('a1.txt', ['a?.txt']));
});

test('regex metacharacters are literal', () => {
  assert.ok(matchesAny('a+b(c).md', ['a+b(c).md']));
  assert.ok(!matchesAny('aab(c).md', ['a+b(c).md']));
});

test('a lone double star matches everything', () => {
  assert.ok(matchesAny('x/y/z', ['**']));
  assert.equal(globToRegExp('**').source, '^.*$');
});
