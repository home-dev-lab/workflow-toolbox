// Function Hooks cannot delete files. SessionStart applies the shared retention plan with Node filesystem operations.
import { readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { retentionVictims, isArchive, VERDICT_ARCHIVE, STORE_ARCHIVE } from '../hooks/store-budget.js';
import { assertSafeDataDir } from './rule-lifecycle-lib.mjs';

const PARTIAL_GRACE_MS = 10 * 60_000;
const archiveFamily = (name) => [VERDICT_ARCHIVE, STORE_ARCHIVE].find((family) => isArchive(family, name));

async function archiveInfo(path) {
  // lstat provides stat sizes without following an archive symlink, including one replaced since readdir.
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function archiveEntries(directory) {
  let listing;
  try { listing = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = [];
  for (const entry of listing) {
    if (!entry.isFile() || entry.isSymbolicLink() || !archiveFamily(entry.name)) continue;
    const info = await archiveInfo(join(directory, entry.name));
    if (info?.isFile() && !info.isSymbolicLink()) entries.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
  }
  return entries;
}

// An empty partial is re-read just before removal: a writer that completed it since the listing keeps its archive.
async function stillStalePartial(path, now) {
  const info = await archiveInfo(path);
  return Boolean(info?.isFile() && !info.isSymbolicLink() && info.size === 0 && now - info.mtimeMs > PARTIAL_GRACE_MS);
}

// One file the OS refuses to delete (a Windows sharing violation, a permission) never stops the others; the refusals
// are reported together once every other victim was handled.
async function removeAll(target, budgetVictims, partials, now) {
  const removed = [], refused = [];
  for (const [name, partial] of [...budgetVictims.map((name) => [name, false]), ...partials.map((name) => [name, true])]) {
    const path = join(target, name);
    try {
      if (partial && !(await stillStalePartial(path, now))) continue;
      await rm(path, { force: true });
      removed.push(name);
    } catch (error) { refused.push(`${name}: ${error.code ?? error.message}`); }
  }
  if (refused.length) throw new Error(`could not remove ${refused.join(', ')}`);
  return removed;
}

export async function retainArchives(directory, { now = Date.now() } = {}) {
  const target = await assertSafeDataDir(directory);
  const entries = await archiveEntries(target);
  // Empty partials get their own grace, never the plan's unknown-size fallback nor its oldest-file eviction.
  const complete = entries.filter((entry) => entry.size > 0);
  const partials = entries.filter((entry) => entry.size === 0 && now - entry.mtimeMs > PARTIAL_GRACE_MS).map((entry) => entry.name);
  return removeAll(target, retentionVictims(complete, VERDICT_ARCHIVE), partials, now);
}
