# yamb-storage-files

[![npm version][npm-image]][npm-url] [![Build status][github-actions-image]][github-actions-url] [![Coverage status][coveralls-image]][coveralls-url] [![Dependency status][libraries-image]][libraries-url]

Store [Yamb](https://github.com/yamb/yamb) posts as Markdown with JSON frontmatter in a trusted local directory with one writer.

For GitHub Packages, route the `@yamb` scope to `https://npm.pkg.github.com` and install `@yamb/storage-files`.

## Quick start

Requires Node.js 26.13 or later and `yamb` 1.1.0 or later.

```bash
pnpm add yamb yamb-storage-files
```

Use a trusted directory. The adapter creates `./posts` if needed.

```js
import { yamb } from 'yamb';
import { files } from 'yamb-storage-files';

await using blog = yamb({
  storage: files({
    path: './posts'
  })
});

await blog.open();

const post = await blog.create({
  title: 'Hello',
  text: '# Hello\n\nSource Markdown.\n'
});

const saved = await blog.find(post.id);

console.log(saved.text);
```

## Reference

### Configuration

`files(config)` returns a `FilesStorage`. Unknown keys are rejected; numeric budgets must be positive safe integers.

| Key        | Meaning                                                           | Default    |
| ---------- | ----------------------------------------------------------------- | ---------- |
| `path`     | Directory, resolved at construction and created on open if absent | Required   |
| `capacity` | Maximum post count                                                | `10000`    |
| `bytes`    | Maximum UTF-8 bytes per complete file                             | `8388608`  |
| `memory`   | Maximum total UTF-8 JSON bytes of metadata projections            | `33554432` |

`memory` counts serialized query metadata. Bodies and queued inputs require additional memory. Core post limits also apply.

### File format

Each post is `<lowercase UUID>.md` in strict UTF-8. The filename stays stable when the slug changes. Given a raw post record, its file is encoded as follows.

```js
const { text, ...metadata } = raw;
const content = `---\n${JSON.stringify(metadata, null, 2)}\n---\n${text}`;
```

Dates in the JSON frontmatter are fixed-precision UTC strings. The body preserves source bytes, including CRLF and trailing newlines. Preview, cover, options and related IDs round-trip in the frontmatter.

File reads validate the complete file. Invalid JSON, metadata containing `text`, a filename/ID mismatch, invalid UTF-8, unpaired surrogates and budget overflow fail. Root symlinks, post symlinks, hardlinks, nonregular post files and invalid filenames ending in `.md` are rejected. The directory scan ignores unrelated filenames.

Only lowercase UUIDs are stored. For any other valid core ID, `find(id)` returns `null` and updates, removals and fences reject with `YAMB_POST_NOT_FOUND`, without filesystem access. Invalid IDs fail with `YAMB_STORAGE_READ` or `YAMB_STORAGE_WRITE`.

### Operational limits

Use one owner per trusted local directory, with trusted parent directories. After a crash, confirm the previous owner has exited before removing a stale `.yamb.lock`. Coordinate external edits with the owner, then call `blog.sync()` before querying. A failed refresh keeps the previous index.

The file I/O queue admits up to 64 active and waiting operations per owner. Further file I/O requests reject immediately. `find(id)` and `fetch(uri)` read the matching record. `count()` and `entries()` read the in-memory index directly, with `entries()` yielding `[id, uri]` pairs. Writes replace complete records and are atomic per file. Recheck storage before retrying an uncertain write. Concurrent changes can shorten a query page. Start a new iteration after reopening the adapter.

Core stores a version string as the `version` frontmatter key. Because the owner is the only writer and writes run one at a time, a conditional save, removal or fence compares the expected version with the indexed one inside the exclusive write slot and then commits through the usual temporary file and rename; `null` matches a file without a version. A mismatch reports `YAMB_POST_CONFLICT` for an existing post and `YAMB_POST_NOT_FOUND` otherwise. A fence rewrites the file with only the version changed and rejects with `YAMB_STORAGE_WRITE` when the file's metadata no longer matches the index. Files written before versions need no migration. Versions do not detect external edits; coordinate them and call `blog.sync()` as described above.

### Errors

| Code | Meaning |
| --- | --- |
| `YAMB_FILES_CONFIG` | Invalid configuration (`FilesConfigError`) |
| `YAMB_FILES_OPEN` | Directory, lock, scan or budget failure during open (`FilesOpenError`) |
| `YAMB_STORAGE_READ`, `YAMB_STORAGE_WRITE` | Read/write, validation, budget, queue or cleanup failure; cause retained |
| `YAMB_STORAGE_DUPLICATE` | Duplicate URI |
| `YAMB_POST_NOT_FOUND` | Missing update/removal/fence target; missing reads return `null` |
| `YAMB_POST_CONFLICT` | Stored version differs from the expected one; nothing written |
| `YAMB_STORAGE_NOT_OPEN` | Operation outside an open lifetime |
| `YAMB_QUERY_VALIDATION` | Invalid query or pagination |

Adapter-specific errors are exported from `yamb-storage-files/errors`; shared errors come from `yamb/errors`. Operation signals preserve their native cancellation reason.

- [Yamb quick start](https://github.com/yamb/yamb#quick-start) for editing, publishing and querying posts
- [Architecture](docs/architecture.md)

## Author

[Alexey Simonenko](https://simonenko.xyz)

## License

MIT. See `LICENSE`.

[npm-image]: https://img.shields.io/npm/v/yamb-storage-files?style=flat
[npm-url]: https://www.npmjs.com/package/yamb-storage-files
[github-actions-image]: https://github.com/yamb/storage-files/actions/workflows/ci.yml/badge.svg
[github-actions-url]: https://github.com/yamb/storage-files/actions/workflows/ci.yml
[coveralls-image]: https://coveralls.io/repos/github/yamb/storage-files/badge.svg
[coveralls-url]: https://coveralls.io/github/yamb/storage-files
[libraries-image]: https://img.shields.io/librariesio/release/npm/yamb-storage-files?style=flat
[libraries-url]: https://libraries.io/npm/yamb-storage-files
