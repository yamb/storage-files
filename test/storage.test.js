import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { z } from 'zod';

import { FilesStorage } from '../src/index.js';
import { raw, fixture, code } from './helpers.js';

const instant = '2026-01-01T00:00:00.000000001Z';

test('real Yamb CRUD, publish, related, rename, snapshots and reopen preserve Markdown', async (t) => {
  const { blog, storage, path } = await fixture(
    t,
    {},
    z.strictObject({ flag: z.boolean().default(false), nested: z.json().optional() })
  );
  assert.ok(storage instanceof FilesStorage);

  const a = await blog.create({
    title: 'First',
    text: raw('a').text,
    options: { nested: { arr: [1, null, true] } },
    author: { name: 'Author' },
    preview: 'Preview',
    cover: { url: './cover.png' },
    meta: { description: 'meta' },
    social: { title: 'Social' }
  });
  const b = await blog.create({ title: 'Related', text: 'B', links: { related: [a.id] } });
  const { id } = a;

  const before = await storage.find(id);
  before.options.nested.arr.push('detached');
  const stored = await storage.find(id);
  assert.deepEqual(stored.options.nested.arr, [1, null, true]);

  await a.publish();
  a.slug = 'renamed';
  a.text += '\n---\n';
  await a.save();
  assert.equal(a.id, id);

  const related = await b.related().toArray();
  assert.equal(related[0].id, id);
  assert.equal(related[0].uri, a.uri);

  const source = await readFile(join(path, `${id}.md`), 'utf8');
  assert.ok(source.startsWith('---\n{\n'));
  assert.ok(source.endsWith(a.text));
  const expected = await storage.find(id);

  await blog.close();
  await blog.open();
  assert.deepEqual(await storage.find(id), expected);
  const loaded = await blog.find(id);
  const byUri = await storage.fetch(a.uri);
  assert.equal(loaded.text, a.text);
  assert.equal(byUri.id, id);
  assert.equal(await blog.find('missing'), null);
  assert.equal(await storage.fetch('drafts/first'), null);

  await a.remove();
  assert.equal(await storage.find(id), null);
  await assert.rejects(storage.save(expected), code('YAMB_POST_NOT_FOUND'));
  await assert.rejects(storage.remove(id), code('YAMB_POST_NOT_FOUND'));
  const remaining = await readdir(path);
  assert.deepEqual(
    remaining.filter((name) => name.endsWith('.md')),
    [`${b.id}.md`]
  );
});

test('all orders, ties, missing dates, strict bounds, filters, paging and keyset navigation', async (t) => {
  const { blog, storage } = await fixture(t);
  const records = [
    raw('a', {
      title: 'Z',
      tags: ['one', 'two'],
      status: 'published',
      uri: '2026/01/a',
      publishedAt: instant,
      createdAt: '2026-01-02T00:00:00Z'
    }),
    raw('b', {
      title: 'Z',
      tags: ['one'],
      status: 'published',
      uri: '2026/01/b',
      publishedAt: instant,
      updatedAt: '2026-01-03T00:00:00Z'
    }),
    raw('c', {
      title: 'A',
      status: 'published',
      uri: '2026/02/c',
      publishedAt: '2026-02-01T00:00:00Z'
    }),
    raw('d', { title: 'a' })
  ];

  for (const item of records) {
    await storage.save(item);
  }
  await blog.sync();

  const slugs = async (query = {}, options = {}) => {
    const rows = await Array.fromAsync(storage.all(query, options));
    return rows.map((item) => item.slug);
  };

  const expected = {
    publishedAt: ['d', 'a', 'b', 'c'],
    createdAt: ['b', 'c', 'd', 'a'],
    updatedAt: ['a', 'c', 'd', 'b'],
    title: ['c', 'a', 'b', 'd']
  };
  for (const [field, ascending] of Object.entries(expected)) {
    assert.deepEqual(await slugs({}, { order: field }), ascending);
    assert.deepEqual(await slugs({}, { order: `-${field}` }), ascending.toReversed());
  }

  assert.deepEqual(await slugs(), ['c', 'b', 'a', 'd']);
  assert.deepEqual(await slugs({ tags: ['one', 'two'] }), ['a']);
  assert.deepEqual(await slugs({ tags: ['one'] }), ['b', 'a']);
  assert.deepEqual(await slugs({ status: 'draft', uri: 'drafts/d', tags: [] }), ['d']);

  assert.deepEqual(await slugs({ before: '2026-02-01T00:00:00Z', after: '2026-01-01T00:00:00Z' }), [
    'b',
    'a'
  ]);

  assert.deepEqual(await slugs({}, { offset: 1, limit: 2 }), ['b', 'a']);
  assert.deepEqual(await slugs({}, { limit: 0 }), []);
  assert.deepEqual(await slugs({}, { limit: null, offset: 3 }), ['d']);
  assert.equal(await storage.count({}, { limit: 0, offset: 3 }), 4);

  const record = await storage.fetch('2026/01/a');
  const a = await blog.find(record.id);
  const next = await a.next();
  assert.equal(next.slug, 'b');
  assert.equal(await a.prev(), null);
  assert.deepEqual(await slugs({ cursor: { publishedAt: instant, uri: '2026/01/b' } }), ['a']);

  for (const [query, options] of [
    [{ status: '' }, {}],
    [{ options: { x: {} } }, {}],
    [{ cursor: {} }, {}],
    [{ tags: [{ $gt: '' }] }, {}],
    [{ unknown: 1 }, {}],
    [{}, { order: 'slug' }],
    [{}, { limit: -1 }],
    [{}, { offset: 0.1 }]
  ]) {
    await assert.rejects(
      async () => Array.fromAsync(storage.all(query, options)),
      code('YAMB_QUERY_VALIDATION')
    );
  }
});

