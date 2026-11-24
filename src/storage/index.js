import { resolve } from 'node:path';

import { z } from 'zod';

import { FilesConfigError } from '../errors/index.js';
import { setState } from './internal.js';
import { open, close, sync } from './lifecycle.js';
import { find, fetch, save, remove, fence, all, count, entries } from './methods.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ConfigSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((path) => !path.includes('\0')),
  capacity: positive.default(10000),
  bytes: positive.default(8388608),
  memory: positive.default(33554432)
});
const methods = { open, close, sync, find, fetch, save, remove, fence, all, count, entries };

export class FilesStorage {
  constructor(config) {
    const result = ConfigSchema.safeParse(config);

    if (!result.success) {
      throw new FilesConfigError('invalid files configuration', { cause: result.error });
    }

    setState(this, {
      config: { ...result.data, path: resolve(result.data.path) },
      status: 'closed',
      index: new Map(),
      uris: new Map(),
      defaults: {},
      memory: 0,
      lock: null,
      opening: null,
      closing: null,
      generation: 0,
      queue: [],
      active: 0,
      pending: 0,
      writing: false,
      idle: null
    });
  }

  static {
    for (const [name, fn] of Object.entries(methods)) {
      Object.defineProperty(this.prototype, name, {
        value(...args) {
          return fn(this, ...args);
        },
        writable: false,
        configurable: false,
        enumerable: false
      });
    }
  }
}

export function files(config) {
  return new FilesStorage(config);
}
