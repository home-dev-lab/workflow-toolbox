import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../scripts/delivery-join.mjs').catch(() => ({}));
const at = (n) => new Date(Date.UTC(2026, 0, 1) + n).toISOString();
const delivery = (id, seq, extra = {}) => ({ deliveryId: id, deliverySeq: seq, servingSeq: seq - 1, sessionId: 's', context: '0', rule: 'r.md', ruleIdentity: 'user:r.md', at: at(seq), ...extra });
const row = (id, seq, act, extra = {}) => ({ deliveryId: id, deliverySeq: seq, servingSeq: seq - 1, verdictId: `v-${act}`, sessionId: 's', rule: 'r.md', ruleIdentity: 'user:r.md', verdict: 'followed', actSeq: act, decidedAt: at(act ?? 100), ...extra });
const join = (rows, deliveries, options) => module.joinDeliveries(rows, deliveries, options);

test('cascading drops recompute discharges before choosing another loser', () => {
  const a = delivery('a', 1), b = delivery('b', 2);
  const r1 = row('a', 1, 20, { discharged: [b] });
  const r2 = row('a', 1, 10), r3 = row('b', 2, 30);
  for (const rows of [[r1, r2, r3], [r3, r1, r2]]) {
    const result = join(rows, [a, b]);
    assert.equal(result.rows.includes(r3), true, 'B winner survives after R1 loses its discharge');
    assert.deepEqual(new Set(result.rows), new Set([r2, r3]));
    assert.equal(result.unjudged.length, 0);
  }
});

test('session merge preserves contexts, deduplicates ids, retains legacy entries and greatest closes', () => {
  assert.equal(typeof module.mergeSessions, 'function', 'shared session merge must be exported');
  const a = delivery('a', 1), b = delivery('b', 2), legacy = { rule: 'legacy.md' };
  const stores = [
    { sessions: { s: { contexts: { 0: { complianceInjected: [a, legacy], lastClose: { token: 't', seq: 4, at: at(5) } }, 1: { lastClose: { token: 'old', seq: 100, at: at(1) } } } } } },
    { sessions: { s: { contexts: { 0: { complianceInjected: [a, b, legacy], lastClose: { token: 't', seq: 3, at: at(6) } }, 1: { lastClose: { token: 'new', seq: 1, at: at(2) } }, 'agent:x': {} } } } },
  ];
  const original = structuredClone(stores);
  for (const order of [stores, [...stores].reverse()]) {
    const merged = module.mergeSessions(order).s.contexts;
    const identified = merged[0].complianceInjected.filter((item) => item.deliveryId);
    assert.equal(identified.length, 2, 'merged journal contains exactly two id-bearing entries');
    assert.deepEqual(new Set(identified.map((item) => item.deliveryId)), new Set(['a', 'b']));
    assert.equal(merged[0].complianceInjected.filter((item) => !item.deliveryId).length, 2);
    assert.equal(merged[0].lastClose.seq, 4);
    assert.equal(merged[1].lastClose.token, 'new');
    assert.ok(merged['agent:x']);
  }
  assert.deepEqual(stores, original, 'merging does not mutate input stores');
});

const closeStore = (serve, lastClose) => ({ sessions: { s: { contexts: { 0: { complianceInjected: [serve], lastClose } } } } });

test('equal-time close markers settle the delivery in both store orders', () => {
  const serve = delivery('t-10', 10, { at: at(20) });
  const stores = [
    closeStore(serve, { token: 't', seq: 20, at: at(20) }),
    closeStore(serve, { token: 'q', seq: 1, at: at(20) }),
  ];
  for (const order of [stores, [...stores].reverse()]) {
    const sessions = module.mergeSessions(order);
    const result = join([], module.journalDeliveries(sessions));
    assert.equal(result.unjudged.length, 1);
    assert.equal(result.unjudged[0].status, 'settled', 'same-token close settles despite an equal-time foreign close');
  }
});

