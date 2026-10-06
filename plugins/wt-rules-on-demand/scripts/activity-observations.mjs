// Raw engine observations are cached independently of migration cutoffs.
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sameDirectory, rawAbsolute } from '../paths.js';
import { splitRuleIdentity, qualityDataDir } from './rule-lifecycle-lib.mjs';
import { mergeActivityRow } from '../hooks/identity-activity.js';
import { storeArchiveNames } from './store-archives.mjs';
import { rollbackInputLocations, rollbackStoreDirectory } from './rollback-input-paths.mjs';

const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code);
const physical = (path) => realpath(path).catch((error) => absent(error) ? resolve(path) : Promise.reject(error));
const listing = (path) => readdir(path).catch((error) => absent(error) ? [] : Promise.reject(error));

async function archiveDirectories(config) {
  const data = join(config, 'plugins', 'data');
  const names = (await listing(data)).filter((name) => /^wt-rules-on-demand(?:$|[_-])/.test(name));
  return [...new Set([qualityDataDir(config, {}), ...names.map((name) => join(data, name, 'quality'))])];
}

function assertRecord(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid identityActivity ${kind}`);
}

function validateGeneration(record) {
  assertRecord(record, 'generation');
  for (const field of ['loadedAt', 'servedAt', 'reportedAt']) {
    if (record[field] !== undefined && !instant(record[field])) throw new Error(`invalid identityActivity ${field}`);
  }
}

function validateWriter(writer) {
  assertRecord(writer, 'writer');
  for (const field of ['healthCalls', 'healthTotals']) for (const count of Object.values(writer[field] ?? {})) {
    if (!Number.isFinite(count) || count < 0) throw new Error(`invalid identityActivity ${field}`);
  }
  for (const record of [writer, ...Object.values(writer.generations ?? {})]) validateGeneration(record);
}

function activityValue(value) {
  assertRecord(value, 'record');
  for (const row of Object.values(value)) {
    assertRecord(row, 'entry');
    for (const writer of [row, ...Object.values(row.writers ?? {})]) validateWriter(writer);
  }
  return value;
}

async function fileIdentity(path) {
  const info = await stat(path);
  return { path, real: await realpath(path), inode: `${info.dev}:${info.ino}` };
}

function latest(row) {
  return Math.max(-Infinity, ...[row, ...Object.values(row.generations ?? {})].flatMap((record) => ['loadedAt', 'servedAt', 'reportedAt'].map((field) => Date.parse(record[field]))).filter(Number.isFinite));
}

function collectWriters(row, key, path, { config, activity, unknown }) {
  const capabilities = [], writers = Object.entries(row.writers ?? {});
  if (!writers.length) unknown.push({ path, at: latest(row), reason: 'writer provenance missing' });
  for (const [run, writer] of writers) {
    // The writer stamped its physical profile at observation time; resolving it again would change historical identity.
    if (!run || !rawAbsolute(writer.profile) || !sameDirectory(writer.profile, config)) {
      unknown.push({ path, at: latest(writer), reason: 'writer profile provenance does not match required profile' });
      continue;
    }
    if (instant(writer.reportedAt)) capabilities.push({ ...writer, run, profile: config });
    if (key) {
      activity[key] ??= {};
      mergeActivityRow(activity[key], writer);
    }
  }
  return capabilities;
}

function provenanceCollector(config, activity, unknown) {
  const physicalDirs = new Map();
  const canonical = async (dir) => {
    if (!physicalDirs.has(dir)) physicalDirs.set(dir, physical(dir));
    return physicalDirs.get(dir);
  };
  return async (value, path) => {
    const capabilities = [];
    for (const [identity, row] of Object.entries(activityValue(value))) {
      const parts = splitRuleIdentity(identity);
      const key = parts ? `${parts.scope}:${await canonical(parts.dir)}:${parts.name}` : null;
      for (const writer of collectWriters(row, key, path, { config, activity, unknown })) capabilities.push(writer);
    }
    return capabilities;
  };
}

function capabilityRuns(records, cutoff = -Infinity) {
  const runs = new Map();
  for (const row of records) if (Date.parse(row.reportedAt) > cutoff) {
    const writer = runs.get(row.run) ?? { profile: row.profile };
    mergeActivityRow(writer, row);
    runs.set(row.run, writer);
  }
  return runs;
}

async function readStore(file, profile, collect, result) {
  try {
    result.files.push(await fileIdentity(file));
    const store = JSON.parse(await readFile(file, 'utf8'));
    const capabilities = await collect(Object.hasOwn(store, 'identityActivity') ? store.identityActivity : {}, file);
    result.observations.push({ profile, health: store.health?.days ?? {}, capabilities });
  } catch (error) { result.unreadable.push({ path: file, error: error.message }); }
}

async function readArchive(path, collect, result, capabilities) {
  try {
    const identity = await fileIdentity(path);
    const item = JSON.parse(await readFile(path, 'utf8'));
    if (item.key !== 'identityActivity') return;
    result.files.push(identity);
    if (item.format !== 1) throw new Error('invalid identityActivity archive format');
    for (const writer of await collect(item.value, path)) capabilities.push(writer);
  } catch (error) { result.unreadable.push({ path, error: error.message }); }
}

function extendCapabilities(observations, archivedCapabilities) {
  const archivedRuns = capabilityRuns(archivedCapabilities);
  for (const observation of observations) for (const run of new Set(observation.capabilities.map((row) => row.run))) {
    // Archives extend only a writer already attributed to this store; they never introduce another store's writer.
    if (archivedRuns.has(run)) observation.capabilities.push({ ...archivedRuns.get(run), run });
  }
}

// Every store retains its own health/capability observation; archives cannot clear another writer's uncertainty.
export async function readIdentityActivity(config, { stores = [], archiveDir = '' } = {}) {
  const storeDir = rollbackStoreDirectory(config);
  const result = { activity: {}, observations: [], unknown: [], unreadable: [], directories: [storeDir], files: [] };
  const archivedCapabilities = [];
  try {
    const profile = await physical(config);
    const collect = provenanceCollector(profile, result.activity, result.unknown);
    const paths = [...new Set([...stores, ...(await listing(storeDir)).filter((name) => rollbackInputLocations[0].namePattern.test(name)).map((name) => join(storeDir, name))])];
    for (const file of paths) await readStore(file, profile, collect, result);
    const dirs = await archiveDirectories(config);
    if (archiveDir) dirs.push(archiveDir);
    for (const dir of dirs) result.directories.push(dir);
    for (const dir of new Set(dirs)) for (const name of storeArchiveNames(await listing(dir))) {
      await readArchive(join(dir, name), collect, result, archivedCapabilities);
    }
    extendCapabilities(result.observations, archivedCapabilities);
  } catch (error) { result.unreadable.push({ path: config, error: error.message }); }
  return result;
}

export function oldEngineAfter(evidence, after) {
  const cutoff = Date.parse(after);
  return (evidence.observations ?? []).some(({ profile, health, capabilities }) => {
    const capable = capabilityRuns(capabilities, cutoff);
    return Object.entries(health).some(([day, counts]) => {
      const start = Date.parse(`${day}T00:00:00.000Z`);
      const active = counts.calls > 0;
      if (!active || !Number.isFinite(start) || start + 86400000 <= cutoff) return false;
      const writers = [...capable.values()].filter((writer) => rawAbsolute(writer.profile) && sameDirectory(writer.profile, profile));
      const attributed = writers.reduce((sum, writer) => sum + (writer.healthCalls?.[day] ?? 0), 0);
      const total = Math.max(-Infinity, ...writers.map((writer) => writer.healthTotals?.[day] ?? -Infinity));
      return attributed < counts.calls || total !== counts.calls;
    });
  });
}
