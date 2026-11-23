import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { PostSchema } from '#core/schemas';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const temporary =
  /^\.yamb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export function assertId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) {
    throw new Error('post id must be a lowercase UUID');
  }

  return id;
}

function unicode(value) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) {
      throw new Error('unpaired Unicode surrogate');
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      unicode(key);
      unicode(entry);
    }
  }
}

export function capture(input) {
  const parsed = PostSchema.parse(input);
  const raw = z.encode(PostSchema, parsed);
  unicode(raw);

  return raw;
}

export function encode(raw, bytes) {
  const { text, ...meta } = raw;
  const content = `---\n${JSON.stringify(meta, null, 2)}\n---\n${text}`;

  if (Buffer.byteLength(content) > bytes) {
    throw new Error('post exceeds file byte budget');
  }

  return content;
}

export function regular(info) {
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error('expected a regular file with one link');
  }
}

export function owned(info) {
  regular(info);

  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('file belongs to another owner');
  }
}

export function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

export async function inspect(path) {
  try {
    const info = await lstat(path);
    regular(info);

    return info;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function read(path, id, bytes, signal) {
  signal?.throwIfAborted();
  const before = await inspect(path);

  if (!before) {
    return null;
  }

  if (before.size > bytes) {
    throw new Error('post exceeds file byte budget');
  }

  signal?.throwIfAborted();
  let buffer;

  {
    await using handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const info = await handle.stat();
    regular(info);

    if (!same(before, info) || info.size !== before.size) {
      throw new Error('post changed during read');
    }

    buffer = Buffer.alloc(info.size + 1);
    let offset = 0;

    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);

      if (bytesRead === 0) {
        break;
      }

      offset += bytesRead;
    }

    const after = await handle.stat();

    if (
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new Error('post changed during read');
    }

    buffer = buffer.subarray(0, offset);
  }

  signal?.throwIfAborted();
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  const end = content.indexOf('\n---\n', 4);

  if (!content.startsWith('---\n') || end === -1) {
    throw new Error('invalid JSON frontmatter');
  }

  const meta = JSON.parse(content.slice(4, end));

  if (
    !meta ||
    typeof meta !== 'object' ||
    Array.isArray(meta) ||
    Object.hasOwn(meta, 'text') ||
    meta.id !== id
  ) {
    throw new Error('frontmatter must match filename and omit text');
  }

  return capture({ ...meta, text: content.slice(end + 5) });
}

export async function release(path, info) {
  const current = await lstat(path);
  owned(current);

  if (!same(info, current)) {
    throw new Error('refusing to remove a replaced owned file');
  }

  await unlink(path);
}

export async function write(root, id, content, previous, signal) {
  const path = join(root, `${id}.md`);
  const temp = join(root, `.yamb-${randomUUID()}.tmp`);
  await using cleanup = new AsyncDisposableStack();
  let committed = false;

  signal?.throwIfAborted();

  {
    await using handle = await open(temp, 'wx', 0o600);
    const info = await handle.stat();

    cleanup.defer(async () => {
      if (!committed) {
        await release(temp, info);
      }
    });
    owned(info);

    await handle.writeFile(content, 'utf8');
    await handle.sync();
  }

  const current = await inspect(path);
  const changed = previous ? !current || !same(previous, current) : current !== null;

  if (changed) {
    throw new Error('post changed before commit; sync required');
  }

  signal?.throwIfAborted();
  await rename(temp, path);
  committed = true;
}
