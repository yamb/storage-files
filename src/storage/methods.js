import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  StorageReadError,
  StorageWriteError,
  StorageDuplicateError,
  PostConflictError,
  PostNotFoundError
} from '#core/errors';
import { IdSchema, UriSchema, VersionSchema } from '#core/schemas';

import { capture, encode, inspect, read, write, uuid } from '../file.js';
import { matches, project, query, select, size } from '../query.js';
import { classify, enqueue, getState, ready } from './internal.js';

function file(state, id) {
  return join(state.config.path, `${id}.md`);
}

function storable(id) {
  if (typeof id === 'string' && uuid.test(id)) {
    return true;
  }

  IdSchema.parse(id);
  return false;
}

function missing(id) {
  return new PostNotFoundError(`id "${id}" not found`);
}

function expect(meta, id, expected) {
  if (expected !== undefined && meta.version !== expected) {
    throw new PostConflictError(`id "${id}" has another version`, { details: { id, expected } });
  }
}

export async function find(storage, id, options = {}) {
  const state = getState(storage);
  const { signal } = options;
  ready(state);

  try {
    signal?.throwIfAborted();

    if (!storable(id)) {
      return null;
    }

    const path = file(state, id);

    return await enqueue(state, false, signal, StorageReadError, () =>
      read(path, id, state.config.bytes, signal)
    );
  } catch (cause) {
    throw classify(cause, StorageReadError, signal);
  }
}

export async function fetch(storage, uri, options = {}) {
  const state = getState(storage);
  const { signal } = options;
  ready(state);

  try {
    UriSchema.parse(uri);

    return await enqueue(state, false, signal, StorageReadError, async () => {
      const id = state.uris.get(uri);

      if (!id) {
        return null;
      }

      const raw = await read(file(state, id), id, state.config.bytes, signal);

      return raw?.uri === uri ? raw : null;
    });
  } catch (cause) {
    throw classify(cause, StorageReadError, signal);
  }
}

export async function save(storage, input, options = {}) {
  const state = getState(storage);
  const { signal, expected } = options;
  ready(state);
  signal?.throwIfAborted();

  try {
    const raw = capture(input);
    const insert = raw.id === undefined;

    if (insert) {
      raw.id = randomUUID();
    } else if (!storable(raw.id)) {
      throw missing(raw.id);
    }

    const content = encode(raw, state.config.bytes);
    const meta = project(raw);
    const bytes = size(meta);

    return await enqueue(state, true, signal, StorageWriteError, async () => {
      const previous = await inspect(file(state, raw.id));

      const stored = state.index.get(raw.id);

      if (!insert && (!previous || !stored)) {
        throw missing(raw.id);
      }

      if (insert && previous) {
        throw new StorageWriteError('generated id already exists');
      }

      if (stored) {
        expect(stored, raw.id, expected);
      }

      const duplicate = state.uris.get(raw.uri);
      if (duplicate !== undefined && duplicate !== raw.id) {
        throw new StorageDuplicateError(`duplicate uri "${raw.uri}"`);
      }

      if (insert && state.index.size >= state.config.capacity) {
        throw new StorageWriteError('post capacity exceeded');
      }

      const memory = state.memory - (stored ? size(stored) : 0) + bytes;

      if (memory > state.config.memory) {
        throw new StorageWriteError('metadata memory budget exceeded');
      }

      await write(state.config.path, raw.id, content, previous, signal);

      if (stored) {
        state.uris.delete(stored.uri);
      }

      state.index.set(raw.id, meta);
      state.uris.set(raw.uri, raw.id);
      state.memory = memory;

      return raw;
    });
  } catch (cause) {
    throw classify(cause, StorageWriteError, signal);
  }
}

export async function remove(storage, id, options = {}) {
  const state = getState(storage);
  const { signal, expected } = options;
  ready(state);

  try {
    if (!storable(id)) {
      throw missing(id);
    }

    const path = file(state, id);

    return await enqueue(state, true, signal, StorageWriteError, async () => {
      const info = await inspect(path);
      const meta = state.index.get(id);

      if (!info || !meta) {
        throw missing(id);
      }

      expect(meta, id, expected);
      signal?.throwIfAborted();
      await unlink(path);
      state.index.delete(id);
      state.uris.delete(meta.uri);
      state.memory -= size(meta);
    });
  } catch (cause) {
    throw classify(cause, StorageWriteError, signal);
  }
}

export async function fence(storage, id, version, options = {}) {
  const state = getState(storage);
  const { signal, expected } = options;
  ready(state);

  try {
    VersionSchema.parse(version);

    if (!storable(id)) {
      throw missing(id);
    }

    const path = file(state, id);

    return await enqueue(state, true, signal, StorageWriteError, async () => {
      const previous = await inspect(path);
      const stored = state.index.get(id);

      if (!previous || !stored) {
        throw missing(id);
      }

      expect(stored, id, expected);

      const raw = await read(path, id, state.config.bytes, signal);

      if (!raw) {
        throw missing(id);
      }

      if (!isDeepStrictEqual(project(raw), stored)) {
        throw new StorageWriteError('post changed outside the owner; sync required');
      }

      raw.version = version;

      const content = encode(raw, state.config.bytes);
      const meta = project(raw);
      const memory = state.memory - size(stored) + size(meta);

      if (memory > state.config.memory) {
        throw new StorageWriteError('metadata memory budget exceeded');
      }

      await write(state.config.path, id, content, previous, signal);
      state.index.set(id, meta);
      state.memory = memory;
    });
  } catch (cause) {
    throw classify(cause, StorageWriteError, signal);
  }
}

export function all(storage, input = {}, options = {}) {
  const state = getState(storage);
  ready(state);

  const { filter, page } = query(input, options);
  const { signal } = page;
  signal?.throwIfAborted();
  const { generation } = state;

  return {
    async *[Symbol.asyncIterator]() {
      ready(state, generation);
      signal?.throwIfAborted();
      const ids = select(state.index, filter, page, state.defaults);

      for (const id of ids) {
        ready(state, generation);
        const raw = await find(storage, id, { signal });
        signal?.throwIfAborted();

        if (raw && matches(project(raw), filter, state.defaults, page.order)) {
          yield raw;
          ready(state, generation);
          signal?.throwIfAborted();
        }
      }
    }
  };
}

export async function count(storage, input = {}, options = {}) {
  const state = getState(storage);
  ready(state);

  const { filter, page } = query(input, options);
  page.signal?.throwIfAborted();

  let total = 0;

  for (const meta of state.index.values()) {
    if (matches(meta, filter, state.defaults)) {
      total++;
    }
  }

  return total;
}

export function entries(storage, options = {}) {
  const state = getState(storage);
  ready(state);

  const { signal } = options;
  const { generation } = state;
  signal?.throwIfAborted();

  return {
    async *[Symbol.asyncIterator]() {
      ready(state, generation);
      const pairs = Array.from(state.index.values(), ({ id, uri }) => [id, uri]);

      for (const pair of pairs) {
        ready(state, generation);
        signal?.throwIfAborted();
        yield pair;
        ready(state, generation);
        signal?.throwIfAborted();
      }
    }
  };
}
