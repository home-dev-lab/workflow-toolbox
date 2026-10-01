// L4: one property over the CLASS. The real hook (journal, setWithin, eviction, split) on the host-faithful store fake
// and the real filesystem, driven through random interleavings of: deliveries and trigger errors written, a context
// grown past an archive part (so its eviction splits it), a refused store write (plain or for size) and the retry that
// follows, an archive file copied under another valid name, and the hook loading again. After each sequence, every
// id-row (deliveryId, eid) that sits in the store or in any archive, and every one a caller saw acknowledged, is present
// exactly once in the join, and the readers count the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStore, hookFixture, readerTotals, HOST_STORE_LIMIT } from './store-host-fake.mjs';
import { STORE_ARCHIVE } from '../hooks/store-budget.js';
import { readStoreArchives, withArchivedSessions } from '../scripts/store-archives.mjs';

const overBudget = '(?:[a]{1024}){4}b';
const promptRule = `---\non-demand:\n  triggers:\n    - kind: 'prompt'\n      regex: '${overBudget}'\n      before-first-act: 'false'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nBudget rule body.\n`;
const AT = '2026-10-01T10:00:00.000Z';
let reloads = 0;

function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
const rowsOf = (contexts, into = []) => {
  for (const ctx of contexts) {
    for (const row of ctx?.complianceInjected ?? []) if (row?.deliveryId) into.push([`d:${row.deliveryId}`, row]);
    for (const row of ctx?.triggerErrors ?? []) if (row?.eid != null) into.push([`e:${row.eid}`, row]);
  }
  return into;
};
const idsOf = (contexts) => rowsOf(contexts).map(([id]) => id);
const storeContexts = (sessions) => Object.values(sessions ?? {}).flatMap((session) => Object.values(session?.contexts ?? {}));

// A refusal is armed right before the write it refuses, so every one lands on a write.
const ACTIONS = ['push', 'error', 'error', 'grow', 'refuse-plain error', 'refuse-plain error', 'refuse-plain push', 'refuse-size error', 'dup', 'dup', 'reload'];

// Every step happens one second after the previous one, so two events never share a timestamp: two rows under one id
// that differ are two events, which an id must never name together.
let clock = Date.parse(AT);
async function runSequence(seed, root) {
  const random = prng(seed);
  let plan = null;
  const store = hostStore({}, { refuse: (key) => {
    if (key !== 'sessions' || !plan) return null;
    const refusal = plan === 'size' ? `the store would be ${HOST_STORE_LIMIT + 1} characters, over the ${HOST_STORE_LIMIT} limit` : 'store write refused';
    plan = null;
    return refusal;
  } });
  let f = await hookFixture(root, store);
  const rules = join(f.config, 'rules-on-demand');
  await writeFile(join(rules, 'budget.md'), promptRule);
  const acked = new Set();
  const steps = [];
  let grown = 0, copies = 0;
  for (let step = 0; step < 14; step++) {
    clock += 1000;
    const chosen = ACTIONS[Math.floor(random() * ACTIONS.length)];
    steps.push(chosen);
    for (const action of chosen.split(' ')) {
    if (action === 'push' || action === 'error') {
      const before = f.logs.length;
      if (action === 'push') await f.call({ command: 'git push origin main' });
      else await f.handlers.get('prompt.submit')(f.$, { text: 'a'.repeat(16000), cwd: f.project }, async () => ({}));
      // Acknowledged: the call's journal reported no failed write; what the store holds then was seen by the caller.
      if (!f.logs.slice(before).some((line) => /write failed/.test(line))) for (const id of idsOf(storeContexts(store.map.get('sessions')))) acked.add(id);
    } else if (action === 'grow') {
      // The current context gains rows of multibyte text: under the sessions budget in characters, over one archive part
      // in bytes, so the write that evicts it splits it.
      const sessions = store.map.get('sessions') ?? { 'sample-session': { first: AT, last: AT, contexts: {} } };
      const ctx = sessions['sample-session'].contexts[0] ??= { served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [], seg: `grown-${seed}` };
      for (let i = 0; i < 2100; i++) ctx.complianceInjected.push({ rule: 'sample.md', at: AT, deliveryId: `pre-${seed}-${grown++}`, pad: '界'.repeat(1000) });
      store.map.set('sessions', sessions);
    } else if (action === 'refuse-plain') plan = 'plain';
    else if (action === 'refuse-size') plan = 'size';
    else if (action === 'dup') {
      const names = (await readdir(f.quality).catch(() => [])).filter((name) => name.startsWith(STORE_ARCHIVE.prefix));
      if (names.length) {
        const name = names[Math.floor(random() * names.length)];
        await copyFile(join(f.quality, name), join(f.quality, `${STORE_ARCHIVE.prefix}${9_000_000 + copies++}-1${STORE_ARCHIVE.suffix}`));
      }
    } else if (action === 'reload') {
      const hooks = await import(`../hooks/hooks.js?class=${++reloads}`);
      const logs = f.logs;
      f = await hookFixture(root, store, { hooks });
      f.logs.unshift(...logs);
    }
    }
  }
  return { f, store, acked, steps };
}

test('L4: every stamped id-row is present exactly once in every reader, across rollbacks, splits, copies and reloads', async (t) => {
  for (let seed = 1; seed <= 8; seed++) {
    const root = await mkdtemp(join(tmpdir(), `rod-l4-${seed}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
    let run;
    try { run = await runSequence(seed, root); } finally { globalThis.Date = RealDate; }
    const { f, store, acked, steps } = run;
    const label = `seed ${seed} (${steps.join(' ')})`;
    const files = (await readdir(f.quality).catch(() => [])).filter((name) => name.startsWith(STORE_ARCHIVE.prefix));
    const raw = [];
    for (const name of files) {
      const archive = JSON.parse(await readFile(join(f.quality, name), 'utf8'));
      if (archive.key === 'sessions') rowsOf(archive.value.map((unit) => unit.context), raw);
    }
    const live = store.snapshot().sessions ?? {};
    rowsOf(storeContexts(live), raw);
    const versions = new Map();
    for (const [id, row] of raw) versions.set(id, (versions.get(id) ?? new Set()).add(JSON.stringify(row)));
    for (const [id, rows] of versions) assert.equal(rows.size, 1, `${label}: ${id} names one event, every copy identical`);
    const everywhere = new Set(versions.keys());
    const { archives, unreadable } = await readStoreArchives(f.quality);
    assert.deepEqual(unreadable, [], `${label}: every archive readable`);
    const counts = new Map();
    for (const id of idsOf(storeContexts(withArchivedSessions(archives, live)))) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const id of everywhere) assert.equal(counts.get(id), 1, `${label}: ${id} once in the join`);
    for (const id of acked) assert.equal(counts.get(id), 1, `${label}: acknowledged ${id} once in the join`);
    const totals = await readerTotals(f, store.snapshot());
    const deliveries = [...everywhere].filter((id) => id.startsWith('d:')).length;
    const errors = [...everywhere].filter((id) => id.startsWith('e:')).length;
    assert.equal(totals.triggerErrors, errors, `${label}: the quality reader's trigger errors`);
    assert.equal(totals.deliveries, deliveries, `${label}: the reconcile reader's deliveries`);
  }
});
