#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { atomicLatest } from './quality-check.mjs';
import { killWorker } from './kill-worker.mjs';

const [pidText, latest, startText] = process.argv.slice(2);
const pid = Number(pidText);
const timeout = 5 * 60_000;
const started = Number(startText) || Date.now();
while (Date.now() - started < timeout) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try { process.kill(pid, 0); } catch {
    // Detached POSIX descendants may survive their leader; reap the group too.
    if (process.platform !== 'win32') killWorker(pid);
    const report = await readFile(latest, 'utf8').then(JSON.parse).catch(() => null);
    if (!report?.finishedAt || Date.parse(report.finishedAt) < started) await atomicLatest(latest, { ok: false, finishedAt: new Date().toISOString(), error: 'quality child exited without publishing a report' });
    process.exit(0);
  }
}
killWorker(pid);
const report = await readFile(latest, 'utf8').then(JSON.parse).catch(() => null);
if (!report?.finishedAt || Date.parse(report.finishedAt) < started) await atomicLatest(latest, { ok: false, finishedAt: new Date().toISOString(), error: `quality child exceeded ${timeout / 1000}s and was killed` });
