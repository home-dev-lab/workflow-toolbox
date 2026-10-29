import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeRegex, workDeadline } from '../scripts/regex-timing.mjs';

const workerURL = new URL('./fixtures/timing-stub.mjs', import.meta.url);
const result = { ms: null, checked: 1 };
function stub(t, mode, options = {}, data = {}) {
  return timeRegex({ mode, ...data, boundMs: 1, corpus: ['sample'] }, {
    workerURL,
    onWorker: (worker) => { t.after(() => worker.terminate()); },
    ...options,
  });
}

// Timeouts are failure-only safety bounds: readiness and terminal messages decide success.
test('timing worker startup is outside the work deadline', { timeout: 30_000 }, async (t) => {
  assert.deepEqual(await stub(t, 'slow-start', { workMs: 500 }), result);
});

test('timing worker ready without a result reaches the work deadline', { timeout: 10_000 }, async (t) => {
  assert.deepEqual(await stub(t, 'no-result', { workMs: 50 }), { error: 'timing worker deadline exceeded' });
});

test('timing worker without ready reaches the separate startup bound', { timeout: 10_000 }, async (t) => {
  assert.deepEqual(await stub(t, 'no-ready', { startupMs: 50 }), { error: 'timing worker did not start within 50 ms' });
});

test('timing worker work backstop has a five-second floor and scales with the input', () => {
  assert.equal(workDeadline({ boundMs: 1, corpus: ['sample'] }), 5_000);
  assert.equal(workDeadline({ boundMs: 1_200, corpus: [] }), 6_000);
  assert.equal(workDeadline({ boundMs: 1, corpus: { length: 70_001 } }), 7_000.1);
});

test('timing worker queued readiness survives startup expiry while the parent is held', { timeout: 90_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = new SharedArrayBuffer(4), signal = new Int32Array(shared);
  const onWorker = (worker) => {
    t.after(() => worker.terminate());
    // Failure-only handshake bound: wait for posting, never infer readiness from elapsed time.
    while (Atomics.load(signal, 0) !== 1)
      assert.notEqual(Atomics.wait(signal, 0, 0, 60_000), 'timed-out', 'worker posted ready');
    t.mock.timers.tick(50); // Parent still holds the queued ready callback beyond startup expiry.
    Atomics.store(signal, 0, 2); Atomics.notify(signal, 0);
  };
  assert.deepEqual(await stub(t, 'queued-ready', { startupMs: 50, onWorker }, { shared }), result);
});

test('timing worker delivered result wins when the parent wakes past the deadline', { timeout: 90_000 }, async (t) => {
  // Tick the expired timer inside the blocked callback, before Node can dispatch the queued result callback.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shared = new SharedArrayBuffer(4), signal = new Int32Array(shared);
  const onWorker = (worker) => {
    t.after(() => worker.terminate());
    worker.on('message', (message) => {
      if (!message.ready) return;
      // Handshake: the worker posts while this callback holds the parent, before its timer can run.
      Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
      // Failure-only bound on a broken handshake; scheduling speed never establishes successful delivery.
      while (Atomics.load(signal, 0) !== 2)
        assert.notEqual(Atomics.wait(signal, 0, 1, 60_000), 'timed-out', 'worker posted its result');
      assert.equal(Atomics.load(signal, 0), 2);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
      t.mock.timers.tick(1_000);
    });
  };
  assert.deepEqual(await stub(t, 'posted-result', { workMs: 1_000, onWorker }, { shared }), result);
});

test('timing worker reports a compile error before ready', { timeout: 10_000 }, async (t) => {
  assert.deepEqual(await stub(t, 'compile-error'), { error: 'compile refused' });
});

test('timing worker exiting before a result reports its exit code in either phase', { timeout: 30_000 }, async (t) => {
  for (const mode of ['exit-before-ready', 'exit-after-ready'])
    assert.deepEqual(await stub(t, mode), { error: 'timing worker exited 0' });
});

test('timing worker accepts a terminal result before ready', { timeout: 10_000 }, async (t) => {
  assert.deepEqual(await stub(t, 'early-result'), result);
});
