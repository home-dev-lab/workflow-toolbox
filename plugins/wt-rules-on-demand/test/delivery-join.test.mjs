import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../scripts/delivery-join.mjs').catch(() => ({}));
const at = (n) => new Date(Date.UTC(2026, 0, 1) + n).toISOString();
const delivery = (id, seq, extra = {}) => ({ deliveryId: id, deliverySeq: seq, servingSeq: seq - 1, sessionId: 's', context: '0', rule: 'r.md', ruleIdentity: 'user:r.md', at: at(seq), ...extra });
const row = (id, seq, act, extra = {}) => ({ deliveryId: id, deliverySeq: seq, servingSeq: seq - 1, verdictId: `v-${act}`, sessionId: 's', rule: 'r.md', ruleIdentity: 'user:r.md', verdict: 'followed', actSeq: act, decidedAt: at(act ?? 100), ...extra });
const join = (rows, deliveries, options) => module.joinDeliveries(rows, deliveries, options);

test('delivery join is available to both readers', () => {
  assert.equal(typeof module.joinDeliveries, 'function', 'exact delivery join must be exported');
});

test('copies require both verdictId and session; legacy identical rows pass', () => {
  const d = delivery('d', 10);
  const first = row('d', 10, 12);
  const result = join([first, { ...first }, { ...first, sessionId: 'other' }, { ...first, verdictId: undefined }, { ...first, verdictId: undefined }], [d]);
  assert.equal(result.copies.length, 1, 'only the repeated verdict id in the same session is a copy');
  assert.equal(result.legacyIdenticalLines, 1, 'identical legacy lines are counted, not removed as copies');
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
