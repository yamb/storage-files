import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { yamb } from '#core';

import pkg from './package.json' with { type: 'json' };

const { files } = await import(pkg.name);

await using directory = await mkdtempDisposable(join(tmpdir(), 'yamb-smoke-'));
const storage = files({ path: join(directory.path, 'posts') });
await using blog = yamb({ storage });
await blog.open();
assert.equal(await blog.all().count(), 0, 'Expected an empty storage fixture');

const post = await blog.create({ title: 'Packaged storage', text: '**source**' });

try {
  const saved = await storage.find(post.id);
  assert.equal(saved.text, '**source**');
} finally {
  await post.remove();
}
