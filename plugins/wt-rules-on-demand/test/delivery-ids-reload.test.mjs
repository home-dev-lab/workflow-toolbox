import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hostStore, hookFixture, readerTotals, sandboxRoot } from './store-host-fake.mjs';
import { STORE_ARCHIVE, VERDICTS } from '../hooks/store-budget.js';
import { readStoreArchives, withArchivedSessions } from '../scripts/store-archives.mjs';

test('same-pid, same-millisecond reloads preserve two different deliveries and verdicts', async (t) => {
  const root = await sandboxRoot(t, 'rod-delivery-reload-');
  const RealDate = Date;
  const instant = RealDate.parse('2026-10-01T10:00:00.000Z');
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  try {
    const store = hostStore();
    const closes = [];
    let f;
    for (const [index, command] of ['git push origin main', 'git push upstream topic'].entries()) {
      const hooks = await import(`../hooks/hooks.js?delivery-reload=${index}`);
      f = await hookFixture(root, store, { hooks });
      const result = await f.call({ command });
      assert.equal(result.context?.length, 1, 'each different call actually serves one rule');
      await f.handlers.get('turn.complete')(f.$, { cwd: f.project }, async () => ({}));
      assert.deepEqual(f.logs.filter((line) => /write failed/.test(line)), []);
      closes.push(store.snapshot().sessions['sample-session'].contexts[0].lastClose);
      // A crash-window archive still present in the live store forces the real copy join.
      if (index === 0) await f.$.fs.write(join(f.quality, `${STORE_ARCHIVE.prefix}9000001-1${STORE_ARCHIVE.suffix}`),
        JSON.stringify({ format: 1, key: 'sessions', archivedAt: new Date().toISOString(), value: store.snapshot().sessions }));
    }
    const live = store.snapshot();
    const deliveries = live.sessions['sample-session'].contexts[0].complianceInjected;
    const verdicts = live[VERDICTS].trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(deliveries.length, 2, 'the unjoined journal contains both calls');
    assert.deepEqual(verdicts.map((row) => row.verdict), ['followed', 'not followed']);
    await t.test('delivery ids differ', () => {
      assert.notEqual(deliveries[0].deliveryId, deliveries[1].deliveryId, 'same-millisecond reloads issue distinct delivery ids');
    });
    await t.test('verdict ids differ', () => {
      assert.notEqual(verdicts[0].verdictId, verdicts[1].verdictId, 'same-millisecond reloads issue distinct verdict ids');
    });
    await t.test('archive join retains both deliveries', async () => {
      const { archives, unreadable } = await readStoreArchives(f.quality);
      assert.deepEqual(unreadable, []);
      const joined = withArchivedSessions(archives, live.sessions);
      assert.equal(joined['sample-session'].contexts[0].complianceInjected.length, 2, 'the archive join counts both different deliveries');
    });
    await t.test('readers count both deliveries and verdicts', async () => {
      const totals = await readerTotals(f, live);
      assert.equal(totals.deliveries, 2, 'the reconcile reader counts both different deliveries');
      assert.equal(totals.verdictRows, 2, 'the compliance reader counts both different verdicts');
      assert.equal(totals.applicable, 2);
      assert.equal(totals.followed, 1);
    });
    await t.test('close markers retain the random owner token and decimal sequence shape', () => {
      for (let index = 0; index < deliveries.length; index++) {
        const id = deliveries[index].deliveryId;
        assert.match(id, /^[0-9a-z]{11}-\d+$/);
        assert.equal(closes[index].token, id.replace(/-\d+$/, ''));
        assert.equal(verdicts[index].verdictId.replace(/-\d+$/, ''), closes[index].token);
      }
    });
  } finally { globalThis.Date = RealDate; }
});

test('the delivery token carries 52 random bits, not fewer', async (t) => {
  const root = await sandboxRoot(t, 'rod-delivery-bits-');
  const realRandom = Math.random;
  // The largest value Math.random can return at 52-bit resolution: a 52-bit draw maps it to 2^52 - 1, a narrower one cannot.
  Math.random = () => (2 ** 52 - 1) / 2 ** 52;
  try {
    const hooks = await import('../hooks/hooks.js?delivery-bits=1');
    const store = hostStore();
    const f = await hookFixture(root, store, { hooks });
    await f.call({ command: 'git push origin main' });
    const [delivery] = store.snapshot().sessions['sample-session'].contexts[0].complianceInjected;
    assert.equal(delivery.deliveryId.replace(/-\d+$/, ''), (2 ** 52 - 1).toString(36).padStart(11, '0'));
  } finally { Math.random = realRandom; }
});
