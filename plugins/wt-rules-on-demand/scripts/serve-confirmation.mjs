// Migration confirmation uses only the engine's identity-keyed, generation-bound load/serve record.
import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sameDirectory } from '../paths.js';
import { readIdentityActivity, oldEngineAfter } from './activity-observations.mjs';
import { projectExposure } from './project-exposure.mjs';
import { validatedMigrationProfiles } from './profile-identities.mjs';
export { readIdentityActivity } from './activity-observations.mjs';

const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code);
const physical = (path) => realpath(path).catch((error) => absent(error) ? resolve(path) : Promise.reject(error));

function matchingRequirement(row, migration) {
  return migration?.time === row.migratedAt && migration?.generation && row.generation === migration.generation && Array.isArray(row.profiles);
}

function matchingConfirmation(row, migration) {
  return migration?.time === row.migratedAt && (!migration?.generation || row.generation === migration.generation);
}

function extendRequirement(migration, row) {
  migration.profiles = [...new Set([...(migration.profiles ?? []), ...row.profiles])];
  migration.profileIdentities = [...(migration.profileIdentities ?? []), ...(row.profileIdentities ?? [])];
}

function nextMigration(migration, row) {
  if (['migrate', 'revert', 'retire'].includes(row.action)) return row.action === 'migrate' && row.state === 'provisional' ? { ...row } : null;
  if (row.action === 'require' && matchingRequirement(row, migration)) {
    extendRequirement(migration, row);
  } else if (row.action === 'confirm' && matchingConfirmation(row, migration)) return null;
  return migration;
}

export function provisionalMigration(text, name) {
  let migration = null;
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.rule === name) migration = nextMigration(migration, row);
  }
  return migration ? { ...migration, migratedAt: migration.time } : null;
}

export function provisionalRuleNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    try { const row = JSON.parse(line); if (typeof row.rule === 'string' && /^[^/\\]+\.md$/.test(row.rule)) names.add(row.rule); } catch { /* Other valid entries still count. */ }
  }
  return [...names].filter((name) => provisionalMigration(text, name));
}

export function observedServe(activity, identity, after, generation) {
  const row = activity?.[identity];
  const served = (generation ? row?.generations?.[generation] : row)?.servedAt;
  return instant(after) && instant(served) && Date.parse(served) > Date.parse(after) ? served : null;
}

export function serveWindowHours(value = 168) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) throw new Error('--serve-window-hours must be finite and nonnegative');
  return hours;
}

async function requiredProfiles(migration, scope, configDir, profileDirs) {
  const dirs = await validatedMigrationProfiles(migration);
  let candidates = [];
  if (scope !== 'user') candidates = profileDirs.length ? profileDirs : [configDir];
  if (candidates.some((dir) => typeof dir !== 'string' || !dir)) throw new Error('migration profiles unknown');
  for (const dir of candidates) {
    const real = await physical(dir);
    if (!dirs.some((prior) => sameDirectory(prior, real))) dirs.push(real);
  }
  return dirs;
}

async function sharingReason(evidence, dir, owned) {
  const keys = [];
  for (const path of evidence.directories) {
    const real = await realpath(path).catch((error) => absent(error) ? null : Promise.reject(error));
    if (real) keys.push(`path:${real}`);
  }
  for (const file of evidence.files) keys.push(`path:${file.real}`, `inode:${file.inode}`);
  for (const key of keys) {
    if (owned.has(key) && owned.get(key) !== dir) return `profiles share activity storage: ${owned.get(key)}, ${dir}`;
    owned.set(key, dir);
  }
  return '';
}

function migrationAnnotation(migration, hours, deadlineMs) {
  const deadline = Number.isFinite(deadlineMs) && deadlineMs <= 8.64e15 ? new Date(deadlineMs).toISOString() : null;
  return { migratedAt: migration.migratedAt, generation: migration.generation, deadline, serveWindowHours: hours, profiles: [] };
}

function profileState(evidence, unknown, servedAt, loadedAt, start) {
  if (evidence.unreadable.length || unknown.length) return 'unknown';
  if (servedAt) return 'served';
  if (instant(loadedAt) && Date.parse(loadedAt) > start) return 'loaded';
  return 'not loaded';
}

function profileAnnotation(dir, generation, facts) {
  const { state, servedAt, loadedAt, exposure, evidence } = facts;
  return { dir, state, generation, ...(servedAt ? { servedAt } : {}), ...(loadedAt ? { loadedAt } : {}),
    ...(exposure ? { exposure } : {}), ...(evidence.unreadable.length ? { unreadable: evidence.unreadable } : {}) };
}

function profileUncertainty(dir, migration, { state, evidence, unknown, exposure }) {
  if (state === 'unknown') {
    if (evidence.unreadable.length) return `identity activity unreadable in ${dir}: ${evidence.unreadable[0].error}`;
    return `identity activity ${unknown[0].reason} in ${dir}: ${unknown[0].path}`;
  }
  if (state === 'not loaded' && oldEngineAfter(evidence, migration.migratedAt)) return `engine too old to report loads in ${dir}`;
  if (exposure && !exposure.exposed) return `project exposure evidence missing for required profile ${dir}`;
  return '';
}

