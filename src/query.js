import { z } from 'zod';

import { QueryValidationError } from '#core/errors';
import { QuerySchema, OptionsSchema, InstantSchema, UriSchema, encodeInstant } from '#core/schemas';

const CursorSchema = z.strictObject({ publishedAt: InstantSchema, uri: UriSchema });
const FilterSchema = QuerySchema.extend({ cursor: CursorSchema.optional() });

export function query(input = {}, options = {}) {
  try {
    const filter = FilterSchema.parse(input);
    const page = OptionsSchema.parse(options);

    for (const key of ['before', 'after']) {
      if (filter[key]) {
        filter[key] = encodeInstant(filter[key]);
      }
    }

    if (filter.cursor) {
      filter.cursor.publishedAt = encodeInstant(filter.cursor.publishedAt);
    }

    return { filter, page };
  } catch (cause) {
    throw new QueryValidationError('invalid storage query or pagination', { cause });
  }
}

export function project(raw) {
  const options = {};
  const present = [];

  for (const [key, value] of Object.entries(raw.options ?? {})) {
    if (value !== null && typeof value === 'object') {
      present.push(key);
    } else {
      Object.defineProperty(options, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }

  return {
    id: raw.id,
    uri: raw.uri,
    title: raw.title,
    status: raw.status,
    tags: [...raw.tags],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    publishedAt: raw.publishedAt,
    options,
    present,
    version: raw.version ?? null
  };
}

export function size(meta) {
  return Buffer.byteLength(JSON.stringify(meta));
}

export function compare(a, b) {
  if (a == null) {
    return b == null ? 0 : -1;
  }

  if (b == null) {
    return 1;
  }

  return a < b ? -1 : Number(a > b);
}

export function matches(meta, filter, defaults, order = '-publishedAt') {
  for (const key of ['status', 'uri']) {
    if (filter[key] !== undefined && meta[key] !== filter[key]) {
      return false;
    }
  }

  if (filter.tag !== undefined && !meta.tags.includes(filter.tag)) {
    return false;
  }
  if (filter.tags?.some((tag) => !meta.tags.includes(tag))) {
    return false;
  }
  if (filter.before && (meta.publishedAt == null || meta.publishedAt >= filter.before)) {
    return false;
  }
  if (filter.after && (meta.publishedAt == null || meta.publishedAt <= filter.after)) {
    return false;
  }

  for (const [key, value] of Object.entries(filter.options ?? {})) {
    if (meta.present.includes(key)) {
      return false;
    }

    const actual = Object.hasOwn(meta.options, key) ? meta.options[key] : defaults[key];

    if (actual !== value) {
      return false;
    }
  }

  if (filter.cursor) {
    if (meta.publishedAt == null) {
      return false;
    }

    const direction = order.startsWith('-') ? -1 : 1;
    const result =
      compare(meta.publishedAt, filter.cursor.publishedAt) || compare(meta.uri, filter.cursor.uri);

    if (result * direction <= 0) {
      return false;
    }
  }

  return true;
}

export function select(index, filter, page, defaults) {
  const order = page.order ?? '-publishedAt';
  const descending = order.startsWith('-');
  const field = descending ? order.slice(1) : order;
  const direction = descending ? -1 : 1;
  const selected = [...index.values()].filter((meta) => matches(meta, filter, defaults, order));

  selected.sort((a, b) => {
    const result = compare(a[field], b[field]) || compare(a.uri, b.uri);

    return result * direction;
  });

  const offset = page.offset ?? 0;

  return selected
    .slice(offset, page.limit == null ? undefined : offset + page.limit)
    .map((meta) => meta.id);
}
