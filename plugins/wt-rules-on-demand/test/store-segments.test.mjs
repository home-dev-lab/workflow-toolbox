// Round-2 locks of the bounded store: no stale copy written after a sweep (R1), no partial archive (R2), archive names
// unique across writers (R3), no evicted context overwritten across shrink passes (R4), and the segment identity that
// makes every reader count one segment once whatever copies a crash, an ambiguous rejection or a second writer left (W1-W4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStore, hookFixture, atLimitStore, readerTotals, realFs, readArchives, archivedUnits, shrinkDeliveries } from './store-host-fake.mjs';
import { STORE_BUDGETS, VERDICTS, VERDICT_ARCHIVE, STORE_ARCHIVE, legacyContextSeg, legacyServedSeg, shrink } from '../hooks/store-budget.js';

const failures = (logs) => logs.filter((line) => /write failed|sweep failed/.test(line));
const minus = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
const plus = (a, b, times = 1) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + times * b[key]]));
const act = (f) => f.call({ command: 'git push origin main' });
const closeTurn = (f) => f.handlers.get('turn.complete')(f.$, { cwd: f.project }, async () => ({}));
const overSessions = (identity, segs) => atLimitStore(identity, { verdictChars: 10, sessionChars: STORE_BUDGETS.sessions + 40_000, segs });

async function sandbox(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function identityIn(root) { return (await hookFixture(root, hostStore())).identity; }

let measuredDelta = null;
// What one act adds for each reader, on an empty store where nothing is evicted.
async function actDelta(t) {
  if (measuredDelta) return measuredDelta;
  const store = hostStore();
  const f = await hookFixture(await sandbox(t, 'rod-seg-delta-'), store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  measuredDelta = minus(await readerTotals(f, store.snapshot()), before);
  return measuredDelta;
}

// How many copies of each segment exist across the store archives and the live store: (session, context, seg) for
// contexts, (rule, seg) for served counters, verdictId for verdict rows (verdict archives plus the live key).
async function copies(f, live) {
  const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const contexts = new Map(), served = new Map(), verdicts = new Map();
  for (const archive of await readArchives(f.quality)) {
    for (const unit of archivedUnits(archive)) if (unit.key !== null) count(contexts, JSON.stringify([unit.sessionId, unit.key, unit.context?.seg ?? legacyContextSeg(unit.sessionId, unit.key)]));
    if (archive.key === 'served') for (const [key, item] of Object.entries(archive.value)) count(served, JSON.stringify([key, item.seg ?? legacyServedSeg(key)]));
  }
  for (const [id, session] of Object.entries(live.sessions ?? {})) for (const [key, ctx] of Object.entries(session.contexts ?? {})) count(contexts, JSON.stringify([id, key, ctx.seg ?? legacyContextSeg(id, key)]));
  for (const [key, item] of Object.entries(live.served ?? {})) count(served, JSON.stringify([key, item.seg ?? legacyServedSeg(key)]));
  const verdictFiles = (await readdir(f.quality).catch(() => [])).filter((name) => name.startsWith(VERDICT_ARCHIVE.prefix));
  const texts = [...await Promise.all(verdictFiles.map((name) => readFile(join(f.quality, name), 'utf8'))), String(live[VERDICTS] ?? '')];
  for (const line of texts.join('\n').split('\n').filter(Boolean)) count(verdicts, JSON.parse(line).verdictId);
  const twice = (map) => [...map].filter(([, n]) => n > 1).map(([key]) => key);
  return { contexts: twice(contexts), served: twice(served), verdicts: twice(verdicts) };
}
const NONE = { contexts: [], served: [], verdicts: [] };

// A served key over its budget; `oldest` is the rule the hook serves, made the oldest entry when asked.
function overServed(oldest = false) {
  const served = {};
  const at = (i) => new Date(Date.parse('2026-09-01T00:00:00Z') + i * 1000).toISOString();
  if (oldest) served['sample.md'] = { count: 7, last: at(-1), byChannel: { 'tool.call': 7 } };
  for (let i = 0; JSON.stringify(served).length <= STORE_BUDGETS.served + 2_800; i++) served[`r-${String(i).padStart(4, '0')}.md`] = { count: 1, last: at(i), byChannel: { 'tool.call': 1 } };
  return served;
}

// R1 -------------------------------------------------------------------------------------------------------------------

test('R1: the first write on an over-budget served key archives each counter once, and readers see before plus the act', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-r1-served-');
  const identity = await identityIn(root);
  const store = hostStore({ served: overServed() });
  const f = await hookFixture(root, store);
  assert.equal(f.identity, identity);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  assert.deepEqual(await copies(f, store.snapshot()), NONE, 'no counter is both archived twice or archived and live');
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
});

test('R1: a close-only journal on an over-budget sessions key archives each context once, and readers see before plus nothing', async (t) => {
  const root = await sandbox(t, 'rod-r1-sessions-');
  const store = hostStore(overSessions(await identityIn(root), true));
  const f = await hookFixture(root, store);
  const before = await readerTotals(f, store.snapshot());
  await closeTurn(f);
  assert.deepEqual(failures(f.logs), []);
  assert.ok((await readArchives(f.quality)).length >= 1, 'the sessions key was over its budget: something moved out');
  assert.deepEqual(await copies(f, store.snapshot()), NONE);
  assert.deepEqual(await readerTotals(f, store.snapshot()), before);
});

test('R1: a verdict write refused for size after another writer grew the key archives each row once', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-r1-verdict-');
  const identity = await identityIn(root);
  let refuseNext = false;
  const store = hostStore({}, { refuse: (key) => {
    if (key !== VERDICTS || !refuseNext) return null;
    refuseNext = false;
    return 'the store would be 4200000 characters, over the 4194304 limit';
  } });
  const f = await hookFixture(root, store);
  await act(f);
  // Another writer grew the verdict key past its budget after this hook's first-write sweep.
  const grown = atLimitStore(identity, { sessionChars: 10, limit: 2_700_000 })[VERDICTS];
  store.map.set(VERDICTS, store.map.get(VERDICTS) + grown);
  const before = await readerTotals(f, store.snapshot());
  refuseNext = true;
  // A new agent context, so the rule is served again (one serve per context).
  await f.call({ command: 'git push origin main', agentId: 'second' });
  assert.equal(refuseNext, false, 'the verdict write was refused once');
  assert.deepEqual(failures(f.logs), []);
  assert.deepEqual(await copies(f, store.snapshot()), NONE, 'no verdict row sits in two archives, or in an archive and the store');
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
});

