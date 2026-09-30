import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { importsOutside, relativeSpecifiers, stripComments } from '../lib/imports.mjs';
import { tempDir } from './helpers.mjs';

async function tree(files) {
  const root = await tempDir('imports-');
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), c);
  }
  return root;
}

test('relativeSpecifiers finds static, side-effect, re-export, dynamic and require forms', () => {
  const src = `import a from './a';\nimport './side';\nexport * from "../up/b";\nconst c = await import('./c');\nconst d = require('./d.cjs');\nimport x from 'pkg';`;
  assert.deepEqual(relativeSpecifiers(src), ['./a', './side', '../up/b', './c', './d.cjs']);
});

test('comments do not count, strings survive', () => {
  assert.deepEqual(relativeSpecifiers(stripComments(`// import a from './a'\n/* import b from './b' */\nconst s = "// not a comment"; import c from './c';`)), ['./c']);
});

test('an import outside paths is reported, one inside is followed transitively', async () => {
  const root = await tree({
    'workers/tick/src/index.ts': `import { a } from '../../../app/lib/a';`,
    'app/lib/a.ts': `import { b } from './b';\nexport const a = 1;`,
    'app/lib/b.ts': `export const b = 2;`,
    'workers/tick/test/x.test.ts': `import '../../../scripts/helper.mjs';`,
    'scripts/helper.mjs': ``,
  });
  const tick = { cwd: 'workers/tick', paths: ['workers/tick/src/**', 'app/lib/a.ts'] };
  assert.deepEqual(await importsOutside(root, tick), [{ from: 'app/lib/a.ts', to: 'app/lib/b.ts' }]);
  assert.deepEqual(await importsOutside(root, { ...tick, paths: ['workers/tick/src/**', 'app/lib/a.ts', 'app/lib/b.ts'] }), []);
});

test('node_modules and build output are not scanned; unresolved imports are ignored', async () => {
  const root = await tree({
    'app/src/x.ts': `import './missing';`,
    'app/node_modules/p/index.js': `import '../../../elsewhere.js';`,
    'app/.open-next/worker.js': `import '../../elsewhere.js';`,
    'elsewhere.js': '',
  });
  assert.deepEqual(await importsOutside(root, { cwd: 'app', paths: ['app/**'] }), []);
});

test('bare . and .. specifiers are found, look-alikes are not', () => {
  const src = `import a from '.';\nexport * from "..";\nconst b = await import('..');\nconst c = require('.');\nimport d from '.env';\nimport e from '...';\nimport f from './x';`;
  assert.deepEqual(relativeSpecifiers(src), ['.', '..', '..', '.', './x']);
});

test('a .js specifier resolves to the TypeScript source, the exact file wins', async () => {
  const root = await tree({
    'workers/tick/src/index.ts': `import '../../../lib/a.js';\nimport '../../../lib/b.mjs';\nimport '../../../lib/c.cjs';\nimport '../../../lib/d.jsx';\nimport '../../../lib/e.js';`,
    'lib/a.ts': '',
    'lib/b.mts': '',
    'lib/c.cts': '',
    'lib/d.tsx': '',
    'lib/e.js': '',
    'lib/e.ts': '',
  });
  const paths = ['workers/tick/src/**'];
  assert.deepEqual(await importsOutside(root, { cwd: 'workers/tick', paths }), [
    { from: 'workers/tick/src/index.ts', to: 'lib/a.ts' },
    { from: 'workers/tick/src/index.ts', to: 'lib/b.mts' },
    { from: 'workers/tick/src/index.ts', to: 'lib/c.cts' },
    { from: 'workers/tick/src/index.ts', to: 'lib/d.tsx' },
    { from: 'workers/tick/src/index.ts', to: 'lib/e.js' },
  ]);
});

test('a bare .. resolves to the parent directory index, a bare . to its own', async () => {
  const root = await tree({
    'app/src/x.ts': `import up from '..';\nimport here from '.';`,
    'app/index.ts': '',
    'app/src/index.ts': '',
  });
  assert.deepEqual(await importsOutside(root, { cwd: 'app', paths: ['app/src/**'] }), [
    { from: 'app/src/x.ts', to: 'app/index.ts' },
  ]);
});

test('every index file form resolves, and .cts is a plain source suffix', async () => {
  const root = await tree({
    'app/src/x.ts': `import '../a';\nimport '../b';\nimport '../c';\nimport '../d';\nimport '../e';`,
    'app/a/index.mts': '',
    'app/b/index.cts': '',
    'app/c/index.jsx': '',
    'app/d/index.cjs': '',
    'app/e.cts': '',
  });
  assert.deepEqual(
    (await importsOutside(root, { cwd: 'app', paths: ['app/src/**'] })).map((o) => o.to),
    ['app/a/index.mts', 'app/b/index.cts', 'app/c/index.jsx', 'app/d/index.cjs', 'app/e.cts'],
  );
});

test('an imported file that the deployable ignores, or the repo treats as docs-only, is outside', async () => {
  const root = await tree({
    'app/src/a.ts': `import './gen/g';\nimport '../notes/n';\nimport './kept';`,
    'app/src/gen/g.ts': `import '../../elsewhere';`,
    'app/notes/n.ts': '',
    'app/src/kept.ts': '',
    'app/elsewhere.ts': '',
  });
  const app = { cwd: 'app', paths: ['app/**'] };
  assert.deepEqual(await importsOutside(root, app), []);
  assert.deepEqual(await importsOutside(root, { ...app, ignore: ['app/src/gen/**'] }), [{ from: 'app/src/a.ts', to: 'app/src/gen/g.ts' }]);
  assert.deepEqual(await importsOutside(root, app, ['app/notes/**']), [{ from: 'app/src/a.ts', to: 'app/notes/n.ts' }]);
  assert.deepEqual(await importsOutside(root, { ...app, ignore: ['app/src/gen/**'] }, ['app/notes/**']), [
    { from: 'app/src/a.ts', to: 'app/src/gen/g.ts' },
    { from: 'app/src/a.ts', to: 'app/notes/n.ts' },
  ]);
});

test('sources the deploy plan does not watch are not scanned: an ignored test may import its own helper', async () => {
  const root = await tree({
    'web/src/a.ts': `import './b';`,
    'web/src/b.ts': '',
    'web/test/a.test.ts': `import './helpers';\nimport '../../elsewhere/x';`,
    'web/test/helpers.ts': '',
    'web/notes/n.ts': `import './m';`,
    'web/notes/m.ts': '',
    'elsewhere/x.ts': '',
  });
  const web = { cwd: 'web', paths: ['web/**'], ignore: ['web/test/**'] };
  assert.deepEqual(await importsOutside(root, web, ['web/notes/**']), []);
  // the watched code reaching into them is still caught
  const reaching = await tree({ 'web/src/a.ts': `import '../test/helpers';`, 'web/test/helpers.ts': '' });
  assert.deepEqual(await importsOutside(reaching, web), [{ from: 'web/src/a.ts', to: 'web/test/helpers.ts' }]);
});
