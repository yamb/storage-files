import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { yamb } from 'yamb';

import { files } from '../src/index.js';

export const code = (value) => (error) => error.code === value;
export const raw = (slug, fields = {}) => ({
  uri: `drafts/${slug}`,
  slug,
  title: slug,
  text: '# Original\r\n\n```md\n---\n```\n\nПривет 🦔\n',
  status: 'draft',
  tags: [],
  links: { related: [] },
  createdAt: '2026-01-01T00:00:00.000000001Z',
  updatedAt: '2026-01-01T00:00:00.000000001Z',
  ...fields
});

export async function fixture(t, config = {}, options) {
  const dir = await mkdtempDisposable(join(tmpdir(), 'yamb-files-'));
  const storage = files({ path: join(dir.path, 'posts'), ...config });
  const blog = yamb({
    storage,
    base: 'https://example.com/blog',
    clock: () => Temporal.Instant.from('2026-06-01T00:00:00Z'),
    options
  });

  t.after(async () => {
    await blog.close();
    await storage.close();
    await dir.remove();
  });

  await blog.open();
  return { dir: dir.path, path: join(dir.path, 'posts'), storage, blog };
}
