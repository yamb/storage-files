import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { raw, fixture } from './helpers.js';

// Coverage output can exceed the child process file-size limit.
const writeLimit = 'unset NODE_V8_COVERAGE\nulimit -f 1\nexec "$@"';

test('real partial filesystem write failure preserves old data and removes its temporary', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = await storage.save(raw('original'));
  const target = join(path, `${saved.id}.md`);
  const original = await readFile(target);
  await storage.close();

  const child = spawn(
    '/bin/sh',
    [
      '-c',
      writeLimit,
      'write-limit',
      process.execPath,
      new URL('./write-limit.js', import.meta.url).pathname,
      path,
      saved.id
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    errors += data;
  });

  const [exit, signal] = await once(child, 'exit');

  assert.equal(exit, 0, `${signal}: ${errors}`);
  assert.deepEqual(JSON.parse(output), { code: 'YAMB_STORAGE_WRITE', cause: 'EFBIG' });

  assert.deepEqual(await readFile(target), original);
  const leftovers = await readdir(path);
  assert.deepEqual(
    leftovers.filter((name) => name.endsWith('.tmp')),
    []
  );

  await storage.open();
  const loaded = await storage.find(saved.id);
  assert.equal(loaded.title, 'original');
});

test('abort after temporary creation rolls back; abort after native rename acknowledges commit', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = await storage.save(raw('atomic'));
  const target = join(path, `${saved.id}.md`);
  const original = await readFile(target);

  const early = new AbortController();
  const earlyReason = new Error('precommit');
  let sawTemporary = false;
  const earlyHook = createHook({
    before() {
      if (!sawTemporary && readdirSync(path).some((name) => name.endsWith('.tmp'))) {
        sawTemporary = true;
        early.abort(earlyReason);
      }
    }
  });

  earlyHook.enable();
  try {
    await assert.rejects(
      storage.save({ ...saved, text: 'x'.repeat(1024 * 1024) }, { signal: early.signal }),
      (error) => error === earlyReason
    );
  } finally {
    earlyHook.disable();
  }

  assert.ok(sawTemporary);
  assert.deepEqual(await readFile(target), original);
  const leftovers = await readdir(path);
  assert.deepEqual(
    leftovers.filter((name) => name.endsWith('.tmp')),
    []
  );

  const inode = statSync(target).ino;
  const late = new AbortController();
  let sawCommit = false;
  const lateHook = createHook({
    before() {
      if (!sawCommit && existsSync(target) && statSync(target).ino !== inode) {
        sawCommit = true;
        late.abort(new Error('after commit'));
      }
    }
  });

  lateHook.enable();
  let result;

  try {
    result = await storage.save({ ...saved, title: 'Committed' }, { signal: late.signal });
  } finally {
    lateHook.disable();
  }

  assert.ok(sawCommit);
  assert.ok(late.signal.aborted);
  assert.equal(result.title, 'Committed');

  const loaded = await storage.find(saved.id);
  assert.equal(loaded.title, 'Committed');
  assert.equal(await storage.count(), 1);
});

test('fence rolls back an abort before rename and acknowledges an abort after it', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = await storage.save(raw('fence', { text: 'x'.repeat(1024 * 1024), version: 'v1' }));
  const target = join(path, `${saved.id}.md`);
  const original = await readFile(target);

  const early = new AbortController();
  const earlyReason = new Error('precommit');
  let sawTemporary = false;
  const earlyHook = createHook({
    before() {
      if (!sawTemporary && readdirSync(path).some((name) => name.endsWith('.tmp'))) {
        sawTemporary = true;
        early.abort(earlyReason);
      }
    }
  });

  earlyHook.enable();
  try {
    await assert.rejects(
      storage.fence(saved.id, 'v2', { signal: early.signal, expected: 'v1' }),
      (error) => error === earlyReason
    );
  } finally {
    earlyHook.disable();
  }

  assert.ok(sawTemporary);
  assert.deepEqual(await readFile(target), original);
  const leftovers = await readdir(path);
  assert.deepEqual(
    leftovers.filter((name) => name.endsWith('.tmp')),
    []
  );

  const inode = statSync(target).ino;
  const late = new AbortController();
  let sawCommit = false;
  const lateHook = createHook({
    before() {
      if (!sawCommit && existsSync(target) && statSync(target).ino !== inode) {
        sawCommit = true;
        late.abort(new Error('after commit'));
      }
    }
  });

  lateHook.enable();
  try {
    await storage.fence(saved.id, 'v3', { signal: late.signal, expected: 'v1' });
  } finally {
    lateHook.disable();
  }

  assert.ok(sawCommit);
  assert.ok(late.signal.aborted);
  await assert.rejects(storage.remove(saved.id, { expected: 'v1' }), {
    code: 'YAMB_POST_CONFLICT'
  });
  assert.deepEqual(await storage.find(saved.id), { ...saved, version: 'v3' });
});

test('returned save values cannot mutate retained query metadata', async (t) => {
  const { storage } = await fixture(t);
  const saved = await storage.save(raw('snapshot', { tags: ['one'] }));

  saved.tags.push('invented');

  assert.equal(await storage.count({ tag: 'invented' }), 0);
  assert.equal(await storage.count({ tag: 'one' }), 1);
});

test('partial write and denied temporary cleanup retain both filesystem errors', async (t) => {
  const { storage, path } = await fixture(t);
  const saved = await storage.save(raw('compound'));
  const target = join(path, `${saved.id}.md`);
  const original = await readFile(target);
  await storage.close();

  const child = spawn(
    '/bin/sh',
    [
      '-c',
      writeLimit,
      'write-limit',
      process.execPath,
      new URL('./write-limit.js', import.meta.url).pathname,
      path,
      saved.id,
      'deny-cleanup'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  let errors = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    errors += data;
  });

  const [exit, signal] = await once(child, 'exit');

  assert.equal(exit, 0, `${signal}: ${errors}`);

  const result = JSON.parse(output);
  assert.ok(result.changed);
  assert.equal(result.error.code, 'YAMB_STORAGE_WRITE');
  assert.equal(result.error.cause.name, 'SuppressedError');
  assert.equal(result.error.cause.error.code, 'EACCES');
  assert.equal(result.error.cause.suppressed.code, 'EFBIG');

  assert.equal(result.leftovers.length, 1);
  assert.deepEqual(await readFile(target), original);

  await storage.open();
  const leftovers = await readdir(path);
  assert.deepEqual(
    leftovers.filter((name) => name.endsWith('.tmp')),
    []
  );

  const loaded = await storage.find(saved.id);
  assert.equal(loaded.text, saved.text);
});
