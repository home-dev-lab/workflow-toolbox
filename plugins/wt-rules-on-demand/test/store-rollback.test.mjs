// Round-5 locks. L1: no row identity, and no counter, is rebuilt from a store value that a refused write rolled back after
// its archive was written. L2: reassembly treats a repeated piece as a copy of that piece, never as more rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStore, hookFixture, readerTotals } from './store-host-fake.mjs';
import { emptyContext, splitUnit } from '../hooks/store-budget.js';
import { archivedSegments, reassembleSplits, sumSessions } from '../scripts/delivery-join.mjs';
import { readStoreArchives, withArchivedSessions } from '../scripts/store-archives.mjs';

async function sandbox(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const AT = '2026-10-01T10:00:00.000Z';
const overBudget = '(?:[a]{1024}){4}b';
const promptRule = `---\non-demand:\n  triggers:\n    - kind: 'prompt'\n      regex: '${overBudget}'\n      before-first-act: 'false'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nBudget rule body.\n`;
// The current context alone is over the sessions budget, so the next write archives it and restarts it empty.
const paddedStore = (context = {}) => ({ sessions: { 'sample-session': { first: AT, last: AT, contexts: {
  0: { ...emptyContext(), seg: 'A', last: AT, pad: 'x'.repeat(2_000_000), ...context } } } } });
// Refuse the listed writes of one key (1 = its first write), plainly: not a size refusal, so nothing retries it.
const refuseWrites = (name, ...which) => { let n = 0; return (key) => (key === name && which.includes(++n) ? 'store write refused' : null); };
let reloads = 0;
const freshHooks = () => import(`../hooks/hooks.js?reload=${++reloads}`);

test('L1: two errors around a refused write and a hook reload are two events (review 4, finding 1)', async (t) => {
  const root = await sandbox(t, 'rod-l1-');
  const store = hostStore(paddedStore(), { refuse: refuseWrites('sessions', 1, 2, 3) });
  const submit = async (f) => {
    await writeFile(join(f.config, 'rules-on-demand', 'sample.md'), promptRule);
    await f.handlers.get('prompt.submit')(f.$, { text: 'a'.repeat(16000), cwd: f.project }, async () => ({}));
  };
  const first = await hookFixture(root, store);
  await submit(first);
  assert.ok(first.logs.some((line) => /journal write failed: store write refused/.test(line)), 'the first write was refused after its archive');
  // The hook loads again (a new process): nothing it held in memory survives, only the rolled-back store and the archive.
  const second = await hookFixture(root, store, { hooks: await freshHooks() });
  await submit(second);
  assert.equal((await readerTotals(second, store.snapshot())).triggerErrors, 2, 'the archived error and the next one are two events');
});

test('L1: a counter advanced by a write refused after its archive is not counted again from the rolled-back value', async (t) => {
  const root = await sandbox(t, 'rod-l1c-');
  const f = await hookFixture(root, hostStore());
  const store = hostStore(paddedStore({ governedActs: [{ rule: 'sample.md', ruleIdentity: f.identity, at: AT, last: AT, count: 5 }] }), { refuse: refuseWrites('sessions', 2) });
  f.$.store = store.api;
  await f.call({ command: 'git push origin main' });
  assert.ok(f.logs.some((line) => /journal write failed: store write refused/.test(line)), 'the first write was refused after its archive');
  await f.call({ command: 'git push origin main' });
  const { archives } = await readStoreArchives(f.quality);
  const sessions = withArchivedSessions(archives, store.snapshot().sessions);
  const acts = Object.values(sessions['sample-session'].contexts).flatMap((ctx) => ctx.governedActs ?? []).reduce((n, act) => n + act.count, 0);
  assert.equal(acts, 7, 'five stored acts plus two calls');
});

// Review 4, finding 2: every piece of a split archived twice (an archive file copied under another valid name).
function f2Pieces() {
  const context = { seg: 'A', complianceInjected: [{ deliveryId: 'd1', rule: 'r.md', ruleIdentity: 'x'.repeat(400) }],
    triggerErrors: [{ eid: 'A#1', rule: 'r.md', error: 'x'.repeat(400) }] };
  return splitUnit({ sessionId: 's', key: '0', context }, 500, () => 'split-1');
}
test('L2: a split whose pieces are all read twice is one context (review 4, finding 2)', () => {
  const pieces = f2Pieces();
  assert.ok(pieces.length >= 2, 'the context is split');
  const archive = { key: 'sessions', value: pieces };
  const joined = withArchivedSessions([archive, structuredClone(archive)], {}).s.contexts[0];
  assert.deepEqual([joined.complianceInjected.length, joined.triggerErrors.length], [1, 1]);
  assert.deepEqual(reassembleSplits([...pieces, ...pieces]).incomplete, []);
});

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const totals = (sessions) => {
  const ctx = sessions.s.contexts[0];
  return { deliveries: ctx.complianceInjected.length, errors: ctx.triggerErrors.length, served: ctx.served.r, acts: ctx.governedActs.reduce((n, act) => n + act.count, 0) };
};
test('L2: every piece repeated 1 to 3 times, in random order, totals as one copy of each piece', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const random = prng(seed);
    const legacy = { rule: 'r.md', error: 'budget exhausted', at: AT, pad: 'l'.repeat(300) };
    const context = { seg: 'S', last: AT, served: { r: 9 }, governedActs: [{ rule: 'r.md', ruleIdentity: 'u:r.md', at: AT, last: AT, count: 4 }],
      complianceInjected: Array.from({ length: 30 }, (_, i) => ({ rule: 'r.md', deliveryId: `d${i}`, at: AT, pad: 'p'.repeat(Math.floor(random() * 200)) })),
      triggerErrors: Array.from({ length: 30 }, (_, i) => (i % 3 ? { rule: 'r.md', error: `e${i}`, at: AT, eid: `S-${i}`, pad: 'e'.repeat(Math.floor(random() * 300)) } : { ...legacy })) };
    const unit = { sessionId: 's', key: '0', context };
    const room = Math.floor(Buffer.byteLength(JSON.stringify(unit)) / (2 + random() * 5)) + 200;
    const pieces = splitUnit(unit, room, () => `split-${seed}`);
    assert.ok(pieces.length >= 2, `seed ${seed}: ${pieces.length} pieces`);
    const once = totals(sumSessions(archivedSegments([{ key: 'sessions', value: pieces }], 'sessions')));
    assert.deepEqual(once, { deliveries: 30, errors: 30, served: 9, acts: 4 });
    for (let round = 0; round < 6; round++) {
      const repeated = pieces.flatMap((piece) => Array.from({ length: 1 + Math.floor(random() * 3) }, () => structuredClone(piece)));
      const order = repeated.map((piece) => [random(), piece]).sort((a, b) => a[0] - b[0]).map(([, piece]) => piece);
      assert.deepEqual(totals(sumSessions(archivedSegments([{ key: 'sessions', value: order }], 'sessions'))), once, `seed ${seed}, round ${round}: repeated pieces`);
    }
  }
});
