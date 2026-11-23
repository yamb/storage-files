import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtempDisposable,
  writeFile,
  readFile,
  readdir,
  unlink,
  symlink,
  link,
  mkdir,
  stat,
  rename
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { files } from '../src/index.js';
import { raw, fixture, code } from './helpers.js';

test('strict configuration, closed operations and pre-aborted open', async () => {
  for (const config of [
    {},
    { path: '' },
    { path: '/tmp', bytes: 0 },
    { path: '/tmp', memory: Infinity },
    { path: '/tmp', capacity: -1 },
    { path: '/tmp', other: 1 }
  ]) {
    assert.throws(() => files(config), code('YAMB_FILES_CONFIG'));
  }

  await using dir = await mkdtempDisposable(join(tmpdir(), 'yamb-files-'));
  const storage = files({ path: dir.path });
  await assert.rejects(storage.find(randomUUID()), code('YAMB_STORAGE_NOT_OPEN'));
  await assert.rejects(storage.find('missing'), code('YAMB_STORAGE_NOT_OPEN'));

  const reason = new Error('cancel');
  await assert.rejects(
    storage.open({ signal: AbortSignal.abort(reason) }),
    (error) => error === reason
  );
  assert.deepEqual(await readdir(dir.path), []);

  await storage.open();
  await storage.close({ signal: AbortSignal.abort(reason) });
  await storage.close();
  assert.deepEqual(await readdir(dir.path), []);
});