// R2 / R3 --------------------------------------------------------------------------------------------------------------

test('R2: an archive write rejected half-way leaves no file a reader would parse; R3: every archive name keeps the reader pattern', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-r2-');
  let failOnce = true;
  const fs = { ...realFs, write: async (path, text) => {
    if (failOnce && path.includes(STORE_ARCHIVE.prefix)) {
      failOnce = false;
      await realFs.write(path, text.slice(0, Math.floor(text.length / 2)));
      throw new Error('disk full');
    }
    return realFs.write(path, text);
  } };
  const store = hostStore(overSessions(await identityIn(root), true));
  const f = await hookFixture(root, store, { fs });
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.equal(failOnce, false);
  assert.match(f.logs.join('\n'), /store sweep failed: disk full/);
  const names = (await readdir(f.quality)).filter((name) => name.startsWith(STORE_ARCHIVE.prefix));
  assert.ok(names.length >= 1);
  for (const name of names) {
    JSON.parse(await readFile(join(f.quality, name), 'utf8'));
    assert.ok(Number.isSafeInteger(Number(name.match(/-(\d+)\.json$/)[1])), name);
    assert.match(name, /^rod-store-archive-\d+-\d+\.json$/);
  }
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
});

// R4 -------------------------------------------------------------------------------------------------------------------