test('JSON scalar options and captured defaults distinguish nonscalar presence from missing', async (t) => {
  const { storage } = await fixture(t);
  await storage.close();

  const defaults = { flag: false, x: 'default' };
  await storage.open({ optionDefaults: defaults });
  defaults.flag = true;

  for (const [slug, options] of [
    ['missing', undefined],
    ['null', { flag: null }],
    ['false', { flag: false }],
    ['zero', { flag: 0 }],
    ['string', { flag: 'false' }],
    ['object', { flag: { big: 'x'.repeat(10000) } }],
    ['array', { flag: [] }]
  ]) {
    await storage.save(raw(slug, { options }));
  }

  const selected = async (value) => {
    const rows = await Array.fromAsync(
      storage.all({ options: { flag: value } }, { order: 'title' })
    );
    return rows.map((post) => post.slug);
  };

  assert.deepEqual(await selected(false), ['false', 'missing']);
  assert.deepEqual(await selected(null), ['null']);
  assert.deepEqual(await selected(0), ['zero']);
  assert.deepEqual(await selected('false'), ['string']);
  assert.equal(await storage.count({ options: { x: 'default', flag: false } }), 2);
});

test('lazy repeated traversals recheck publication and deletion before yield', async (t) => {
  const { blog, storage } = await fixture(t);
  const a = await blog.create({ title: 'A', text: 'a', status: 'published' });
  const b = await blog.create({ title: 'B', text: 'b', status: 'published' });
  const c = await blog.create({ title: 'C', text: 'c', status: 'published' });

  const source = blog.published.order('title');
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.id, a.id);

  await b.archive();
  await c.remove();
  const last = await iterator.next();
  const again = await source.toArray();
  assert.equal(last.done, true);
  assert.equal(again.length, 1);

  const selected = storage.all({}, { order: 'title' });
  const snapshot = await Array.fromAsync(selected);
  snapshot[0].text = 'changed';
  const repeated = await Array.fromAsync(selected);
  assert.equal(repeated[0].text, 'a');

  await blog.close();
  await assert.rejects(async () => Array.fromAsync(selected), code('YAMB_STORAGE_NOT_OPEN'));
});

test('external source edit and sync replace metadata atomically or retain old index', async (t) => {
  const { storage, path, blog } = await fixture(t);
  const a = await blog.create({ title: 'A', text: 'exact\r\n\n' });
  const file = join(path, `${a.id}.md`);
  const original = await readFile(file, 'utf8');

  await writeFile(
    file,
    original.replace('"title": "A"', '"title": "Edited"').replace('exact\r\n\n', 'new\n---\n')
  );
  await blog.sync();
  const edited = await blog.find(a.id);
  assert.equal(edited.title, 'Edited');
  assert.equal(edited.text, 'new\n---\n');

  const invalid = join(path, `${randomUUID()}.md`);
  await writeFile(invalid, 'bad');
  await assert.rejects(blog.sync(), code('YAMB_STORAGE_READ'));
  assert.equal(await storage.count({ status: 'draft' }), 1);
  const entries = await Array.fromAsync(storage.entries());
  assert.deepEqual(entries, [[a.id, a.uri]]);
});

test('cover nested edits, reset and reopen preserve source objects', async (t) => {
  const { blog, storage } = await fixture(t);
  const cover = { url: './cover.jpg', alt: ' Alt ', caption: ' Caption ', width: 640, height: 480 };
  const post = await blog.create({ title: 'Cover', cover });
  cover.caption = 'Outside';
  assert.equal(post.cover.caption, ' Caption ');

  const snapshot = await storage.find(post.id);
  assert.deepEqual(snapshot.cover, {
    url: './cover.jpg',
    alt: ' Alt ',
    caption: ' Caption ',
    width: 640,
    height: 480
  });

  snapshot.cover.caption = 'Snapshot';
  const stored = await storage.find(post.id);
  assert.equal(stored.cover.caption, ' Caption ');

  post.cover.caption = 'Edited';
  delete post.cover.width;
  await post.save();
  const expected = post.toJSON().cover;

  await blog.close();
  await blog.open();
  const loaded = await blog.find(post.id);
  assert.deepEqual(loaded.cover, expected);

  loaded.cover.url = undefined;
  await loaded.save();
  const partial = await storage.fetch(loaded.uri);
  assert.deepEqual(partial.cover, {
    alt: ' Alt ',
    caption: 'Edited',
    height: 480
  });

  loaded.cover = undefined;
  await loaded.save();
  await blog.close();
  await blog.open();
  const cleared = await blog.find(post.id);
  assert.deepEqual(cleared.cover, {});
});
