import { createHook } from 'node:async_hooks';
import { chmodSync, readdirSync } from 'node:fs';

import { files } from '../src/index.js';

process.on('SIGXFSZ', () => {});

const path = process.argv[2];
const deny = process.argv[4] === 'deny-cleanup';
const storage = files({ path });
await storage.open();

let changed = false;
const hook = createHook({
  before() {
    if (deny && !changed && readdirSync(path).some((name) => name.endsWith('.tmp'))) {
      changed = true;
      chmodSync(path, 0o500);
    }
  }
});

function serialize(error) {
  if (!error) {
    return undefined;
  }

  return {
    name: error.name,
    code: error.code,
    cause: serialize(error.cause),
    error: serialize(error.error),
    suppressed: serialize(error.suppressed),
    errors: error.errors?.map(serialize)
  };
}

try {
  const post = await storage.find(process.argv[3]);

  if (deny) {
    hook.enable();
  }

  await storage.save({ ...post, text: 'x'.repeat(1024 * 1024) });

  process.exitCode = 2;
} catch (error) {
  hook.disable();

  if (deny) {
    const failure = serialize(error);
    const leftovers = readdirSync(path).filter((name) => name.endsWith('.tmp'));

    console.log(JSON.stringify({ changed, error: failure, leftovers }));
  } else {
    console.log(JSON.stringify({ code: error.code, cause: error.cause?.code }));
  }
} finally {
  hook.disable();

  if (changed) {
    chmodSync(path, 0o700);
  }

  await storage.close();
}