test('R4: a context evicted in an early shrink pass is never replaced by its empty restart in a later pass', () => {
  const sessions = { s: { first: '2026-01-01', last: '2026-01-02', meta: 'm'.repeat(2_100_000),
    contexts: { 0: { seg: 'first', last: '2026-01-02', complianceInjected: [{ deliveryId: 'd' }] } } } };
  let fresh = 0;
  const { value, evicted } = shrink('sessions', sessions, 2_000_000, { id: 's', ck: '0', newSeg: () => `restart-${fresh++}` });
  assert.deepEqual([...shrinkDeliveries(evicted), ...shrinkDeliveries(value)], ['d'], 'kept plus evicted is the input');
  const segs = archivedUnits({ key: 'sessions', value: evicted }).map((unit) => unit.context.seg);
  assert.equal(new Set(segs).size, segs.length, 'each pass moves out a distinct segment');
  assert.ok(!segs.includes(value.s.contexts[0].seg), 'the restarted context is a new segment');
  assert.ok(fresh >= 2, 'the shape takes more than one pass');
});

// W1-W4 ----------------------------------------------------------------------------------------------------------------

async function crashedSweep(t, segs) {
  const delta = await actDelta(t);
  const root = await sandbox(t, segs ? 'rod-w1-' : 'rod-w1-legacy-');
  let crash = true;
  const store = hostStore(overSessions(await identityIn(root), segs), { refuse: (key) => {
    if (key !== 'sessions' || !crash) return null;
    crash = false;
    return 'killed before the store write';
  } });
  // The process that wrote the archive is gone: nothing it would have run after the store write runs, cleanup included.
  const fs = { ...realFs, remove: async (path) => { if (!crash && path.includes(STORE_ARCHIVE.prefix)) throw new Error('process gone'); return realFs.remove(path); } };
  const f = await hookFixture(root, store, { fs });
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.equal(crash, false, 'the sweep archived, then its store write never happened');
  assert.match(f.logs.join('\n'), /store sweep failed: (killed before the store write|.*process gone)/);
  const left = await copies(f, store.snapshot());
  assert.ok(left.contexts.length > 0, 'the same segments were archived twice: the crash copy and the next write');
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
}

test('W1 (a): an archive written and its store write never made still counts each segment once', (t) => crashedSweep(t, true));

test('W1 (e): a context written before segments, evicted twice across two writes, counts once per segment', (t) => crashedSweep(t, false));

test('W1 (a), served: a served archive written by a sweep whose store write never happened counts each counter once', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-w1-served-');
  let crash = true;
  const store = hostStore({ served: overServed() }, { refuse: (key) => {
    if (key !== 'served' || !crash) return null;
    crash = false;
    return 'killed before the store write';
  } });
  const fs = { ...realFs, remove: async (path) => { if (!crash && path.includes(STORE_ARCHIVE.prefix)) throw new Error('process gone'); return realFs.remove(path); } };
  const f = await hookFixture(root, store, { fs });
  const before = await readerTotals(f, store.snapshot());
  // The turn close writes sessions first, so its sweep archives the served key and then dies; the act archives it again.
  await closeTurn(f);
  await act(f);
  assert.equal(crash, false);
  assert.ok((await copies(f, store.snapshot())).served.length > 0, 'the same counters were archived twice');
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
});

test('a served counter or a context recreated after its eviction is a new segment, summed with the archived one', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-new-seg-');
  const identity = await identityIn(root);
  const served = hostStore({ served: overServed(true) });
  const f = await hookFixture(root, served);
  const before = await readerTotals(f, served.snapshot());
  await closeTurn(f);
  assert.equal(served.map.get('served')['sample.md'], undefined, 'the rule\'s counter moved out');
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  assert.deepEqual(await readerTotals(f, served.snapshot()), plus(before, delta));
  const root2 = await sandbox(t, 'rod-new-seg-ctx-');
  const sessions = hostStore(overSessions(identity, false));
  const g = await hookFixture(root2, sessions);
  const start = await readerTotals(g, sessions.snapshot());
  await act(g);
  assert.equal(sessions.map.get('sessions')['sample-session'].contexts['agent:a0'], undefined, 'the oldest agent context moved out');
  await g.call({ command: 'git push origin main', agentId: 'a0' });
  assert.deepEqual(failures(g.logs), []);
  assert.deepEqual(await readerTotals(g, sessions.snapshot()), plus(start, delta, 2));
});

