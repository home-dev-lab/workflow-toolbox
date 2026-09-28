import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { safeRegex } from '../hooks/evidence.js';

const { source, flags, corpus, boundMs, operation = 'test' } = workerData;
try {
  const regex = safeRegex('timing worker', source, flags, { capture: operation !== 'test' });
  let slow = null;
  for (const command of corpus) {
    regex.lastIndex = 0;
    const start = performance.now();
    if (operation === 'exec') regex.exec(command);
    else if (operation === 'matchAll') {
      const found = [];
      for (const match of regex.matchAll(command)) if (match[1]) found.push(match[1]);
    }
    else regex.test(command);
    const ms = performance.now() - start;
    if (ms > boundMs) { slow = ms; break; }
  }
  parentPort.postMessage({ ms: slow, checked: corpus.length });
} catch (error) { parentPort.postMessage({ error: error.message }); }
