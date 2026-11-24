import { mkdir, lstat, open as openFile, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { StorageReadError, StorageWriteError, StorageDuplicateError } from '#core/errors';

import { FilesOpenError } from '../errors/index.js';
import { owned, read, release, temporary, assertId } from '../file.js';
import { project, size } from '../query.js';
import { enqueue, getState } from './internal.js';

async function metadata(state, name, signal) {
  try {
    const id = assertId(name.slice(0, -3));
    const raw = await read(join(state.config.path, name), id, state.config.bytes, signal);

    if (!raw) {
      throw new StorageReadError('post disappeared during scan');
    }

    return { meta: project(raw) };
  } catch (error) {
    return { error };
  }
}

export async function scan(state, signal, cleanup = false) {
  const index = new Map();
  const uris = new Map();
  let memory = 0;
  let pending = [];

  async function flush() {
    const results = await Promise.all(pending);
    pending = [];

    for (const result of results) {
      if (Object.hasOwn(result, 'error')) {
        throw result.error;
      }

      const { meta } = result;

      if (uris.has(meta.uri)) {
        throw new StorageDuplicateError(`duplicate uri "${meta.uri}"`);
      }

      const bytes = size(meta);

      if (memory + bytes > state.config.memory) {
        throw new StorageReadError('metadata memory budget exceeded');
      }

      memory += bytes;
      index.set(meta.id, meta);
      uris.set(meta.uri, meta.id);
    }
  }

  const directory = await opendir(state.config.path);

  try {
    for await (const entry of directory) {
      signal?.throwIfAborted();

      if (temporary.test(entry.name)) {
        if (cleanup) {
          const path = join(state.config.path, entry.name);
          const info = await lstat(path);
          owned(info);
          await release(path, info);
        }

        continue;
      }

      if (!entry.name.endsWith('.md')) {
        continue;
      }

      if (index.size + pending.length >= state.config.capacity) {
        throw new StorageReadError('post capacity exceeded');
      }

      pending.push(metadata(state, entry.name, signal));

      if (pending.length === 8) {
        await flush();
      }
    }

    await flush();
    signal?.throwIfAborted();

    return { index, uris, memory };
  } finally {
    await Promise.all(pending);
  }
}

async function unlock(state) {
  if (!state.lock) {
    return;
  }

  const { info } = state.lock;
  await using _handle = state.lock.handle;
  state.lock = null;
  await release(join(state.config.path, '.yamb.lock'), info);
}

async function openOnce(state, defaults, signal) {
  try {
    signal?.throwIfAborted();
    await mkdir(state.config.path, { recursive: true });
    const root = await lstat(state.config.path);

    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('path must be a regular local directory');
    }

    signal?.throwIfAborted();
    const handle = await openFile(join(state.config.path, '.yamb.lock'), 'wx', 0o600);
    state.lock = { handle, info: null };
    state.lock.info = await handle.stat();
    owned(state.lock.info);

    const next = await scan(state, signal, true);

    Object.assign(state, next, { defaults, status: 'open' });
    state.generation++;
  } catch (cause) {
    let error = cause;

    try {
      await unlock(state);
    } catch (cleanup) {
      error = new AggregateError([cause, cleanup], 'open and lock cleanup failed');
    }

    state.status = 'closed';

    if (signal?.aborted) {
      throw signal.reason;
    }

    throw new FilesOpenError('cannot open files directory; check lock, files and budgets', {
      cause: error
    });
  }
}

export async function open(storage, context = {}) {
  const state = getState(storage);
  const { signal } = context;
  signal?.throwIfAborted();

  const defaults = structuredClone(
    z.record(z.string(), z.json()).parse(context.optionDefaults ?? {})
  );

  if (state.closing) {
    await state.closing;
  }

  if (state.status === 'open') {
    return;
  }

  if (state.opening) {
    return state.opening;
  }

  state.status = 'opening';
  state.opening = openOnce(state, defaults, signal);

  try {
    await state.opening;
  } finally {
    state.opening = null;
  }
}

async function closeOnce(state) {
  try {
    if (state.opening) {
      try {
        await state.opening;
      } catch {
        return;
      }
    }

    if (state.pending) {
      const { promise, resolve } = Promise.withResolvers();
      state.idle = resolve;
      await promise;
    }

    try {
      await unlock(state);
    } catch (cause) {
      throw new StorageWriteError('cannot release owned files lock', { cause });
    }
  } finally {
    state.status = 'closed';
    state.index = new Map();
    state.uris = new Map();
    state.memory = 0;
    state.defaults = {};
  }
}

export async function close(storage) {
  const state = getState(storage);

  if (state.closing) {
    return state.closing;
  }

  if (state.status === 'closed') {
    return;
  }

  state.closing = closeOnce(state);

  try {
    await state.closing;
  } finally {
    state.closing = null;
  }
}

export async function sync(storage, options = {}) {
  const state = getState(storage);
  const { signal } = options;

  return enqueue(state, true, signal, StorageReadError, async () => {
    const next = await scan(state, signal);
    Object.assign(state, next);
  });
}
