# File storage architecture

File storage targets small stores in a trusted local directory. The Markdown file is the durable record. The metadata index is rebuilt from files, so queries can select posts without reading every body.

## Directory ownership

[Open](../src/storage/lifecycle.js) exclusively creates `.yamb.lock` before scanning. It removes only regular, single-link `.yamb-<UUID>.tmp` files owned by the current user. An unsafe temporary or failed cleanup prevents acquisition. Close and failed open release only the lock they acquired; a replaced lock is preserved.

One FIFO queue permits up to eight concurrent reads and runs save, remove, fence and sync exclusively. Close drains admitted work before releasing the lock. Cursors retain their original open generation.

## Commit point

A save writes and flushes a temporary file in the target directory. The [file layer](../src/file.js) renames it over the target and the adapter then updates the in-memory index. Removal commits at unlink. Both paths report success after the filesystem commit even if cancellation arrives late. Independent edits replace whole records.

The directory is outside the fsync boundary, so visibility after rename does not guarantee survival through power loss. A failure before rename preserves the original file. If temporary cleanup also fails, open can recover the abandoned temporary.

## Index replacement

Open and sync validate up to eight files at a time and drain started reads before reporting failure. A complete scan replaces the index in one step. Projections retain scalar options and the presence, but no values, of nested options. Count reads metadata only. Traversal selects IDs, reads one body at a time and rechecks its predicate before yield.

See the [file format, limits and operational contract](../readme.md#reference).