test('W2 (b): a store write that commits then rejects keeps the archive it wrote, so nothing is lost', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-w2-');
  const store = hostStore(overSessions(await identityIn(root), true));
  const set = store.api.set;
  let ambiguous = true;
  store.api.set = async (key, value) => {
    await set(key, value);
    if (key === 'sessions' && ambiguous) { ambiguous = false; throw new Error('connection reset after the write'); }
  };
  const f = await hookFixture(root, store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.equal(ambiguous, false);
  assert.match(f.logs.join('\n'), /store sweep failed: connection reset/);
  assert.ok((await readArchives(f.quality)).length >= 1, 'the archive stays');
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
});

test('W3 (c): two writers evicting the same segments from one stored value are counted once', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-w3-');
  const store = hostStore(overSessions(await identityIn(root), true));
  // Both writers read the same sessions value before either writes it; writer A reads it again only after both wrote.
  const get = store.api.get;
  let reads = 0, sessionWrites = 0, release, bothWrote;
  const barrier = new Promise((resolve) => { release = resolve; });
  const written = new Promise((resolve) => { bothWrote = resolve; });
  store.api.get = async (key) => {
    if (key === 'sessions') {
      reads++;
      if (reads <= 2) { const value = await get(key); if (reads === 2) release(); await barrier; return value; }
      if (reads === 3) await written;
    }
    return get(key);
  };
  const set = store.api.set;
  store.api.set = async (key, value) => { await set(key, value); if (key === 'sessions' && ++sessionWrites === 2) bothWrote(); };
  const hooksB = await import(`../hooks/hooks.js?writer=b-${Date.now()}`);
  const a = await hookFixture(root, store, { sessionId: 'writer-a' });
  const before = await readerTotals(a, store.snapshot());
  const b = await hookFixture(root, store, { sessionId: 'writer-b', hooks: hooksB });
  await Promise.all([act(a), closeTurn(b)]);
  assert.deepEqual(failures([...a.logs, ...b.logs]), []);
  assert.ok((await copies(a, store.snapshot())).contexts.length > 0, 'both writers archived the same segments');
  const names = (await readdir(a.quality)).filter((name) => name.startsWith(STORE_ARCHIVE.prefix));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(await readerTotals(a, store.snapshot()), plus(before, delta));
});

test('W4 (d): store-key archives are never removed by retention, past 49 MB on disk', async (t) => {
  const root = await sandbox(t, 'rod-w4-');
  const store = hostStore(overSessions(await identityIn(root), true));
  const f0 = await hookFixture(root, store);
  await mkdir(f0.quality, { recursive: true });
  const dummies = Array.from({ length: 20 }, (_, i) => `${STORE_ARCHIVE.prefix}${1000 + i}-${i}${STORE_ARCHIVE.suffix}`);
  for (const [i, name] of dummies.entries()) {
    await writeFile(join(f0.quality, name), JSON.stringify({ format: 1, key: 'served', archivedAt: '2026-01-01', value: { [`dummy-${i}.md`]: { count: 1, last: '2026-01-01', seg: `dummy-${i}` } } }));
  }
  // The listing reports each archive at 3 MB: 20 of them are 60 MB, past the 49 MB verdict retention.
  const fs = { ...realFs, list: async (path) => (await realFs.list(path)).map((entry) => ({ ...entry, size: entry.name.startsWith(STORE_ARCHIVE.prefix) ? 3_000_000 : entry.size })) };
  const f = await hookFixture(root, store, { fs });
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  const left = await readdir(f.quality);
  assert.deepEqual(dummies.filter((name) => !left.includes(name)), [], 'no store-key archive was removed');
  assert.ok(left.filter((name) => name.startsWith(STORE_ARCHIVE.prefix)).length > dummies.length, 'this act archived');
});
