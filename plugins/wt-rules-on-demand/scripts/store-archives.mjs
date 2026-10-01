// Reads the archives the hook writes when a budgeted store key is over its budget (hooks/store-budget.js), in the
// quality data directory: `rod-store-archive-<ms>-<n>.json` (sessions as `{ format: 2, key, archivedAt, value: [units] }`,
// others as `{ format: 1, key, archivedAt, value }`) and `compliance-verdicts-archive-<ms>-<n>.jsonl` (verdict lines).
//
// A reader reads its store BEFORE listing this directory: an eviction between the two reads then leaves the segment in
// both places, and the segment join counts it once, instead of in neither.
//
// An archive that does not parse is SKIPPED and NAMED, never fatal: the host has no rename, so a file whose write was
// cut is visible under its final name, and that write came before its store write, so its rows are still live. Every
// reader prints the skipped files on stderr and lists them in its JSON output as `unreadableArchives`.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rollbackInputLocations } from './rollback-input-paths.mjs';
import { archivedSegments, reassembleSplits, sumServed, sumSessions } from './delivery-join.mjs';

export const storeArchivePattern = rollbackInputLocations[2].namePattern;
export const verdictArchivePattern = rollbackInputLocations[1].namePattern;
const numbers = (name) => name.match(/(\d+)-(\d+)\.jsonl?$/).slice(1).map(Number);

// Archive file names of a directory listing matching `pattern`, oldest first (by time, then by sequence).
export const archiveNames = (names, pattern) => names.filter((name) => pattern.test(name))
  .sort((a, b) => numbers(a)[0] - numbers(b)[0] || numbers(a)[1] - numbers(b)[1]);
export const storeArchiveNames = (names) => archiveNames(names, storeArchivePattern);

async function listing(directory) {
  if (!directory) return [];
  return readdir(directory).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
}

// `{ archives, unreadable }`: the parsed store archives, and `{ path, error }` for each one that does not parse.
export async function readStoreArchives(directory, load = (path) => readFile(path, 'utf8')) {
  const archives = [], unreadable = [];
  for (const name of storeArchiveNames(await listing(directory))) {
    const path = join(directory, name);
    try {
      const archive = JSON.parse(await load(path));
      if (!archive || typeof archive !== 'object' || typeof archive.key !== 'string') throw new Error('not a store archive');
      archives.push({ ...archive, path });
    } catch (error) { unreadable.push({ path, error: error.message }); }
  }
  // A split context whose pieces are not all readable is still read, from the pieces present, as one copy; it is named.
  const units = archives.filter((archive) => archive.key === 'sessions' && Array.isArray(archive.value))
    .flatMap((archive) => archive.value.map((unit) => ({ ...unit, archivePath: archive.path })));
  for (const { id, present, of } of reassembleSplits(units).incomplete) {
    const paths = [...new Set(units.filter((unit) => unit?.split?.id === id).map((unit) => unit.archivePath))];
    unreadable.push({ path: paths.join(', '), split: id, error: `split context ${id}: pieces ${present.join(',')} of ${of} readable, read from those as one copy` });
  }
  return { archives, unreadable };
}

// `{ texts, names, unreadable }`: the verdict archive files whose every line parses, and the others, skipped whole.
export async function readVerdictArchives(directory, load = (path) => readFile(path, 'utf8')) {
  const texts = [], names = [], unreadable = [];
  for (const name of archiveNames(await listing(directory), verdictArchivePattern)) {
    const path = join(directory, name);
    try {
      const text = await load(path);
      for (const line of text.split('\n').filter(Boolean)) JSON.parse(line);
      texts.push(text);
      names.push(name);
    } catch (error) { unreadable.push({ path, error: error.message }); }
  }
  return { texts, names, unreadable };
}

// One stderr line per skipped archive; the same list goes into the reader's JSON output.
export function reportUnreadable(reader, unreadable) {
  for (const { path, error } of unreadable) console.error(`${reader}: skipped unreadable archive ${path} (${error}); its rows are counted from the store`);
  return unreadable;
}

// Live stores (mirrors included) plus the archived segments, joined per segment and summed across segments.
export const withArchivedSessions = (archives, ...live) => sumSessions([...archivedSegments(archives, 'sessions'), ...live.map((sessions) => sessions ?? {})]);
export const withArchivedServed = (archives, ...live) => sumServed([...archivedSegments(archives, 'served'), ...live.map((served) => served ?? {})]);