async function profileRuleDirectory(dir, { scope, root }, owned) {
  const ruleDir = await physical(scope === 'user' ? join(dir, 'rules-on-demand') : join(root, '.claude', 'rules-on-demand'));
  if (scope === 'user') {
    const key = `rule:${ruleDir}`;
    if (owned.has(key) && owned.get(key) !== dir) throw new Error(`profiles share on-demand directory: ${owned.get(key)}, ${dir}`);
    owned.set(key, dir);
  }
  return ruleDir;
}

async function profileEvidence(dir, context, owned) {
  const { migration, scope, root, name, primary, stores, archiveDir, activityCache, activityReader, exposureCache, exposureReader, start } = context;
  const exists = await stat(dir).catch((error) => absent(error) ? null : Promise.reject(error));
  if (!exists?.isDirectory()) return { row: { dir, state: 'unknown' }, uncertainty: `recorded profile missing: ${dir}` };
  const options = sameDirectory(dir, primary) ? { stores, archiveDir } : {};
  const cacheKey = JSON.stringify([dir, root, options]);
  if (!activityCache.has(cacheKey)) activityCache.set(cacheKey, activityReader(dir, options));
  const evidence = await activityCache.get(cacheKey);
  const shared = await sharingReason(evidence, dir, owned);
  if (shared) throw new Error(shared);
  const ruleDir = await profileRuleDirectory(dir, context, owned);
  const identity = `${scope}:${ruleDir}:${name}`;
  const servedAt = observedServe(evidence.activity, identity, migration.migratedAt, migration.generation);
  const loadedAt = evidence.activity[identity]?.generations?.[migration.generation]?.loadedAt;
  const unknown = evidence.unknown.filter((item) => !Number.isFinite(item.at) || item.at > start);
  const state = profileState(evidence, unknown, servedAt, loadedAt, start);
  const exposure = scope === 'project' ? await projectExposure(dir, root, migration.migratedAt, { cache: exposureCache, reader: exposureReader }) : null;
  const facts = { state, servedAt, loadedAt, unknown, exposure, evidence };
  return { row: profileAnnotation(dir, migration.generation, facts), facts };
}

async function collectProfiles(annotation, context) {
  const { migration, scope, configDir, profileDirs } = context;
  const dirs = await requiredProfiles(migration, scope, configDir, profileDirs), owned = new Map();
  const primary = await physical(configDir);
  let uncertainty = '';
  for (const dir of dirs) {
    const profile = await profileEvidence(dir, { ...context, primary }, owned);
    annotation.profiles.push(profile.row);
    const reason = profile.uncertainty ?? profileUncertainty(dir, migration, profile.facts);
    uncertainty ||= reason;
  }
  return uncertainty;
}

function evidenceDecision(annotation, scope, elapsed) {
  const { serveWindowHours: hours, profiles } = annotation;
  if (profiles.every((item) => item.state === 'served') && (scope === 'user' || elapsed)) return { annotation, decision: 'confirm', reason: '' };
  const missing = profiles.filter((item) => item.state === 'not loaded').map((item) => item.dir);
  if (elapsed && missing.length) return { annotation, decision: 'revert', reason: `no observed load or serve within ${hours}h of migration in ${missing.join(', ')}` };
  if (elapsed) return { annotation, decision: 'attention', reason: `loaded but never served within ${hours}h of migration in ${profiles.filter((item) => item.state !== 'served').map((item) => item.dir).join(', ')}` };
  return { annotation, decision: null, reason: `awaiting observed serve; reverts if not loaded after ${annotation.deadline}` };
}

function evidenceOptions({ scope, configDir, profileDirs = [], root, stores = [], archiveDir = '', windowHours = 168, now = Date.now(), exposureCache = new Map(), exposureReader, activityCache = new Map(), activityReader = readIdentityActivity }) {
  return { scope, configDir, profileDirs, root, stores, archiveDir, windowHours, now, exposureCache, exposureReader, activityCache, activityReader };
}

export async function migrationEvidence(migration, name, input) {
  const options = evidenceOptions(input), { scope, windowHours, now } = options;
  const hours = serveWindowHours(windowHours), start = Date.parse(migration.migratedAt), deadlineMs = start + hours * 3600000;
  const annotation = migrationAnnotation(migration, hours, deadlineMs);
  const attention = (reason) => ({ annotation, decision: 'attention', reason });
  if (!instant(migration.migratedAt) || !annotation.deadline) return attention('migration instant unknown; automatic rollback unavailable');
  if (!migration.generation) return attention('migration generation unknown; observed serving cannot be attributed');
  try {
    const uncertainty = await collectProfiles(annotation, { migration, name, ...options, start });
    if (uncertainty) return attention(uncertainty);
    return evidenceDecision(annotation, scope, now >= deadlineMs);
  } catch (error) { return attention(error.message); }
}
