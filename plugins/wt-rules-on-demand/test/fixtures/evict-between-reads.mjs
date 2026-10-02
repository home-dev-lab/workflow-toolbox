// Preloaded into a reader process (`node --import`) by store-join.test.mjs: the hook "evicts" one context, moving it
// from the store file to a new archive, at one of two moments of the reader's run: `before-store-read` (just before the
// reader reads the store file) or `after-first-listing` (just after its first listing of the quality data directory).
// A reader that reads its store before listing the archives finds the context at either moment, in the store or in the
// new archive; one that lists first misses it at the first moment. Inert unless ROD_EVICT_BETWEEN_READS names the plan.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const plan = process.env.ROD_EVICT_BETWEEN_READS ? JSON.parse(process.env.ROD_EVICT_BETWEEN_READS) : null;
if (plan) {
  const promises = createRequire(import.meta.url)('node:fs').promises;
  const { readdir, readFile } = promises;
  let evicted = false;
  const once = () => { if (!evicted) { evicted = true; evict(plan); } };
  promises.readdir = async function patchedReaddir(path, ...rest) {
    const listing = await readdir.call(this, path, ...rest);
    if (plan.moment === 'after-first-listing' && resolve(String(path)) === resolve(plan.quality)) once();
    return listing;
  };
  promises.readFile = async function patchedReadFile(path, ...rest) {
    if (plan.moment === 'before-store-read' && resolve(String(path)) === resolve(plan.storePath)) once();
    return readFile.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}

function evict({ storePath, quality, name, sessionId, key }) {
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const session = store.sessions[sessionId];
  const context = session.contexts[key];
  delete session.contexts[key];
  writeFileSync(join(quality, name), JSON.stringify({ format: 2, key: 'sessions', archivedAt: new Date().toISOString(),
    value: [{ sessionId, first: session.first, last: session.last, key, context }] }));
  writeFileSync(storePath, JSON.stringify(store));
}