test('reversed-clock close markers settle the delivery in all six store orders', () => {
  const serve = delivery('t-10', 10, { at: at(25) });
  const stores = [
    closeStore(serve, { token: 't', seq: 20, at: at(10) }),
    closeStore(serve, { token: 'q', seq: 1, at: at(20) }),
    closeStore(serve, { token: 't', seq: 5, at: at(30) }),
  ];
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const sessions = module.mergeSessions([stores[a], stores[b], stores[c]]);
    const result = join([], module.journalDeliveries(sessions));
    assert.equal(result.unjudged.length, 1);
    assert.equal(result.unjudged[0].status, 'settled', 'highest same-token sequence settles despite reversed clocks');
    assert.deepEqual(sessions.s.contexts[0].closeMarkers, [
      { token: 'q', seq: 1, at: at(20) }, { token: 't', seq: 20, at: at(10) },
    ], 'retain only the highest sequence per token');
  }
});

test('same-act discharge tolerates a null verdict session like claim matching', () => {
  const a = delivery('t-10', 10), b = delivery('t-11', 11, { servingSeq: 12 });
  const verdict = row('t-10', 10, 12, { verdictId: 't-13', sessionId: null });
  const result = join([verdict], [a, b], { contexts: { s: { 0: { lastClose: { token: 't', seq: 20, at: at(20) } } } } });
  assert.equal(result.unjudged[0].status, 'dischargedBySameAct', 'null session keeps the same-act discharge classification');
  assert.equal(join([{ ...verdict, sessionId: 'other' }], [b]).unjudged[0].status, 'open', 'a different known session cannot discharge');
});

test('legacy rows carrying delivery fields create no claims and are never dropped', () => {
  const d = delivery('t-10', 10);
  const first = row('t-10', 10, 12, { verdictId: undefined });
  const second = { ...first };
  const early = row('t-10', 10, 2, { verdictId: undefined, discharged: [d] });
  const result = join([first, second, early], [d]);
  assert.deepEqual(result.rows, [first, second, early], 'all id-less legacy rows survive even duplicate or early delivery claims');
  assert.equal(result.claims.length, 0);
  assert.equal(result.duplicateRows.length, 0);
  assert.equal(result.discarded.length, 0);
  assert.equal(result.legacyIdenticalLines, 1);
  assert.equal(result.unjudged.length, 1);
});

test('equal acts choose the earlier decidedAt before input order', () => {
  const d = delivery('t-10', 10);
  const later = row('t-10', 10, 12, { verdictId: 'later', decidedAt: at(20) });
  const earlier = { ...later, verdictId: 'earlier', decidedAt: at(15) };
  assert.deepEqual(join([later, earlier], [d]).rows, [earlier], 'earlier decision time wins an act-sequence tie');
});

test('equal acts and decision times preserve the first input row', () => {
  const d = delivery('t-10', 10);
  const first = row('t-10', 10, 12, { verdictId: 'first' });
  const second = { ...first, verdictId: 'second' };
  assert.deepEqual(join([first, second], [d]).rows, [first], 'first input wins a complete tie');
  assert.deepEqual(join([second, first], [d]).rows, [second], 'reversing input reverses the complete-tie winner');
});

test('delivery join is available to both readers', () => {
  assert.equal(typeof module.joinDeliveries, 'function', 'exact delivery join must be exported');
});

test('copies require both verdictId and session; legacy identical rows pass', () => {
  const d = delivery('d', 10);
  const first = row('d', 10, 12);
  const result = join([first, { ...first }, { ...first, sessionId: 'other' }, { ...first, verdictId: undefined }, { ...first, verdictId: undefined }], [d]);
  assert.equal(result.copies.length, 1, 'only the repeated verdict id in the same session is a copy');
  assert.equal(result.legacyIdenticalLines, 1, 'identical legacy lines are counted, not removed as copies');
  assert.equal(result.rows.filter((item) => item.verdictId == null).length, 2, 'both identical legacy rows survive in the reader result');
});

