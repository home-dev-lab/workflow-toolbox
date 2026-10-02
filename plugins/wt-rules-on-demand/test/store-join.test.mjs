// Round-3 locks: copies of one store segment are JOINED, never chosen between (J1), mirrors go through the same join
// (J2), readers read the store before listing archives (J3), unreadable archives are skipped and named (J4), archive
// parts respect the host file limit (J5), a failing archive cannot feed health flushes without end (J6), and archive
// names and segment ids stay distinct between module instances under one pid (J7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostStore, hookFixture, atLimitStore, readerTotals, realFs, HOST_FILE_LIMIT } from './store-host-fake.mjs';
import { STORE_BUDGETS, STORE_ARCHIVE, ARCHIVE_PART_BYTES, archiveTexts, jsonLength } from '../hooks/store-budget.js';
import { sumSessions, sumServed, mergeSessions, archivedSegments } from '../scripts/delivery-join.mjs';
import { withArchivedSessions } from '../scripts/store-archives.mjs';

const failures = (logs) => logs.filter((line) => /write failed|sweep failed/.test(line));
const minus = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
const plus = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + b[key]]));
const act = (f, agentId) => f.call({ command: 'git push origin main', ...(agentId ? { agentId } : {}) });
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const at = (s) => `2026-10-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const permutations = (items) => (items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));

async function sandbox(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
let measuredDelta = null;
async function actDelta(t) {
  if (measuredDelta) return measuredDelta;
  const store = hostStore();
  const f = await hookFixture(await sandbox(t, 'rod-join-delta-'), store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  measuredDelta = minus(await readerTotals(f, store.snapshot()), before);
  return measuredDelta;
}

// J1 -------------------------------------------------------------------------------------------------------------------

// Snapshots of ONE writer's history of one segment: counters only grow, rows are appended, and the trigger-error
// history keeps its newest `cap` rows (the hook's cap), so a later snapshot can hold fewer rows than an earlier one.
function history(steps, cap = 3) {
  const snapshots = [];
  let ctx = { seg: 'one', served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [], triggerErrors: [] };
  for (let i = 1; i <= steps; i++) {
    ctx = structuredClone(ctx);
    ctx.last = at(i);
    ctx.served.r = (ctx.served.r ?? 0) + 1;
    if (i % 2) ctx.suppressedCap.q = (ctx.suppressedCap.q ?? 0) + 1;
    const act = ctx.governedActs[0];
    if (act) { act.count++; act.last = at(i); } else ctx.governedActs.push({ rule: 'r', ruleIdentity: 'id:r', at: at(i), last: at(i), count: 1 });
    ctx.complianceInjected.push({ rule: 'r', deliveryId: `d${i}`, at: at(i) });
    ctx.triggerErrors = [...ctx.triggerErrors, { error: `E${i}`, at: at(i) }].slice(-cap);
    ctx.lastClose = { token: 't', seq: i, at: at(i) };
    snapshots.push(ctx);
  }
  return snapshots;
}
const asSessions = (ctx, key = '0') => ({ s: { first: at(0), last: ctx.last, contexts: { [key]: ctx } } });

test('J1: copies of one segment join to the same result in every order, number and repetition', () => {
  const [s1, s2, s3, s4, s5] = history(5);
  const other = { seg: 'two', last: at(30), served: { r: 7 }, complianceInjected: [{ rule: 'r', deliveryId: 'z', at: at(30) }], governedActs: [], suppressedCap: {} };
  const results = new Set();
  for (const order of permutations([asSessions(s2), asSessions(s5), asSessions(s3)])) {
    for (const [withOther, inputs] of [[false, order], [false, [...order, order[0]]], [true, [...order, asSessions(other)]], [true, [asSessions(other), ...order, order[1]]]]) {
      const ctx = sumSessions(inputs).s.contexts[0];
      assert.equal(ctx.served.r, 5 + (withOther ? 7 : 0), 'the newest snapshot\'s counter, plus the distinct segment');
      assert.deepEqual(ctx.complianceInjected.map((row) => row.deliveryId).filter((id) => id !== 'z'), ['d1', 'd2', 'd3', 'd4', 'd5']);
      assert.deepEqual(ctx.triggerErrors.map((row) => row.error), ['E1', 'E2', 'E3', 'E4', 'E5'], 'rows each copy capped away are kept');
      assert.equal(ctx.governedActs.find((item) => item.ruleIdentity === 'id:r').count, 5);
      assert.equal(ctx.lastClose.seq, 5);
      if (!withOther) results.add(JSON.stringify(ctx));
    }
  }
  assert.equal(results.size, 1, 'one result whatever the order of the copies');
  assert.deepEqual(sumSessions([asSessions(s4)]).s.contexts[0], s4, 'a single copy is itself');
  assert.deepEqual(sumSessions([asSessions(s1), asSessions(s1)]).s.contexts[0].served, s1.served, 'a copy joined with itself is itself');
  const served = [1, 2, 3].map((count) => ({ r: { count, last: at(count), byChannel: { 'tool.call': count }, seg: 'x' } }));
  for (const order of permutations(served)) assert.deepEqual(sumServed(order).r, { count: 3, last: at(3), byChannel: { 'tool.call': 3 }, seg: 'x' });
});

test('J1: mirror A, current B and archive A keep both deliveries', () => {
  const ctx = (seg, last, id) => ({ seg, last, served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [{ rule: 'r', deliveryId: id, at: last }] });
  const current = asSessions(ctx('B', at(3), 'd2')), mirror = asSessions(ctx('A', at(1), 'd1')), archive = asSessions(ctx('A', at(2), 'd1'));
  for (const order of permutations([current, mirror, archive])) {
    assert.deepEqual(sumSessions(order).s.contexts[0].complianceInjected.map((row) => row.deliveryId).sort(), ['d1', 'd2']);
  }
  for (const stores of [[{ sessions: current }, { sessions: mirror }], [{ sessions: mirror }, { sessions: current }]]) {
    assert.deepEqual(sumSessions([archive, mergeSessions(stores)]).s.contexts[0].complianceInjected.map((row) => row.deliveryId).sort(), ['d1', 'd2']);
  }
});

test('J1: a capped trigger-error history keeps all 101 distinct errors across its copies', () => {
  const errors = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ error: `E${from + i}`, at: at(1) }));
  const archived = asSessions({ seg: 'A', last: at(1), triggerErrors: errors(0, 99) });
  const live = asSessions({ seg: 'A', last: at(2), triggerErrors: errors(1, 100) });
  for (const order of [[archived, live], [live, archived]]) assert.equal(sumSessions(order).s.contexts[0].triggerErrors.length, 101);
});

test('J1: a legacy served counter tied on its timestamp, or continued under a clock that went back, counts its newest value', () => {
  const tie = [{ r: { count: 1, byChannel: { 'tool.call': 1 }, last: at(5), seg: 'legacy:served:r' } }, { r: { count: 2, byChannel: { 'tool.call': 2 }, last: at(5) } }];
  const rollback = [{ r: { count: 1, last: at(1), seg: 'x' } }, { r: { count: 2, last: at(0), seg: 'x' } }];
  for (const order of [tie, [...tie].reverse()]) assert.equal(sumServed(order).r.count, 2);
  for (const order of [rollback, [...rollback].reverse()]) assert.equal(sumServed(order).r.count, 2);
  const context = (served, last) => asSessions({ seg: 'x', last, served: { r: served } });
  for (const order of [[context(1, at(1)), context(2, at(0))], [context(2, at(0)), context(1, at(1))]]) assert.equal(sumSessions(order).s.contexts[0].served.r, 2);
});

test('known limit: concurrent increments of one counter from the same base lose one under max', () => {
  // Two writers each read the same copy of a segment (count 5) and add one: the true value is 7, the join keeps 6. This
  // is the pre-existing cross-process lost update (read-modify-write on one store key), left to the
  // append-only journal follow-up and NOT fixed here; the join's precondition is that copies of a segment come from one writer.
  const base = 5;
  const a = { r: { count: base + 1, last: at(1), seg: 'x' } }, b = { r: { count: base + 1, last: at(2), seg: 'x' } };
  assert.equal(sumServed([a, b]).r.count, base + 1);
});

// J2-J4: the reader processes ------------------------------------------------------------------------------------------

const delivery = (identity, n, last) => ({ rule: 'sample.md', ruleIdentity: identity, at: last, deliveryId: `tok-${n}`, deliverySeq: n, servingSeq: n });
const context = (identity, seg, last, ids, extra = {}) => ({ seg, last, served: { 'sample.md': ids.length }, suppressedCap: {}, servedIdentity: { [identity]: ids.length },
  governedActs: [{ rule: 'sample.md', ruleIdentity: identity, at: last, last, count: ids.length }], complianceInjected: ids.map((n) => delivery(identity, n, last)), ...extra });

// A config dir whose store holds a main context and an agent context, plus an archive of an older agent segment.
async function readerConfig(t, prefix) {
  const f = await hookFixture(await sandbox(t, prefix), hostStore());
  const now = at(10);
  const store = { sessions: { s: { first: at(0), last: now, contexts: {
    0: context(f.identity, 'main', now, [1, 2, 3]),
    'agent:x': context(f.identity, 'x1', now, [4, 5, 6], { triggerErrors: [{ rule: 'sample.md', error: 'e1', at: now }, { rule: 'sample.md', error: 'e2', at: now }] }),
  } } }, served: { 'sample.md': { count: 6, last: now, byChannel: { 'tool.call': 6 }, seg: 'served' } }, 'compliance-verdicts-jsonl': '' };
  const storePath = join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  await mkdir(dirname(storePath), { recursive: true });
  await mkdir(f.quality, { recursive: true });
  await writeFile(join(f.quality, `${STORE_ARCHIVE.prefix}1000-1${STORE_ARCHIVE.suffix}`), JSON.stringify({ format: 2, key: 'sessions', archivedAt: at(5),
    value: [{ sessionId: 's', first: at(0), last: at(5), key: 'agent:x', context: context(f.identity, 'x0', at(5), [7]) }] }));
  const reset = async () => {
    await writeFile(storePath, JSON.stringify(store));
    for (const name of await readdir(f.quality)) if (name.includes('-9999-')) await rm(join(f.quality, name));
  };
  await reset();
  return { ...f, store, storePath, reset };
}

// Every reader over the config dir, each a fresh process over freshly reset inputs; `env` reaches each process.
async function readerCounts(f, env = {}) {
  const base = { ...process.env, CLAUDE_CONFIG_DIR: f.config, HOME: dirname(f.config), CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '', ...env };
  const run = async (args) => {
    await f.reset();
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: base, cwd: f.project, maxBuffer: 1 << 26 });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    return { json: JSON.parse(result.stdout), stderr: result.stderr };
  };
  const report = await run([script('compliance-report.mjs'), '--config-dir', f.config, '--rules-dir', join(f.config, 'rules-on-demand'), '--json']);
  const reconcile = await run([script('serve-verdict-reconcile.mjs'), '--config-dir', f.config, '--json']);
  const rollback = await run([script('rollback-check.mjs'), '--user', '--config-dir', f.config, '--dry-run', '--json']);
  const quality = await run(['--input-type=module', '-e', `import { measureInputs } from ${JSON.stringify(pathToFileURL(script('quality-check.mjs')).href)};
    const inputs = await measureInputs([${JSON.stringify(f.config)}], [], ${JSON.stringify(join(f.config, 'measures'))});
    const contexts = Object.values(inputs.store.profiles[0].sessions).flatMap((session) => Object.values(session.contexts ?? {}));
    console.log(JSON.stringify({ deliveries: contexts.reduce((n, ctx) => n + (ctx.complianceInjected?.length ?? 0), 0),
      triggerErrors: contexts.reduce((n, ctx) => n + (ctx.triggerErrors?.length ?? 0), 0), unreadableArchives: inputs.store.unreadableArchives }));`]);
  const row = report.json['sample.md'] ?? {};
  return {
    counts: { served: row.served ?? 0, unjudged: row.unjudged ?? 0, serves: reconcile.json.result.serves, qualityDeliveries: quality.json.deliveries,
      triggerErrors: quality.json.triggerErrors, governed: rollback.json[0]?.applicable ?? 0 },
    unreadable: { report: report.json.unreadableArchives, reconcile: reconcile.json.unreadableArchives, rollback: rollback.json[0]?.unreadableArchives, quality: quality.json.unreadableArchives },
    stderr: [report.stderr, reconcile.stderr, rollback.stderr, quality.stderr],
  };
}

test('J2: every reader counts the same deliveries for the same store and archives', async (t) => {
  const f = await readerConfig(t, 'rod-j2-');
  const { counts } = await readerCounts(f);
  assert.equal(counts.serves, 7, 'six live deliveries and one archived');
  assert.equal(counts.qualityDeliveries, 7);
  assert.equal(counts.unjudged, 7);
});

test('J2: mirror stores are segment sources of the same join: their distinct segments are summed, their copies joined', () => {
  const ctx = (seg, last, error) => ({ seg, last, served: { r: 1 }, triggerErrors: [{ error, at: at(0) }], complianceInjected: [], governedActs: [], suppressedCap: {} });
  const current = asSessions(ctx('B', at(3), 'eB')), mirror = asSessions(ctx('A', at(1), 'eA'));
  const archive = { key: 'sessions', value: [{ sessionId: 's', first: at(0), last: at(2), key: '0', context: ctx('A', at(2), 'eA') }] };
  for (const stores of [[current, mirror], [mirror, current]]) {
    const joined = withArchivedSessions([archive], ...stores).s.contexts[0];
    assert.equal(joined.served.r, 2, 'segment A once (mirror and archive) plus segment B');
    assert.deepEqual(joined.triggerErrors.map((row) => row.error).sort(), ['eA', 'eB']);
  }
});

test('J2: serve-verdict-reconcile joins mirror stores and archives per segment: a delivery in the current store survives a stale mirror', async (t) => {
  const f = await readerConfig(t, 'rod-j2-mirror-');
  const current = { sessions: { s: { first: at(0), last: at(3), contexts: { 0: context(f.identity, 'B', at(3), [2]) } } } };
  const mirror = { sessions: { s: { first: at(0), last: at(1), contexts: { 0: context(f.identity, 'A', at(1), [1]) } } } };
  const archives = join(f.config, 'mirror-archives');
  await mkdir(archives, { recursive: true });
  await writeFile(join(archives, `${STORE_ARCHIVE.prefix}1-1${STORE_ARCHIVE.suffix}`), JSON.stringify({ format: 2, key: 'sessions', archivedAt: at(2),
    value: [{ sessionId: 's', first: at(0), last: at(2), key: '0', context: context(f.identity, 'A', at(2), [1]) }] }));
  const paths = [join(f.config, 'current.json'), join(f.config, 'mirror.json')];
  await writeFile(paths[0], JSON.stringify(current));
  await writeFile(paths[1], JSON.stringify(mirror));
  for (const order of [paths, [...paths].reverse()]) {
    const run = spawnSync(process.execPath, [script('serve-verdict-reconcile.mjs'), ...order.flatMap((path) => ['--store', path]), '--archives', archives, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).result.serves, 2, 'd1 from mirror and archive (one segment), d2 from the current store');
  }
});

test('J3: an eviction between a reader\'s store read and its archive listing changes no count', async (t) => {
  const f = await readerConfig(t, 'rod-j3-');
  const before = await readerCounts(f);
  const plan = { storePath: f.storePath, quality: f.quality, name: `${STORE_ARCHIVE.prefix}9999-1${STORE_ARCHIVE.suffix}`, sessionId: 's', key: 'agent:x' };
  const preload = fileURLToPath(new URL('./fixtures/evict-between-reads.mjs', import.meta.url));
  for (const moment of ['before-store-read', 'after-first-listing']) {
    const raced = await readerCounts(f, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ROD_EVICT_BETWEEN_READS: JSON.stringify({ ...plan, moment }) });
    assert.deepEqual(raced.counts, before.counts, `eviction ${moment}`);
  }
});

test('J4: a truncated archive is skipped and named by every reader, never fatal, and the counts stay those of the store', async (t) => {
  const f = await readerConfig(t, 'rod-j4-');
  const before = await readerCounts(f);
  const archive = await readFile(join(f.quality, `${STORE_ARCHIVE.prefix}1000-1${STORE_ARCHIVE.suffix}`), 'utf8');
  const brokenStore = join(f.quality, `${STORE_ARCHIVE.prefix}2000-1${STORE_ARCHIVE.suffix}`);
  const brokenVerdicts = join(f.quality, 'compliance-verdicts-archive-2000-1.jsonl');
  await writeFile(brokenStore, archive.slice(0, Math.floor(archive.length / 2)));
  await writeFile(brokenVerdicts, '{"verdictId":"cut-1","rule":"sample.md"}\n{"verdictId":"cut-');
  const after = await readerCounts(f);
  assert.deepEqual(after.counts, before.counts);
  const paths = (list) => (list ?? []).map((item) => item.path).sort();
  assert.deepEqual(paths(after.unreadable.report), [brokenVerdicts, brokenStore].sort());
  assert.deepEqual(paths(after.unreadable.reconcile), [brokenVerdicts, brokenStore].sort());
  assert.deepEqual(paths(after.unreadable.rollback), [brokenVerdicts, brokenStore].sort());
  assert.deepEqual(paths(after.unreadable.quality), [brokenStore]);
  for (const stderr of after.stderr) assert.match(stderr, new RegExp(`skipped unreadable archive ${brokenStore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

// J5 -------------------------------------------------------------------------------------------------------------------

test('J5: one context larger than an archive part is split into parts of one segment, each under the host file limit', async (t) => {
  const pure = Array.from({ length: 4200 }, (_, i) => ({ rule: `règle-界-${'界'.repeat(300)}-${i}.md`, deliveryId: `u-${i}`, at: at(1) }));
  const parts = archiveTexts('sessions', [{ sessionId: 's', first: at(0), last: at(1), key: 'agent:big', context: { seg: 'big', last: at(1), served: { r: 4200 }, complianceInjected: pure } }]);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(Buffer.byteLength(part) <= ARCHIVE_PART_BYTES, `${Buffer.byteLength(part)} bytes`);
  const joined = sumSessions(archivedSegments(parts.map((part) => JSON.parse(part)), 'sessions')).s.contexts['agent:big'];
  assert.equal(joined.complianceInjected.length, 4200);
  assert.equal(joined.served.r, 4200, 'the counters are read once, not once per part');

  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-j5-');
  const identity = (await hookFixture(root, hostStore())).identity;
  const big = atLimitStore(identity, { verdictChars: 10, sessionChars: 600_000, segs: true });
  const old = '2026-01-01T00:00:00.000Z';
  big.sessions['sample-session'].contexts['agent:big'] = { seg: 'big', last: old, served: { 'sample.md': 1 }, suppressedCap: {}, governedActs: [],
    complianceInjected: Array.from({ length: 4200 }, (_, i) => ({ rule: 'sample.md', ruleIdentity: identity, at: old, deliveryId: `big-${i}`, deliverySeq: i, servingSeq: i, note: '界'.repeat(300) })) };
  assert.ok(jsonLength(big.sessions) > STORE_BUDGETS.sessions);
  assert.ok(Buffer.byteLength(JSON.stringify(big.sessions['sample-session'].contexts['agent:big'])) > HOST_FILE_LIMIT, 'the context alone is over 4 MiB of UTF-8');
  const store = hostStore(big);
  const f = await hookFixture(root, store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  const names = (await readdir(f.quality)).filter((name) => name.startsWith(STORE_ARCHIVE.prefix));
  assert.ok(names.length >= 2);
  for (const name of names) assert.ok((await stat(join(f.quality, name))).size <= ARCHIVE_PART_BYTES, name);
  assert.deepEqual(await readerTotals(f, store.snapshot()), plus(before, delta));
});

// J6 -------------------------------------------------------------------------------------------------------------------

test('J6: archives that fail forever on a full store cost one act a small bounded number of store and archive attempts', async (t) => {
  const root = await sandbox(t, 'rod-j6-');
  const store = hostStore(atLimitStore((await hookFixture(root, hostStore())).identity));
  const set = store.api.set;
  let sets = 0, writes = 0;
  store.api.set = async (key, value) => { sets++; return set(key, value); };
  // The disk refuses every archive; past 300 attempts it gives in, so a feedback loop shows as a large count, not a hang.
  const fs = { ...realFs, write: async (path, text) => {
    if (path.includes('archive')) { writes++; if (writes <= 300) throw new Error('disk full'); }
    return realFs.write(path, text);
  } };
  const f = await hookFixture(root, store, { fs });
  await act(f);
  let previous = -1;
  for (let round = 0; round < 50 && sets + writes !== previous; round++) { previous = sets + writes; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.ok(sets <= 40 && writes <= 12, `one act: ${sets} store writes and ${writes} archive writes`);
});

// J7 -------------------------------------------------------------------------------------------------------------------

test('J7: two module instances under one pid, at one clock reading, write distinct archive names and segment ids', async (t) => {
  const root = await sandbox(t, 'rod-j7-');
  const identity = (await hookFixture(root, hostStore())).identity;
  const random = Math.random, now = Date.now;
  const load = async (value, tag) => {
    Math.random = () => value;
    try { return await import(`../hooks/hooks.js?j7=${tag}-${process.hrtime.bigint()}`); } finally { Math.random = random; }
  };
  // Two draws a hair apart: a 1,000-bucket owner cannot tell them apart, 43 random bits can.
  const a = await load(0.5, 'a'), b = await load(0.5 + 2 ** -40, 'b');
  let written = 0;
  // Both writers check a name before either writes it (exists answers false), the race the name must survive alone.
  const fs = { ...realFs, exists: async () => false, write: async (path, text) => { if (path.includes(STORE_ARCHIVE.prefix)) written++; return realFs.write(path, text); } };
  const stores = [hostStore(atLimitStore(identity, { verdictChars: 10, sessionChars: STORE_BUDGETS.sessions + 40_000, segs: true })),
    hostStore(atLimitStore(identity, { verdictChars: 10, sessionChars: STORE_BUDGETS.sessions + 40_000, segs: true }))];
  const fixtures = [await hookFixture(root, stores[0], { fs, hooks: a }), await hookFixture(root, stores[1], { fs, hooks: b })];
  const instant = now();
  Date.now = () => instant;
  try {
    for (const f of fixtures) await act(f, 'fresh');
  } finally { Date.now = now; }
  for (const f of fixtures) assert.deepEqual(failures(f.logs), []);
  const names = (await readdir(fixtures[0].quality)).filter((name) => name.startsWith(STORE_ARCHIVE.prefix));
  assert.equal(names.length, written, 'no archive overwrote another');
  for (const name of names) assert.match(name, /^rod-store-archive-\d+-\d+\.json$/);
  for (const name of names) assert.ok(Number.isSafeInteger(Number(name.match(/-(\d+)\.json$/)[1])));
  const segs = stores.map((store) => store.map.get('sessions')['sample-session'].contexts['agent:fresh'].seg);
  assert.notEqual(segs[0], segs[1], 'the two new contexts are two segments');
});
