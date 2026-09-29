import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackDecision } from '../scripts/rule-lifecycle-lib.mjs';

const decide = (followed, applicable, beforeFollowed, beforeApplicable) =>
  rollbackDecision({ followed, applicable, beforeFollowed, beforeApplicable });

test('the two one-miss production gaps are reported within noise, never reverted', () => {
  for (const [followed, applicable, beforeFollowed, beforeApplicable] of [[140, 141, 148, 149], [137, 138, 186, 187]]) {
    const result = decide(followed, applicable, beforeFollowed, beforeApplicable);
    assert.equal(result.revert, false);
    assert.equal(result.attention, false);
    assert.match(result.reason, /below static .*not significant \(p=0\./);
    assert.ok(result.pValue > 0.05 && result.pValue <= 1);
  }
});

test('exact small-sample Fisher tails distinguish real loss from one miss', () => {
  const lost = decide(0, 5, 5, 5);
  assert.ok(Math.abs(lost.pValue - 1 / 252) < 1e-6);
  assert.equal(lost.revert, true);
  assert.equal(lost.attention, false);
  assert.equal(lost.reason, 'on-demand follow rate 0.0% below static 100.0% (5 on-demand, 5 static samples)');
  assert.match(lost.recommendation, /reinstate as static/);

  const oneMiss = decide(4, 5, 5, 5);
  assert.ok(Math.abs(oneMiss.pValue - 0.5) < 1e-9);
  assert.equal(oneMiss.revert, false);
  assert.equal(oneMiss.attention, false);
  assert.equal(oneMiss.reason, 'on-demand follow rate 80.0% below static 100.0% (5 on-demand, 5 static samples), not significant (p=0.500)');
  assert.equal(oneMiss.recommendation, '');
});

test('clear large-sample loss reverts; equal and improved rates have no deficit reason', () => {
  const lost = decide(60, 100, 148, 149);
  assert.equal(lost.revert, true);
  assert.equal(lost.attention, false);
  assert.ok(lost.pValue < 0.05);
  assert.equal(lost.reason, 'on-demand follow rate 60.0% below static 99.3% (100 on-demand, 149 static samples)');
  for (const kept of [decide(4, 5, 4, 5), decide(5, 5, 4, 5)]) {
    assert.equal(kept.revert, false);
    assert.equal(kept.attention, false);
    assert.equal(kept.pValue, null);
    assert.equal(kept.reason, '');
  }
});

test('minimum and missing baseline still gate comparison; misses still request attention', () => {
  assert.equal(decide(0, 4, 5, 5).pValue, null);
  const absent = decide(0, 5, 4, 4);
  assert.equal(absent.revert, false);
  assert.equal(absent.attention, true);
  assert.equal(absent.pValue, null);
  const miss = rollbackDecision({ triggerMissMatched: 1, followed: 4, applicable: 5, beforeFollowed: 5, beforeApplicable: 5 });
  assert.equal(miss.revert, false);
  assert.equal(miss.attention, true);
  assert.match(miss.reason, /^trigger miss.*not significant/);
  assert.match(miss.recommendation, /engine defect/);
});
