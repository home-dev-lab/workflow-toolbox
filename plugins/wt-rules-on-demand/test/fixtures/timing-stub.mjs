import { parentPort, workerData } from 'node:worker_threads';

const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function postWhileParentHeld(shared, answer) {
  const signal = new Int32Array(shared);
  while (Atomics.load(signal, 0) === 0) Atomics.wait(signal, 0, 0);
  answer();
  Atomics.store(signal, 0, 2); Atomics.notify(signal, 0);
}
function holdAfterQueuedReady(resultPort, shared) {
  resultPort.postMessage({ ready: true });
  const signal = new Int32Array(shared);
  Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
  while (Atomics.load(signal, 0) !== 2) Atomics.wait(signal, 0, 1);
}
const keepAlive = () => setInterval(() => {}, 1_000);
const nothing = () => { /* Deliberately exit without a further protocol message. */ };
if (workerData) runStub(workerData);
function runStub({ mode, resultPort, shared }) {
  const answer = () => resultPort.postMessage({ ms: null, checked: 1 });
  const beforeReady = { 'compile-error': () => resultPort.postMessage({ error: 'compile refused' }), 'early-result': answer,
    'exit-before-ready': nothing, 'no-ready': keepAlive };
  // slow-start already answered before ready: worker scheduling after ready cannot spend the test's work allowance.
  const afterReady = { 'no-result': keepAlive, 'exit-after-ready': nothing, 'slow-start': nothing,
    'posted-result': () => postWhileParentHeld(shared, answer) };
  if (mode === 'slow-start') { block(1_000); answer(); }
  if (Object.hasOwn(beforeReady, mode)) beforeReady[mode]();
  else {
    if (mode === 'queued-ready') holdAfterQueuedReady(resultPort, shared);
    resultPort.postMessage({ ready: true });
    parentPort.postMessage({ ready: true });
    (Object.hasOwn(afterReady, mode) ? afterReady[mode] : answer)();
  }
  resultPort.close();
}
