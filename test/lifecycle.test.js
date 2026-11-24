import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  mkdtempDisposable,
  mkdir,
  readFile,
  writeFile,
  unlink,
  readdir,
  symlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { z } from 'zod';

import { files } from '../src/index.js';
import { fixture, raw, code } from './helpers.js';

test('native parallel filesystem requests stay bounded and release before iterator yield', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(raw('parallel', { text: 'x'.repeat(1024 * 1024) }));

  const requests = new Set();
  let maximum = 0;
  const hook = createHook({
    init(id, type) {
      if (type === 'FSREQPROMISE') {
        requests.add(id);
        maximum = Math.max(maximum, requests.size);
      }
    },
    before(id) {
      requests.delete(id);
    },
    destroy(id) {
      requests.delete(id);
    }
  });

  hook.enable();
  try {
    const reads = Array.from({ length: 64 }, () => storage.find(saved.id));
    const results = await Promise.all(reads);
    assert.ok(results.every((post) => post.text === saved.text));
  } finally {
    hook.disable();
  }

  assert.ok(maximum > 1);
  assert.ok(maximum <= 8, `saw ${maximum} concurrent native filesystem requests`);

  const iterator = storage.all()[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.id, saved.id);

  await storage.close();
  await assert.rejects(iterator.next(), code('YAMB_STORAGE_NOT_OPEN'));

  await storage.open();
  const again = await storage.find(saved.id);
  assert.equal(again.text, saved.text);
});

test('query snapshots and captured defaults work through real Yamb after reopen', async (t) => {
  const { blog, storage } = await fixture(
    t,
    {},
    z.strictObject({ flag: z.boolean().default(false) })
  );
  const saved = await storage.save(raw('defaults'));
  await blog.sync();
  const loaded = await blog.find(saved.id);
  assert.equal(loaded.options.flag, false);

  const query = { options: { flag: false } };
  const options = { order: 'title' };
  const source = storage.all(query, options);

  query.options.flag = true;
  options.limit = 0;

  const selected = await Array.fromAsync(source);
  assert.equal(selected.length, 1);
  assert.equal(await blog.all({ options: { flag: false } }).count(), 1);

  await blog.close();
  await blog.open();
  const repeated = await blog.all({ options: { flag: false } }).toArray();
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].options.flag, false);
});

test('sync rejects new corrupt, duplicate and over-budget files without a partial index swap', async (t) => {
  const { storage, path } = await fixture(t, { capacity: 2, bytes: 1800, memory: 800 });
  const a = await storage.save(raw('a'));
  const original = await readFile(join(path, `${a.id}.md`), 'utf8');
  const b = await storage.save(raw('b'));

  const extraId = randomUUID();
  const extra = join(path, `${extraId}.md`);
  await writeFile(extra, original.replaceAll(a.id, extraId).replaceAll('drafts/a', 'drafts/extra'));
  await assert.rejects(storage.sync(), code('YAMB_STORAGE_READ'));
  assert.equal(await storage.count(), 2);
  await unlink(extra);

  const target = join(path, `${b.id}.md`);
  const oldB = await readFile(target, 'utf8');
  await writeFile(target, original.replaceAll(a.id, b.id));
  await assert.rejects(storage.sync(), code('YAMB_STORAGE_DUPLICATE'));
  assert.equal(await storage.count({ uri: 'drafts/b' }), 1);

  await writeFile(target, oldB.replace('"title": "b"', `"title": "${'x'.repeat(500)}"`));
  await assert.rejects(storage.sync(), code('YAMB_STORAGE_READ'));
  assert.equal(await storage.count(), 2);

  await writeFile(target, 'x'.repeat(1801));
  await assert.rejects(storage.find(b.id), code('YAMB_STORAGE_READ'));
  assert.equal(await storage.count(), 2);

  await writeFile(target, oldB);
  await storage.sync();
  assert.equal(await storage.count(), 2);
});

test('aborted sync and reads retain the old index and preserve an arbitrary signal reason', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = await storage.save(raw('cancel'));

  const reason = { cancelled: true };
  const controller = new AbortController();
  const read = storage.find(saved.id, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(read, (error) => error === reason);

  const first = storage.save(raw('block-sync'));
  const cancelled = new AbortController();
  const sync = storage.sync({ signal: cancelled.signal });
  cancelled.abort(reason);
  await assert.rejects(sync, (error) => error === reason);
  await first;
  assert.equal(await storage.count(), 2);

  const options = { signal: AbortSignal.abort(reason) };
  await assert.rejects(storage.find('missing', options), (error) => error === reason);
  await assert.rejects(storage.count({}, options), (error) => error === reason);
  assert.throws(
    () => storage.all({}, options),
    (error) => error === reason
  );

  const remaining = await readdir(path);
  assert.equal(remaining.filter((name) => name.endsWith('.tmp')).length, 0);
});

test('concurrent open and close drain initialization and allow a later owner', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'yamb-files-'));
  const storage = files({ path: dir.path });

  const opening = storage.open();
  const shared = storage.open();
  const closing = storage.close();
  await Promise.all([opening, shared, closing]);
  assert.deepEqual(await readdir(dir.path), []);

  await storage.open();
  const closingAgain = storage.close();
  const reopened = storage.open();
  await Promise.all([closingAgain, reopened]);
  await storage.close();

  const alias = join(dir.path, 'alias');
  const target = join(dir.path, 'target');
  await mkdir(target);
  await symlink(target, alias);
  await assert.rejects(files({ path: alias }).open(), code('YAMB_FILES_OPEN'));
  assert.deepEqual(await readdir(target), []);
});

test('scan uses bounded parallel reads and drains every started read before failed sync/open', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = [];

  for (let i = 0; i < 8; i++) {
    saved.push(await storage.save(raw(`scan-${i}`, { text: 'x'.repeat(1024 * 1024) })));
  }

  const requests = new Set();
  let maximum = 0;
  const hook = createHook({
    init(id, type) {
      if (type === 'FSREQPROMISE') {
        requests.add(id);
        maximum = Math.max(maximum, requests.size);
      }
    },
    before(id) {
      requests.delete(id);
    },
    destroy(id) {
      requests.delete(id);
    }
  });

  hook.enable();
  try {
    await storage.sync();
  } finally {
    hook.disable();
  }

  assert.ok(maximum > 1);
  assert.ok(maximum <= 8);

  const bad = join(path, `${saved[3].id}.md`);
  await writeFile(bad, 'invalid');
  requests.clear();
  hook.enable();
  try {
    await assert.rejects(storage.sync(), code('YAMB_STORAGE_READ'));
  } finally {
    hook.disable();
  }

  assert.equal(requests.size, 0);
  assert.equal(await storage.count(), 8);

  await storage.close();
  requests.clear();
  hook.enable();
  try {
    await assert.rejects(storage.open(), code('YAMB_FILES_OPEN'));
  } finally {
    hook.disable();
  }

  assert.equal(requests.size, 0);
  const entries = await readdir(path);
  assert.ok(!entries.includes('.yamb.lock'));

  await unlink(bad);
  const limited = files({ path, capacity: 3 });
  requests.clear();
  hook.enable();
  try {
    await assert.rejects(limited.open(), code('YAMB_FILES_OPEN'));
  } finally {
    hook.disable();
  }

  assert.equal(requests.size, 0);
  const afterCapacity = await readdir(path);
  assert.ok(!afterCapacity.includes('.yamb.lock'));

  await storage.open();
  assert.equal(await storage.count(), 7);
});
