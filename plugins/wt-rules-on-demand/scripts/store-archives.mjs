// Reads the store archives the hook writes when a budgeted store key is over its budget (hooks/store-budget.js):
// `rod-store-archive-<ms>-<n>.json`: sessions as `{ format: 2, key, archivedAt, value: [units] }`, others as `{ format: 1, key, archivedAt, value }`, in the quality data directory.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rollbackInputLocations } from './rollback-input-paths.mjs';
import { archivedSegments, sumServed, sumSessions } from './delivery-join.mjs';

export const storeArchivePattern = rollbackInputLocations[2].namePattern;
const numbers = (name) => name.match(/(\d+)-(\d+)\.json$/).slice(1).map(Number);

// Archive file names of a directory listing, oldest first (by time, then by sequence).
export const storeArchiveNames = (names) => names.filter((name) => storeArchivePattern.test(name))
  .sort((a, b) => numbers(a)[0] - numbers(b)[0] || numbers(a)[1] - numbers(b)[1]);

// A missing directory holds no archive; an unreadable or malformed archive fails loudly, naming the file.
export async function readStoreArchives(directory, load = (path) => readFile(path, 'utf8')) {
  if (!directory) return [];
  const names = storeArchiveNames(await readdir(directory).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error))));
  const archives = [];
  for (const name of names) {
    const path = join(directory, name);
    try { archives.push({ ...JSON.parse(await load(path)), path }); }
    catch (error) { throw new Error(`store archive ${path} unreadable: ${error.message}`); }
  }
  return archives;
}

// Live sessions plus the archived segments of their contexts, summed.
export const withArchivedSessions = (archives, live) => sumSessions([...archivedSegments(archives, 'sessions'), live ?? {}]);
export const withArchivedServed = (archives, live) => sumServed([...archivedSegments(archives, 'served'), live ?? {}]);
