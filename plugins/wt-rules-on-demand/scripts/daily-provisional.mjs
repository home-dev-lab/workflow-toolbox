import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeDataDir, qualityDataDir } from './rule-lifecycle-lib.mjs';
import { provisionalRuleNames } from './serve-confirmation.mjs';

const absent = (error) => ['ENOENT', 'ENOTDIR'].includes(error.code);
const physical = (path) => realpath(path).catch((error) => absent(error) ? resolve(path) : Promise.reject(error));
const directoryPresent = (path) => readdir(path).then(() => true, (error) => absent(error) ? false : Promise.reject(error));
const demandDirectory = (root, scope) => join(root, scope === 'user' ? 'rules-on-demand' : '.claude/rules-on-demand');

export async function persistRevertNotification(dataDir, payload) {
  const dirs = new Set([dataDir, ...(payload.configDir ? [qualityDataDir(payload.configDir, {})] : [])]);
  for (const dir of dirs) {
    await assertSafeDataDir(dir);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'revert-notifications.jsonl'), JSON.stringify(payload) + '\n');
  }
}

export function bucketRollback(result, outcomes) {
  const buckets = { reverted: 'reverted', 'would revert': 'wouldRevert', attention: 'attention', refused: 'refused', 'would refuse': 'refused' };
  for (const item of outcomes) {
    if (item.confirmedNow) result.confirmed.push(item);
    else if (item.provisional) result.provisional.push(item);
    if (item.action === 'none' && Number.isFinite(item.pValue) && item.reason?.includes('not significant')) result.withinNoise.push(item);
    else if (buckets[item.action]) result[buckets[item.action]].push(item);
  }
}

// rollback-check reads one path per --mirror-dir: a comma is a literal path character, never a separator.
export const mirrorDirArgs = (mirrorDirs = []) => mirrorDirs.flatMap((mirror) => ['--mirror-dir', mirror]);

export function rollbackWindowArgs(options) {
  return options.serveWindowHours === undefined ? [] : ['--serve-window-hours', String(options.serveWindowHours)];
}

function failedCheck(result, scope, run, error) {
  result.failed.push({ ...scope, error: run.error?.message || run.stderr || error.message, stderr: run.stderr, stdout: run.stdout });
  return run.status === 3 ? 3 : 1;
}

export function checkRollbackScope(result, scope, args, { timeout = 120_000, maxBuffer = 16 * 1024 * 1024 } = {}) {
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout, maxBuffer });
  try {
    if (run.error) throw run.error;
    const outcomes = JSON.parse(run.stdout);
    if (!Array.isArray(outcomes)) throw new Error('expected rollback outcome array');
    bucketRollback(result, outcomes);
    if (run.status !== 0) throw new Error(run.stderr || `rollback-check exited ${run.status}`);
    return 0;
  } catch (error) { return failedCheck(result, scope, run, error); }
}

export async function unresolvedProvisional(root, scope) {
  const path = join(root, scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
  const text = await readFile(path, 'utf8').catch((error) => ['ENOENT', 'ENOTDIR'].includes(error.code) ? '' : Promise.reject(error));
  return provisionalRuleNames(text);
}

function validFollowedProject(item) {
  return item && typeof item.root === 'string' && isAbsolute(item.root) && typeof item.addedAt === 'string' && typeof item.by === 'string';
}

async function followedRoots(config, roots, result) {
  try {
    const followed = JSON.parse(await readFile(join(config, 'rules-on-demand', 'followed-projects.json'), 'utf8'));
    if (!Array.isArray(followed) || followed.some((item) => !validFollowedProject(item))) throw new Error('expected absolute roots with addedAt and by');
    for (const { root } of followed) roots.add(root);
  } catch (error) {
    if (!absent(error)) result.attention.push({ scope: 'project', root: config, reason: `followed-projects.json unreadable in ${config}: ${error.message}` });
  }
}

export async function provisionalProjectRoots(options, result) {
  const roots = new Set([options.project, ...(options.projects ?? [])].filter(Boolean));
  for (const config of options.configDirs) await followedRoots(config, roots, result);
  const active = [];
  for (const root of roots) {
    try {
      const present = await directoryPresent(demandDirectory(root, 'project'));
      if (present || (await unresolvedProvisional(root, 'project')).length) active.push(root);
      else result.skipped.push({ root, reason: 'on-demand rules directory missing' });
    } catch (error) { result.failed.push({ scope: 'project', root, error: error.message }); }
  }
  return active;
}

export async function reportExcludedProjects(scopes, active, result) {
  const selected = new Set(await Promise.all(active.map(physical)));
  for (const scope of scopes ?? []) {
    if (scope.scope !== 'project') continue;
    try {
      if (selected.has(await physical(scope.projectRoot))) continue;
      for (const rule of await unresolvedProvisional(scope.projectRoot, 'project')) result.attention.push({ scope: 'project', root: scope.projectRoot, rule,
        reason: 'automatic project rollback not applied: project not selected or followed' });
    } catch (error) { result.failed.push({ ...scope, root: scope.projectRoot, error: error.message }); }
  }
  return result.failed.length ? 1 : 0;
}

async function collectOwnerScope(root, scope, rulesDir, scopes, result) {
  try {
    const unresolved = await unresolvedProvisional(root, scope);
    const present = await directoryPresent(demandDirectory(root, scope));
    if (present || unresolved.length) scopes.push({ scope, root, rulesDir });
  } catch (error) { result.failed.push({ scope, root, rulesDir, error: error.message }); }
}

async function collectCandidateScopes(scope, candidate, { scopes, seen, result }) {
  try {
    const rulesDir = await physical(demandDirectory(candidate, scope));
    const owners = scope === 'user' ? [candidate, dirname(rulesDir)] : [candidate];
    for (const root of owners) {
      const key = JSON.stringify([scope, await physical(root)]);
      if (seen.has(key)) continue;
      seen.add(key);
      // The supplied ledger and the physical-owner ledger are separate sources, never substitutes.
      await collectOwnerScope(root, scope, rulesDir, scopes, result);
    }
  } catch (error) { result.failed.push({ scope, root: candidate, error: error.message }); }
}

export function provisionalArgs(scope, root, options, journalPath) {
  const args = [fileURLToPath(new URL('./rollback-check.mjs', import.meta.url)), '--provisional-only', '--json', '--journal', journalPath,
    ...(scope === 'user' ? ['--user', '--config-dir', root] : ['--project', root, ...options.configDirs.flatMap((dir) => ['--profile-dir', dir])]),
    ...rollbackWindowArgs(options), ...(options.apply ? [] : ['--dry-run'])];
  if (scope === 'user') for (const arg of mirrorDirArgs(options.mirrorDirs)) args.push(arg);
  return args;
}

export async function provisionalPass(options, active, result, journalPath) {
  const scopes = [], seen = new Set();
  const candidates = [...options.configDirs.map((dir) => ['user', dir]), ...active.map((root) => ['project', root])];
  for (const [scope, candidate] of candidates) await collectCandidateScopes(scope, candidate, { scopes, seen, result });
  let code = result.failed.length ? 1 : 0;
  for (const { scope, root, rulesDir } of scopes) {
    const args = provisionalArgs(scope, root, options, journalPath);
    code = Math.max(code, checkRollbackScope(result, { scope, root, rulesDir }, args));
  }
  return code;
}