test('rule 1 bounds unjudged deliveries only when an archive was read', () => {
  const deliveries = [delivery('old', 1), delivery('new', 20)];
  const result = join([], deliveries, { archiveRows: [{ decidedAt: at(10) }], archivesRead: 1 });
  assert.deepEqual(result.unjudged.map((item) => item.deliveryId), ['new'], 'old delivery is out of reach');
  assert.equal(result.outOfReach, 1);
  assert.equal(join([], deliveries).unjudged.length, 2, 'without archives there is no bound');
});

test('rule 2 sorts valid own and discharge claims by act, time and input order; conflict is counted', () => {
  const d = delivery('d', 10);
  const later = row('d', 10, 20, { verdict: 'not followed' });
  const earlier = row('d', 10, 15);
  const result = join([later, earlier], [d]);
  assert.deepEqual(result.rows, [earlier]);
  assert.equal(result.duplicateIds.length, 1);
  assert.equal(result.conflicting.length, 1);
  const discharge = row(undefined, undefined, 11, { discharged: [d] });
  const first = join([later, discharge], [d]);
  assert.equal(first.rows.length, 1, 'the later own-claim row loses to the discharge');
  assert.equal(first.duplicateRows.length, 1);
});

test('rule 3 voids early own and discharge claims but exempts the serving act', () => {
  const d = delivery('d', 10, { servingSeq: 4 });
  const early = row('d', 10, 5, { servingSeq: 4 });
  const discharged = row(undefined, undefined, 5, { verdictId: 'other', discharged: [d] });
  const result = join([early, discharged], [d]);
  assert.equal(result.discarded.length, 1);
  assert.equal(result.voidedClaims.length, 1);
  assert.equal(result.unjudged.length, 1);
  assert.equal(join([row('d', 10, 4, { servingSeq: 4 })], [d]).discarded.length, 0, 'serving act is exempt');
});

test('missing acts sort last, session guard tolerates null, and ambiguous or missing ids are separated', () => {
  const d = delivery('d', 10);
  const result = join([row('d', 10, undefined, { sessionId: null }), row('d', 10, 12), row('missing', 30, 31), row('d', 10, 14, { sessionId: 'other' })], [d, { ...d, deliveryId: 'ambiguous' }, { ...d, deliveryId: 'ambiguous' }], { sessionOf: new Set(['s', 'other']) });
  assert.equal(result.rows.includes(result.rows.find((item) => item.actSeq === 12)), true);
  assert.equal(result.withoutDelivery.idMissing.length, 2, 'both absent id and mismatched session have no matching delivery');
  assert.equal(result.withoutDelivery.sessionMissing.length, 0);
  assert.equal(join([row('ambiguous', 10, 12)], [d, { ...d, deliveryId: 'ambiguous' }, { ...d, deliveryId: 'ambiguous' }]).ambiguous.length, 1);
});

test('dropping an own row voids all its discharged claims; lastClose and same-act gap classify missing windows', () => {
  const a = delivery('a', 10), b = delivery('b', 11), c = delivery('c', 12);
  const dropped = row('a', 10, 5, { discharged: [b] });
  const result = join([dropped, row(undefined, undefined, 11, { verdictId: 't-30', ruleIdentity: c.ruleIdentity })], [a, b, c], {
    contexts: { s: { 0: { lastClose: { token: 't', seq: 20, at: at(20) } } } }, tokenOf: () => 't',
  });
  assert.equal(result.unjudged.some((item) => item.deliveryId === 'b'), true, 'a dropped row cannot discharge another window');
  assert.equal(result.unjudged.find((item) => item.deliveryId === 'c').status, 'dischargedBySameAct');
  assert.equal(result.unjudged.find((item) => item.deliveryId === 'a').status, 'settled');
  assert.equal(join([], [a], { contexts: { s: { 0: { lastClose: { token: 'other', seq: 1, at: at(20) } } } } }).unjudged[0].status, 'settled');
  assert.equal(join([], [a], { contexts: { s: { 1: {} } } }).unjudged[0].status, 'settled', 'a newer MAIN generation settles an old MAIN window');
  assert.equal(join([], [a]).unjudged[0].status, 'open');
});
