import { StorageNotOpenError } from '#core/errors';

const states = new WeakMap();

export const getState = (storage) => states.get(storage);
export const setState = (storage, state) => states.set(storage, state);

export function ready(state, generation = state.generation) {
  if (state.status !== 'open' || state.closing || generation !== state.generation) {
    throw new StorageNotOpenError();
  }
}

export function classify(cause, ErrorType, signal) {
  if (signal?.aborted) {
    return signal.reason;
  }

  if (cause?.code?.startsWith('YAMB_')) {
    return cause;
  }

  return new ErrorType('files storage operation failed', { cause });
}

async function run(state, job) {
  state.active++;

  if (job.write) {
    state.writing = true;
  }

  try {
    job.signal?.throwIfAborted();
    job.resolve(await job.fn());
  } catch (cause) {
    job.reject(classify(cause, job.ErrorType, job.signal));
  } finally {
    state.active--;
    state.pending--;

    if (job.write) {
      state.writing = false;
    }

    drain(state);

    if (state.pending === 0) {
      state.idle?.();
      state.idle = null;
    }
  }
}

function drain(state) {
  while (state.queue.length && !state.writing && state.active < 8) {
    if (state.queue[0].write && state.active > 0) {
      return;
    }

    const job = state.queue.shift();
    void run(state, job);
  }
}

export function enqueue(state, write, signal, ErrorType, fn) {
  ready(state);
  signal?.throwIfAborted();

  if (state.pending >= 64) {
    throw new ErrorType('files operation queue is full (64)');
  }

  state.pending++;
  const promise = new Promise((resolve, reject) => {
    state.queue.push({ write, signal, ErrorType, fn, resolve, reject });
  });
  drain(state);

  return promise;
}
