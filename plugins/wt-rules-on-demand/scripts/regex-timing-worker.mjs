import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const { source, flags, corpus, boundMs } = workerData;
const regex = new RegExp(source, flags);
let slow = null;
for (const command of corpus) {
  regex.lastIndex = 0;
  const start = performance.now();
  regex.test(command);
  const ms = performance.now() - start;
  if (ms > boundMs) { slow = ms; break; }
}
parentPort.postMessage(slow);
