import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  StorageReadError,
  StorageWriteError,
  StorageDuplicateError,
  PostNotFoundError
} from '#core/errors';
import { IdSchema, UriSchema } from '#core/schemas';

import { assertId, capture, encode, inspect, read, write, same, uuid } from '../file.js';
import { matches, project, query, select, size } from '../query.js';
import { classify, enqueue, getState, ready } from './internal.js';

function file(state, id) {
  return join(state.config.path, `${assertId(id)}.md`);
}

export async function find(storage, id, options = {}) {
  const state = getState(storage);
  const { signal } = options;
  ready(state);

  try {
    signal?.throwIfAborted();

    if (typeof id !== 'string' || !uuid.test(id)) {
      IdSchema.parse(id);
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
  const { signal } = options;
  ready(state);
  signal?.throwIfAborted();

  try {
    const raw = capture(input);
    const insert = raw.id === undefined;
    raw.id = insert ? randomUUID() : assertId(raw.id);

    const content = encode(raw, state.config.bytes);
    const meta = project(raw);
    const bytes = size(meta);

    return await enqueue(state, true, signal, StorageWriteError, async () => {
      const previous = await inspect(file(state, raw.id));

      if (!insert && (!previous || !state.index.has(raw.id))) {
        throw new PostNotFoundError(`id "${raw.id}" not found`);
      }

      if (insert && previous) {
        throw new StorageWriteError('generated id already exists');
      }

      const duplicate = state.uris.get(raw.uri);
      if (duplicate !== undefined && duplicate !== raw.id) {
        throw new StorageDuplicateError(`duplicate uri "${raw.uri}"`);
      }

      if (insert && state.index.size >= state.config.capacity) {
        throw new StorageWriteError('post capacity exceeded');
      }

      const stored = state.index.get(raw.id);
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
  const { signal } = options;
  ready(state);

  try {
    const path = file(state, id);

    return await enqueue(state, true, signal, StorageWriteError, async () => {
      const info = await inspect(path);
      const meta = state.index.get(id);

      if (!info || !meta) {
        throw new PostNotFoundError(`id "${id}" not found`);
      }

      const current = await inspect(path);

      if (!current || !same(info, current)) {
        throw new StorageWriteError('post changed before removal');
      }

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
