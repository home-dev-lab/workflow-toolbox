// Round-4 locks. K1: the pieces of one split context are reassembled into the one context, never joined as copies of
// each other. K2: every new trigger-error row carries an event id, so identical errors stay distinct events when copies
// of their segment are joined. K4: a property over random split boundaries and orders, and the eid stamp at write time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStore, hookFixture, readerTotals } from './store-host-fake.mjs';
import { STORE_ARCHIVE, archiveTexts, splitUnit } from '../hooks/store-budget.js';
import { archivedSegments, sumSessions } from '../scripts/delivery-join.mjs';
import { readStoreArchives } from '../scripts/store-archives.mjs';

async function sandbox(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const AT = '2026-10-01T10:00:00.000Z';

// Review 3, finding 1: a context the splitter cuts with an identical pair of trigger errors on either side of a boundary.
function reviewContext() {
  return {
    seg: 'A',
    complianceInjected: Array.from({ length: 2593 }, (_, i) => ({ rule: 'r.md', ruleIdentity: `user:/${'界/'.repeat(225)}/r.md`, at: AT, deliveryId: `t-${i}`, deliverySeq: i, servingSeq: i })),
    triggerErrors: Array.from({ length: 100 }, (_, i) => ({ rule: 'r.md', kind: 'bash', pattern: `[${'界'.repeat(1000)}]`, length: 8,
      error: 'shared regex call budget exhausted; trigger unevaluated', at: new Date(Date.parse(AT) + Math.min(i, 98)).toISOString(), channel: 'tool.call' })),
  };
}
const errorsOf = (sessions) => sessions.s.contexts[0].triggerErrors.length;

test('K1: an identical pair of rows on either side of a split boundary is two rows (review 3, finding 1)', () => {
  const context = reviewContext();
  const archives = archiveTexts('sessions', [{ sessionId: 's', key: '0', context }], AT).map((text) => JSON.parse(text));
  assert.ok(archives.length >= 2, 'the context is split');
  for (const order of [archives, [...archives].reverse()]) assert.equal(errorsOf(sumSessions(archivedSegments(order, 'sessions'))), 100);
  // The live store still holds the same segment (its store write never landed): one copy against the reassembled one.
  const live = { s: { contexts: { 0: context } } };
  for (const order of [archives, [...archives].reverse()]) {
    const joined = sumSessions([...archivedSegments(order, 'sessions'), live]).s.contexts[0];
    assert.equal(joined.triggerErrors.length, 100, 'not doubled against the live copy');
    assert.equal(joined.complianceInjected.length, 2593);
  }
});

test('K1: a split whose piece is unreadable is read from the pieces present as one copy, and named', async (t) => {
  const dir = await sandbox(t, 'rod-k1-');
  const context = reviewContext();
  const texts = archiveTexts('sessions', [{ sessionId: 's', key: '0', context }], AT);
  const paths = texts.map((_, i) => join(dir, `${STORE_ARCHIVE.prefix}${1000 + i}-1${STORE_ARCHIVE.suffix}`));
  await mkdir(dir, { recursive: true });
  for (const [i, text] of texts.entries()) await writeFile(paths[i], i === texts.length - 1 ? text.slice(0, 100) : text);
  const { archives, unreadable } = await readStoreArchives(dir);
  const split = JSON.parse(texts[0]).value.find((unit) => unit.split).split.id;
  assert.deepEqual(unreadable.map((item) => item.split ?? item.path).sort(), [paths.at(-1), split].sort());
  const live = { s: { contexts: { 0: context } } };
  const joined = sumSessions([...archivedSegments(archives, 'sessions'), live]).s.contexts[0];
  assert.equal(joined.triggerErrors.length, 100, 'the present pieces are one copy of the live segment, not a second segment');
  assert.equal(joined.complianceInjected.length, 2593);
});

// Review 3, finding 2: the hook's 100-row cap drops the oldest error while an identical one arrives under a clock that
// went back. With event ids (as the hook now writes them) the two are two events.
test('K2: a capped history keeps a repeated error as a distinct event when its rows carry event ids (review 3, finding 2)', () => {
  const start = Date.parse(AT);
  const row = (n, ms) => ({ rule: 'r.md', kind: 'bash', pattern: 'git push', length: 8, error: 'shared regex call budget exhausted; trigger unevaluated',
    at: new Date(start + ms).toISOString(), channel: 'tool.call', eid: `A#${n}` });
  const old = Array.from({ length: 100 }, (_, i) => row(i + 1, i));
  const next = [...old, row(101, 0)].slice(-100);
  const snapshot = (triggerErrors) => ({ s: { contexts: { 0: { seg: 'A', triggerErrors } } } });
  for (const order of [[snapshot(old), snapshot(next)], [snapshot(next), snapshot(old)]]) assert.equal(errorsOf(sumSessions(order)), 101);
});

test('known limit: legacy id-less rows (written before this change) still reconcile by max copies', () => {
  // Two snapshots of one writer's capped history, each holding ONE row identical to the other's, written before rows
  // carried an event id. They may be one event or two; nothing in them tells which, so the join keeps the most any
  // single copy holds (1). Rows the hook writes now carry `eid` and are exact.
  const legacy = { rule: 'r.md', error: 'budget exhausted', at: AT };
  const snapshot = (triggerErrors) => ({ s: { contexts: { 0: { seg: 'A', triggerErrors } } } });
  assert.equal(errorsOf(sumSessions([snapshot([legacy]), snapshot([{ ...legacy }])])), 1);
});

const overBudget = '(?:[a]{1024}){4}b';
const promptRule = `---\non-demand:\n  triggers:\n    - kind: 'prompt'\n      regex: '${overBudget}'\n      before-first-act: 'false'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nBudget rule body.\n`;

test('K2/K4b: 101 trigger errors written under a clock that goes back, one snapshot evicted, read back as 101; every new row carries eid', async (t) => {
  const root = await sandbox(t, 'rod-k2-');
  const store = hostStore();
  const f = await hookFixture(root, store);
  await writeFile(join(f.config, 'rules-on-demand', 'sample.md'), promptRule);
  const RealDate = Date;
  let clock = Date.parse(AT);
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  const submit = () => f.handlers.get('prompt.submit')(f.$, { text: 'a'.repeat(16000), cwd: f.project }, async () => ({}));
  const live = () => store.map.get('sessions')['sample-session'].contexts[0];
  try {
    for (let i = 0; i < 100; i++) { clock = Date.parse(AT) + i; await submit(); }
    assert.equal(live().triggerErrors.length, 100, 'one error row per call');
    // An eviction archived this snapshot of the segment; its store write never landed, so the segment stays live too.
    await mkdir(f.quality, { recursive: true });
    await writeFile(join(f.quality, `${STORE_ARCHIVE.prefix}1-1${STORE_ARCHIVE.suffix}`), JSON.stringify({ format: 2, key: 'sessions', archivedAt: AT,
      value: [{ sessionId: 'sample-session', first: AT, last: AT, key: '0', context: structuredClone(live()) }] }));
    clock = Date.parse(AT);
    await submit();
  } finally { globalThis.Date = RealDate; }
  const rows = live().triggerErrors;
  assert.equal(rows.length, 100, 'the hook\'s 100-row cap is unchanged');
  assert.equal((await readerTotals(f, store.snapshot())).triggerErrors, 101, 'the evicted snapshot plus the live segment hold 101 events');
  assert.ok(rows.every((row) => typeof row.eid === 'string' && row.eid), 'every new row carries an event id at write time');
  assert.equal(new Set(rows.map((row) => row.eid)).size, rows.length);
});

// K4a: the splitter cut at random boundaries, its pieces fed in random orders, with and without a live copy.
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
test('K4a: reassembly plus the join loses no row and doubles none, at random split boundaries and orders', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const random = prng(seed);
    // Rows a legacy writer left identical (no eid) are spread through the history, so random boundaries fall between them.
    const legacy = { rule: 'r.md', error: 'budget exhausted', at: AT, pad: 'l'.repeat(300) };
    const context = { seg: 'S', last: AT, served: { r: 9 },
      complianceInjected: Array.from({ length: 40 }, (_, i) => ({ rule: 'r.md', deliveryId: `d${i}`, at: AT, pad: 'p'.repeat(Math.floor(random() * 200)) })),
      triggerErrors: Array.from({ length: 42 }, (_, i) => (i % 3 ? { rule: 'r.md', error: `e${i}`, at: AT, eid: `S#${i}`, pad: 'e'.repeat(Math.floor(random() * 300)) } : { ...legacy })) };
    const unit = { sessionId: 's', key: '0', context };
    const size = Buffer.byteLength(JSON.stringify(unit));
    const room = Math.floor(size / (2 + random() * 6)) + 200;
    let n = 0;
    const pieces = splitUnit(unit, room, () => `split-${seed}-${n++}`);
    assert.ok(pieces.length >= 2, `seed ${seed}: ${pieces.length} pieces`);
    for (let round = 0; round < 6; round++) {
      const order = [...pieces].sort(() => random() - 0.5);
      for (const withLive of [false, true]) {
        const segments = [...archivedSegments([{ key: 'sessions', value: order }], 'sessions'), ...(withLive ? [{ s: { contexts: { 0: context } } }] : [])];
        const joined = sumSessions(segments).s.contexts[0];
        assert.equal(joined.triggerErrors.length, 42, `seed ${seed}, live ${withLive}: trigger errors`);
        assert.equal(joined.complianceInjected.length, 40, `seed ${seed}, live ${withLive}: deliveries`);
        assert.equal(joined.served.r, 9);
      }
    }
  }
});

test('K1: a split id is never a constant: two splits of the same context get two ids', () => {
  const unit = { sessionId: 's', key: '0', context: reviewContext() };
  const ids = [archiveTexts('sessions', [unit], AT), archiveTexts('sessions', [unit], AT)]
    .map((texts) => JSON.parse(texts[0]).value.find((item) => item.split).split.id);
  assert.notEqual(ids[0], ids[1]);
});