test('second instance and process cannot own lock; stale and replaced locks remain untouched', async (t) => {
  const { storage, path } = await fixture(t);
  const second = files({ path });
  await assert.rejects(second.open(), code('YAMB_FILES_OPEN'));
  await second.close();
  const lock = await stat(join(path, '.yamb.lock'));
  assert.ok(lock.isFile());

  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import { files } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};

        try {
          await files({ path: process.argv[1] }).open();
          process.exitCode = 2;
        } catch (error) {
          console.log(error.code);
        }
      `,
      path
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });

  const [exit] = await once(child, 'exit');

  assert.equal(exit, 0);
  assert.equal(output.trim(), 'YAMB_FILES_OPEN');

  await storage.close();
  await writeFile(join(path, '.yamb.lock'), 'stale');
  await assert.rejects(storage.open(), code('YAMB_FILES_OPEN'));
  assert.equal(await readFile(join(path, '.yamb.lock'), 'utf8'), 'stale');

  await unlink(join(path, '.yamb.lock'));
  await storage.open();
  await rename(join(path, '.yamb.lock'), join(path, 'old-lock'));
  await writeFile(join(path, '.yamb.lock'), 'foreign');

  await assert.rejects(storage.close(), code('YAMB_STORAGE_WRITE'));
  assert.equal(await readFile(join(path, '.yamb.lock'), 'utf8'), 'foreign');
});

test('open validates the complete scan and releases only its own lock after failure', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'yamb-files-'));
  const storage = files({ path: dir.path });
  const invalid = join(dir.path, `${randomUUID()}.md`);
  await writeFile(invalid, '---\n{}\n---\nbad');

  await assert.rejects(storage.open(), code('YAMB_FILES_OPEN'));
  assert.deepEqual(await readdir(dir.path), [invalid.split('/').at(-1)]);

  await unlink(invalid);
  await storage.open();
  await storage.close();
});

test('temporary cleanup only removes owned regular UUID leftovers', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'yamb-files-'));
  const own = join(dir.path, `.yamb-${randomUUID()}.tmp`);
  const foreign = join(dir.path, '.yamb-other.tmp');
  await writeFile(own, 'incomplete');
  await writeFile(foreign, 'foreign');

  const storage = files({ path: dir.path });
  await storage.open();
  await storage.close();
  assert.deepEqual(await readdir(dir.path), ['.yamb-other.tmp']);

  const unsafe = join(dir.path, `.yamb-${randomUUID()}.tmp`);
  await symlink(foreign, unsafe);
  await assert.rejects(storage.open(), code('YAMB_FILES_OPEN'));
  assert.equal(await readFile(foreign, 'utf8'), 'foreign');
});

test('duplicate URI race has one winner; input and signal are captured before queueing', async (t) => {
  const { storage } = await fixture(t);
  const outcomes = await Promise.allSettled([storage.save(raw('same')), storage.save(raw('same'))]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(
    outcomes.find((outcome) => outcome.status === 'rejected').reason.code,
    'YAMB_STORAGE_DUPLICATE'
  );

  const input = raw('captured', { options: { obj: [1] } });
  const controller = new AbortController();
  const options = { signal: controller.signal };

  const first = storage.save(raw('block', { text: 'x'.repeat(1024 * 1024) }));
  const captured = storage.save(input, options);

  input.title = 'mutated';
  input.options.obj.push(2);
  options.signal = AbortSignal.abort();

  await first;
  const saved = await captured;

  assert.equal(saved.title, 'captured');
  assert.deepEqual(saved.options.obj, [1]);

  const reason = new Error('queued cancellation');
  const blocker = storage.save(raw('block-two'));
  const cancelled = storage.save(raw('cancelled'), { signal: controller.signal });

  controller.abort(reason);
  await assert.rejects(cancelled, (error) => error === reason);
  await blocker;

  assert.equal(await storage.fetch('drafts/cancelled'), null);
});

test('bounded admission rejects overflow; close drains accepted reads and writes', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(raw('read', { text: 'x'.repeat(1024 * 1024) }));

  const pending = Array.from({ length: 64 }, () => storage.find(saved.id));
  const overflow = storage.find(saved.id);
  const missing = storage.find('missing');
  await assert.rejects(overflow, code('YAMB_STORAGE_READ'));
  assert.equal(await missing, null);

  const closing = storage.close();
  await assert.rejects(storage.save(raw('late')), code('YAMB_STORAGE_NOT_OPEN'));

  const completed = await Promise.all(pending);
  assert.equal(completed.length, 64);
  await closing;

  await storage.open();
  const writes = Array.from({ length: 10 }, (_, i) => storage.save(raw(`write-${i}`)));
  const drained = storage.close();
  await Promise.all(writes);
  await drained;

  await storage.open();
  assert.equal(await storage.count(), 11);
});

test('capacity, file bytes and projected metadata memory enforce precommit limits', async (t) => {
  const { storage, path } = await fixture(t, { capacity: 1, bytes: 1500, memory: 700 });
  const saved = await storage.save(raw('a', { options: { huge: { body: 'x'.repeat(500) } } }));
  const original = await readFile(join(path, `${saved.id}.md`));

  for (const input of [
    raw('b'),
    { ...saved, text: 'x'.repeat(2000) },
    { ...saved, options: { scalar: 'x'.repeat(800) } },
    { ...saved, text: '\ud800' }
  ]) {
    await assert.rejects(storage.save(input), code('YAMB_STORAGE_WRITE'));
  }

  assert.deepEqual(await readFile(join(path, `${saved.id}.md`)), original);
  const remaining = await readdir(path);
  assert.deepEqual(
    remaining.filter((name) => name.endsWith('.tmp')),
    []
  );

  await storage.close();
  await assert.rejects(files({ path, bytes: 10 }).open(), code('YAMB_FILES_OPEN'));
  await storage.open();
});

test('reject traversal, symlink, hardlink, directory, invalid UTF8, Unicode and mismatched metadata', async (t) => {
  const { storage, path, dir } = await fixture(t);
  for (const id of [null, 1, {}, '', 'x'.repeat(65)]) {
    await assert.rejects(storage.find(id), code('YAMB_STORAGE_READ'));
  }

  for (const id of ['../outside', '/tmp/a', '..', 'a/b', 'a\\b']) {
    assert.equal(await storage.find(id), null);
    await assert.rejects(storage.save(raw('unsafe', { id })), code('YAMB_STORAGE_WRITE'));
    await assert.rejects(storage.remove(id), code('YAMB_STORAGE_WRITE'));
  }

  const saved = await storage.save(raw('safe'));
  const target = join(path, `${saved.id}.md`);
  const original = await readFile(target);
  const invalidName = join(path, 'missing.md');
  await writeFile(invalidName, original.toString().replace(saved.id, 'missing'));
  assert.equal(await storage.find('missing'), null);
  await assert.rejects(storage.sync(), code('YAMB_STORAGE_READ'));
  await unlink(invalidName);

  const outside = join(dir, 'outside');
  await writeFile(outside, 'untouched');

  const corruptions = [
    async () => {
      await unlink(target);
      await symlink(outside, target);
    },
    async () => {
      await unlink(target);
      await link(outside, target);
    },
    async () => {
      await unlink(target);
      await mkdir(target);
    },
    async () => writeFile(target, Buffer.from([0xff, 0xfe])),
    async () => writeFile(target, original.toString().replace('safe', '\\ud800')),
    async () => writeFile(target, original.toString().replace(saved.id, randomUUID()))
  ];

  for (let i = 0; i < corruptions.length; i++) {
    if (i > 0) {
      const { rm } = await import('node:fs/promises');
      await rm(target, { recursive: true, force: true });
      await writeFile(target, original);
    }

    await corruptions[i]();
    await assert.rejects(storage.find(saved.id), code('YAMB_STORAGE_READ'));
    await assert.rejects(storage.sync(), code('YAMB_STORAGE_READ'));

    if (i < 3) {
      await assert.rejects(storage.save(saved), code('YAMB_STORAGE_WRITE'));
    }

    assert.equal(await storage.count(), 1);
  }

  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});
