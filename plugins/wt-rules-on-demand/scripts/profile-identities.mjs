// Required profiles are historical identities, not aliases to resolve afresh at confirmation.
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { sameDirectory } from '../paths.js';

const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code);

export async function captureProfileIdentities(profiles) {
  return Promise.all(profiles.map(async (path) => {
    try {
      const physical = await realpath(path), info = await stat(physical, { bigint: true });
      if (!info.isDirectory()) throw new Error(`recorded profile missing: ${path}`);
      return { path, physical, dev: String(info.dev), ino: String(info.ino) };
    } catch (error) {
      // An unavailable profile is never retroactively stamped from a later directory.
      if (absent(error)) return { path, physical: null };
      throw error;
    }
  }));
}

const absolutePath = (path) => typeof path === 'string' && isAbsolute(path);

function recordedIdentity(path, identities) {
  const rows = identities.filter((row) => row?.path === path), row = rows[0];
  if (!absolutePath(path) || rows.length !== 1 || !absolutePath(row.physical) || typeof row.dev !== 'string' || typeof row.ino !== 'string') throw new Error(`migration profile identities unknown: ${path}`);
  return row;
}

async function validateIdentity(path, row) {
  const current = await realpath(path).catch((error) => absent(error) ? null : Promise.reject(error));
  if (!current) throw new Error(`recorded profile missing: ${path}`);
  const info = await stat(current, { bigint: true });
  if (!info.isDirectory()) throw new Error(`recorded profile missing: ${path}`);
  if (!sameDirectory(current, row.physical) || String(info.dev) !== row.dev || String(info.ino) !== row.ino) throw new Error(`profile identity changed since migration: ${path} was ${row.physical}, now ${current} (directory identity ${row.dev}:${row.ino} -> ${info.dev}:${info.ino})`);
  return current;
}

export async function validatedMigrationProfiles(migration) {
  const profiles = migration.profiles, identities = migration.profileIdentities;
  if (!Array.isArray(profiles) || !profiles.length || !Array.isArray(identities)) throw new Error('migration profile identities unknown');
  const dirs = [];
  for (const path of profiles) {
    const row = recordedIdentity(path, identities);
    const current = await validateIdentity(path, row);
    if (!dirs.some((prior) => sameDirectory(prior, current))) dirs.push(current);
  }
  return dirs;
}

export function additionalMigrationProfiles(migration, supplied) {
  const recorded = migration.profiles ?? [], added = [];
  for (const dir of supplied) {
    if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('migration profiles unknown');
    const path = resolve(dir);
    if (!recorded.includes(path) && !added.includes(path)) added.push(path);
  }
  return added;
}
