// The property matrix needs real eviction/split logic, not megabytes of padding per growth.
// Full-size host/store/file contracts remain covered by the dedicated budget and join tests.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as originalHooks from '../hooks/hooks.js';
import { STORE_ARCHIVE } from '../hooks/store-budget.js';
import { hostStore as baseStore, hookFixture as baseFixture, HOST_STORE_LIMIT as realLimit, sandboxRoot } from '../test/store-host-fake.mjs';

export const HOST_STORE_LIMIT = Math.floor(realLimit / 10);
const SESSION_BUDGET = 200_000;
const PART_BYTES = 100_000;
const originalPadding = '界'.repeat(1000), fixturePadding = '界'.repeat(20);
const hooksUrl = new URL('../hooks/hooks.js', import.meta.url);
const budgetUrl = new URL('../hooks/store-budget.js', import.meta.url);
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const absoluteImports = (source, base) => source.replace(/from '(\.[^']+)'/g, (_match, path) => `from ${JSON.stringify(new URL(path, base).href)}`);

function replaceOne(source, before, after) {
  assert.equal(source.split(before).length, 2, `fixture must replace exactly one ${before}`);
  return source.replace(before, () => after);
}

// Keep the installed source as the input (including mutations); change only two fixture limits.
let budget = absoluteImports(await readFile(budgetUrl, 'utf8'), budgetUrl);
budget = replaceOne(budget, 'sessions: 2_000_000', `sessions: ${SESSION_BUDGET}`);
budget = replaceOne(budget, 'ARCHIVE_PART_BYTES = 3_000_000', `ARCHIVE_PART_BYTES = ${PART_BYTES}`);
let hooks = absoluteImports(await readFile(hooksUrl, 'utf8'), hooksUrl);
hooks = replaceOne(hooks, `from ${JSON.stringify(budgetUrl.href)}`, `from ${JSON.stringify(dataUrl(budget))}`);
// Resolve shipped companions from the real module location, as ordinary imports do.
hooks = hooks.replaceAll('import.meta.url', () => JSON.stringify(hooksUrl.href));
const moduleUrl = dataUrl(hooks);
let reloads = 0;

// A distinct module instance on every reload, just like the matrix's original query-string imports.
const smallStoreHooks = () => import(`${moduleUrl}#${++reloads}`);
const instances = new WeakMap();

// Each requested real namespace has its own scaled counterpart, including the shared initial namespace.
export async function hookFixture(root, store, options = {}) {
  const { hooks: requested = originalHooks } = options;
  if (!instances.has(requested)) instances.set(requested, smallStoreHooks());
  return baseFixture(root, store, { ...options, hooks: await instances.get(requested) });
}

function compactSessions(sessions) {
  for (const session of Object.values(sessions ?? {})) {
    for (const context of Object.values(session.contexts ?? {})) {
      for (const row of context.complianceInjected ?? []) {
        if (row.pad === originalPadding) row.pad = fixturePadding;
      }
    }
  }
}

// Compact the padding marker at the fixture storage boundary; retain all rows and identifiers.
export function hostStore(initial = {}, options = {}) {
  compactSessions(initial.sessions);
  const store = baseStore(initial, { limit: HOST_STORE_LIMIT, ...options });
  const set = store.map.set;
  store.map.set = function (key, value) {
    if (key === 'sessions') compactSessions(value);
    return Reflect.apply(set, this, [key, value]);
  };
  return store;
}

export async function assertSmallStoreFixture(t) {
  const at = '2026-10-01T10:00:00.000Z', label = 'scaled fixture';
  const context = { seg: 'fixture', last: at, served: {}, suppressedCap: {}, governedActs: [],
    complianceInjected: Array.from({ length: 2100 }, (_, i) => ({ rule: 'sample.md', at, deliveryId: `pre-fixture-${i}`, pad: originalPadding })) };
  const sessions = { 'sample-session': { first: at, last: at, contexts: { 0: context } } };
  const store = hostStore({ sessions });
  assert.equal(context.complianceInjected.length, 2100);
  assert.ok(context.complianceInjected.every((row) => row.pad === fixturePadding), 'every growth row is compacted');
  assert.ok(JSON.stringify(sessions).length > SESSION_BUDGET, 'growth must force session eviction');
  assert.ok(Buffer.byteLength(JSON.stringify(context)) > PART_BYTES, 'growth must force archive splitting');
  const f = await hookFixture(await sandboxRoot(t, 'rod-scaled-contract-'), store);
  await mkdir(f.quality, { recursive: true });
  await f.call({ command: 'git push origin main', agentId: 'fixture' });
  const units = [];
  for (const name of (await readdir(f.quality)).filter((name) => name.startsWith(STORE_ARCHIVE.prefix))) {
    const text = await readFile(join(f.quality, name), 'utf8');
    assert.ok(Buffer.byteLength(text) <= PART_BYTES, `${label}: every archive part respects the fixture limit`);
    const archive = JSON.parse(text);
    if (archive.key === 'sessions') units.push(...archive.value);
  }
  const splitPieces = units.filter((unit) => unit.split?.of > 1).length;
  assert.ok(splitPieces > 1, 'the matrix must actually read multipart context archives');
  const ids = units.flatMap((unit) => unit.context?.complianceInjected ?? []).map((row) => row.deliveryId).filter((id) => id.startsWith('pre-fixture-'));
  assert.equal(ids.length, 2100);
  assert.equal(new Set(ids).size, 2100);
  assert.deepEqual(f.logs.filter((line) => /write failed|sweep failed/.test(line)), []);
}
