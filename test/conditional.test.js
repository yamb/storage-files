import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { code, fixture, raw } from './helpers.js';

const conflict = code('YAMB_POST_CONFLICT');
const notFound = code('YAMB_POST_NOT_FOUND');

test('save and remove apply only while the stored version matches', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(raw('post', { version: 'v1' }));

  await storage.save({ ...saved, title: 'Second', version: 'v2' }, { expected: 'v1' });
  await assert.rejects(
    storage.save({ ...saved, title: 'Stale', version: 'v3' }, { expected: 'v1' }),
    conflict
  );
  await assert.rejects(storage.remove(saved.id, { expected: 'v1' }), conflict);

  const stored = await storage.find(saved.id);
  assert.equal(stored.title, 'Second');
  assert.equal(stored.version, 'v2');

  await storage.remove(saved.id, { expected: 'v2' });
  assert.equal(await storage.find(saved.id), null);

  const missing = randomUUID();
  await assert.rejects(storage.save({ ...saved, id: missing }, { expected: 'v2' }), notFound);
  await assert.rejects(storage.remove(missing, { expected: 'v2' }), notFound);
  await assert.rejects(storage.fence(missing, 'v3', { expected: 'v2' }), notFound);
});

test('fence changes only the version and survives a rescan', async (t) => {
  const { storage } = await fixture(t);
  const legacy = await storage.save(raw('legacy', { options: { ratio: 1.5 } }));
  const before = await storage.find(legacy.id);
  assert.equal(Object.hasOwn(before, 'version'), false);

  await assert.rejects(storage.fence(legacy.id, 'v1', { expected: 'v0' }), conflict);
  await storage.fence(legacy.id, 'v1', { expected: null });
  await assert.rejects(storage.fence(legacy.id, 'v2', { expected: null }), conflict);
  assert.deepEqual(await storage.find(legacy.id), { ...before, version: 'v1' });

  await storage.sync();
  await assert.rejects(storage.remove(legacy.id, { expected: null }), conflict);
  await storage.remove(legacy.id, { expected: 'v1' });
});

test('fence rejects a file edited outside the owner until sync', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = await storage.save(raw('outside', { version: 'v1' }));
  const target = join(path, `${saved.id}.md`);
  const content = await readFile(target, 'utf8');

  await writeFile(target, content.replaceAll('drafts/outside', 'drafts/renamed'));
  await assert.rejects(
    storage.fence(saved.id, 'v2', { expected: 'v1' }),
    code('YAMB_STORAGE_WRITE')
  );

  await storage.sync();
  await storage.fence(saved.id, 'v2', { expected: 'v1' });
  const renamed = await storage.fetch('drafts/renamed');
  assert.equal(await storage.fetch('drafts/outside'), null);
  assert.equal(renamed.version, 'v2');
});

test('an unconditional write ignores the stored version', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(raw('unconditional', { version: 'v1' }));

  await storage.save({ ...saved, title: 'Forced', version: 'v2' });

  const stored = await storage.find(saved.id);
  assert.equal(stored.title, 'Forced');
  assert.equal(stored.version, 'v2');
});

test('an invalid version is rejected before writing', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(raw('invalid'));

  await assert.rejects(storage.save({ ...saved, version: '' }), code('YAMB_STORAGE_WRITE'));
  await assert.rejects(storage.fence(saved.id, 42, { expected: null }), code('YAMB_STORAGE_WRITE'));
  assert.deepEqual(await storage.find(saved.id), saved);
});

test('a stale Post conflicts and a fence invalidates a lost write', async (t) => {
  const { blog } = await fixture(t);
  const post = await blog.create({ title: 'Original' });
  const stale = await blog.find(post.id);

  post.title = 'Winner';
  await post.save();

  stale.title = 'Loser';
  await assert.rejects(stale.save(), conflict);

  await blog.fence(post.id, post.version);

  post.title = 'Late';
  await assert.rejects(post.save(), conflict);
  await assert.rejects(post.remove(), conflict);

  const stored = await blog.find(post.id);
  assert.equal(stored.title, 'Winner');
});
