import assert from 'node:assert/strict';
import { rescanPlansSettledForSelftest } from '../hooks/hooks.js';

export const BACKOFF = [100, 200, 400, 800, 1_600, 3_200];
export const isBackoff = (wait) => !wait.signaled;
export const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// Only a failure safety bound; neither child speed nor a quiet interval decides that an operation completed.
export async function waitFor(done) {
  const deadline = Date.now() + 30_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, 'operation did not reach its completion event');
    await nextTurn();
  }
}

// Frozen unless the test explicitly moves it: elapsed real time cannot spend a plan's lifetime.
export function shiftedNow(t) {
  const base = performance.now(), moved = { shift: 0 };
  t.mock.method(performance, 'now', () => base + moved.shift);
  return moved;
}

// Every gated plan also gets a frozen monotonic clock, so no caller can accidentally retain a real lifetime.
export function gatedClock(t) {
  const waits = [], asked = [], backoffs = [], subscribers = new Set();
  const sleep = (ms, options = {}) => (!ms ? Promise.resolve() : new Promise((resolve, reject) => {
    const wait = { ms, resolve, signaled: Boolean(options.signal) };
    waits.push(wait); asked.push(ms);
    if (!wait.signaled) backoffs.push(ms);
    for (const notify of subscribers) notify();
    subscribers.clear();
    options.signal?.addEventListener('abort', () => {
      const at = waits.indexOf(wait);
      if (at >= 0) waits.splice(at, 1);
      reject(new Error('aborted'));
    }, { once: true });
  }));
  const passWhere = (chosen) => {
    for (const wait of waits.filter(chosen)) { waits.splice(waits.indexOf(wait), 1); wait.resolve(); }
  };
  return { clock: { now: async () => Date.now(), sleep }, monotonic: shiftedNow(t), waits, asked, backoffs,
    nextWait: () => new Promise((resolve) => subscribers.add(resolve)), pass: () => passWhere(() => true), passWhere };
}

export async function backoffReady(gate) {
  let timer;
  const safety = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no back-off registered')), 60_000); });
  try {
    for (;;) {
      const next = gate.nextWait();
      if (gate.waits.some(isBackoff)) return;
      await Promise.race([next, safety]);
    }
  } finally { clearTimeout(timer); }
}

async function releasePlans(gate, plansSettled, safety, expected) {
  let ended = false, index = 0;
  void plansSettled.then(() => { ended = true; }, () => {}); // The race below still reports the original rejection.
  for (let round = 0; round < 80; round++) {
    // Subscribe before checking: each subscription is fresh, including across child/preparation gaps.
    const next = gate.nextWait(), wait = gate.waits.find(isBackoff);
    if (wait) {
      assert.equal(wait.ms, expected[index++], `unexpected back-off wait ${wait.ms} ms`);
      gate.passWhere((pending) => pending === wait);
    } else if (ended) return;
    else await Promise.race([plansSettled, next, safety]);
  }
  assert.fail('re-scan plans exceeded the drain round cap');
}

export async function drainPlans(gate, expected = BACKOFF) {
  // Snapshot after the triggering event starts its plan. Only the plan's own END proves completion.
  const plansSettled = rescanPlansSettledForSelftest();
  let timer;
  // Failure-only backstop for a broken plan/child; success never depends on this wall-clock budget.
  const safety = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('re-scan plans did not end')), 60_000); });
  try { await releasePlans(gate, plansSettled, safety, expected); }
  finally { clearTimeout(timer); }
}
