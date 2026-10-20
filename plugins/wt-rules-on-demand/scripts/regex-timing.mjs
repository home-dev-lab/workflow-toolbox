import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const STARTUP_DEADLINE_MS = 30_000;
const WORK_DEADLINE_FLOOR_MS = 5_000;
const defaultWorkerURL = new URL('./regex-timing-worker.mjs', import.meta.url);

// A stuck-worker backstop, measured in wall time, not CPU time: a worker starved beyond it honestly reports error.
export const workDeadline = ({ boundMs, corpus }) => Math.max(WORK_DEADLINE_FLOOR_MS, boundMs * 5, corpus.length / 10);

function drainPort(port, accept) {
  for (let queued = receiveMessageOnPort(port); queued; queued = receiveMessageOnPort(port)) accept(queued.message);
}

function timingSession(worker, port, done, workMs) {
  let startupTimer, workTimer, settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(startupTimer); clearTimeout(workTimer);
    port.close();
    void worker.terminate();
    done(value);
  };
  const ready = (ms) => {
    clearTimeout(startupTimer);
    if (!settled && !workTimer) workTimer = setTimeout(() => expired('timing worker deadline exceeded'), ms);
  };
  const accept = (value) => { if (value.ready) ready(workMs); else finish(value); };
  const drain = () => drainPort(port, accept);
  // Timers can run before queued callbacks: observe readiness and terminal answers on the same port.
  const expired = (error, startup = false) => {
    drain();
    if (!startup || !workTimer) finish({ error });
  };
  return {
    finish, ready, accept, drain,
    start: (startupMs) => { startupTimer = setTimeout(() => expired(`timing worker did not start within ${startupMs} ms`, true), startupMs); },
  };
}

export function timeRegex(data, { workerURL = defaultWorkerURL, startupMs = STARTUP_DEADLINE_MS, workMs = workDeadline(data), onWorker = () => {} } = {}) {
  return new Promise((done) => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(workerURL, { workerData: { ...data, resultPort: port2 }, transferList: [port2] });
    const session = timingSession(worker, port1, done, workMs);
    session.start(startupMs);
    port1.on('message', session.accept);
    worker.on('message', session.accept);
    worker.once('error', (error) => session.finish({ error: error.message }));
    worker.once('exit', (code) => { session.drain(); session.finish({ error: `timing worker exited ${code}` }); });
    onWorker(worker);
  });
}
