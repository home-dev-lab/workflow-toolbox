import { readFile, rename, rm, writeFile } from 'node:fs/promises';

// The static-prefix trend: one JSON line per daily run, beside static-prefix-latest.json (which keeps only today).
export const HISTORY_MAX_LINES = 400;

const pad = (value, width = 2) => String(value).padStart(width, '0');

// ISO-8601 in the machine's local time, with its UTC offset ("2026-10-10T08:15:00.123+01:00").
export function isoWithOffset(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${zone}`;
}

// floorChars is the smallest per-root total: the prefix every session loads whatever its project.
export function historyRecord(staticPrefix, finishedAt) {
  const totals = staticPrefix.checks.map(({ configDir, root, totalChars, loadedChars, fileCount, status }) => ({ configDir, root, totalChars, loadedChars, fileCount, status }));
  const floorChars = totals.length ? Math.min(...totals.map((check) => check.totalChars)) : null;
  return { at: isoWithOffset(new Date(finishedAt)), floorChars, status: staticPrefix.status, totals };
}

// Appends one line and keeps the newest `max`; the file is rewritten whole through a temp file, so a crash never truncates it.
export async function appendPrefixHistory(path, record, max = HISTORY_MAX_LINES) {
  const existing = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const lines = [...existing.split('\n').filter(Boolean), JSON.stringify(record)].slice(-max);
  const temp = `${path}.${process.pid}.tmp`;
  try { await writeFile(temp, lines.join('\n') + '\n'); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
