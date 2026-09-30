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
