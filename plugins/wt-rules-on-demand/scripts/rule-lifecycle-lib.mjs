import { lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile, rename, open, link, unlink, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPLIANCE_KEYS, TRIGGER_KEYS, assertKnownKeys, parseRuntimeRule } from '../hooks/runtime-rule.js';
import { ruleDirectories } from '../paths.js';
import { safeRegex } from '../hooks/evidence.js';

export const STATIC_DIR = join('.claude', 'rules');
export const DEMAND_DIR = join('.claude', 'rules-on-demand');
export const LEDGER = join('.claude', 'rules-on-demand-ledger.jsonl');
const ROLLBACK_SIGNIFICANCE_LEVEL = 0.05;

// A rule identity is `<scope>:<rules dir>:<basename>`. The directory may itself hold a colon (a Windows drive), so the
// scope ends at the FIRST colon and the basename starts after the LAST one.
export function splitRuleIdentity(identity) {
  const text = String(identity ?? '');
  const first = text.indexOf(':');
  const last = text.lastIndexOf(':');
  if (first < 1 || last <= first + 1 || last === text.length - 1) return null;
  return { scope: text.slice(0, first), dir: text.slice(first + 1, last), name: text.slice(last + 1) };
}

const ownRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export function qualityDataDir(configDir, env = process.env) {
  let owned = false;
  if (env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_ROOT) {
    try { owned = realpathSync(env.CLAUDE_PLUGIN_ROOT) === ownRoot; } catch { /* Foreign or missing root. */ }
  }
  return owned ? resolve(env.CLAUDE_PLUGIN_DATA, 'quality') : resolve(configDir, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
}

// The quality data dir must never sit inside a rules directory or a git dir, by its given path nor its physical one.
// Returns the resolved path; throws code UNSAFE_DATA_DIR. Shared by quality-check and the SessionStart hook.
const PROTECTED_DATA_PARENTS = ['rules', 'rules-on-demand', '.git'];
export async function assertSafeDataDir(dataDir) {
  const target = resolve(dataDir);
  const refuse = (path) => { throw Object.assign(new Error(`data directory inside protected ${path}; refusing`), { code: 'UNSAFE_DATA_DIR' }); };
  for (let path = target; ; path = resolve(path, '..')) {
    if (PROTECTED_DATA_PARENTS.includes(basename(path))) refuse(path);
    if (resolve(path, '..') === path) break;
  }
  let existing = target;
  while (!(await lstat(existing).catch(() => null))) existing = resolve(existing, '..');
  const canonical = resolve(await realpath(existing), relative(existing, target));
  if (canonical.split(sep).some((part) => PROTECTED_DATA_PARENTS.includes(part))) refuse(canonical);
  return target;
}

// One-sided Fisher exact tail: probability of at most `followed` successes on demand,
// conditional on both sample sizes and the combined number of successes. Log factorials
// avoid overflow from binomial coefficients even for large observation windows.
function lowerFollowRatePValue(followed, applicable, beforeFollowed, beforeApplicable) {
  const total = applicable + beforeApplicable;
  const successes = followed + beforeFollowed;
  const logFactorial = [0];
  for (let i = 1; i <= total; i++) logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  const choose = (n, k) => logFactorial[n] - logFactorial[k] - logFactorial[n - k];
  const first = Math.max(0, applicable - (total - successes));
  let tail = 0;
  for (let x = first; x <= followed; x++) {
    tail += Math.exp(choose(successes, x) + choose(total - successes, applicable - x) - choose(total, applicable));
  }
  return Math.min(1, tail);
}

export function rollbackDecision({ triggerMiss = false, triggerMissUnmatched = 0, triggerMissMatched = 0, triggerMissEvidence = [], followed = 0, applicable = 0, beforeFollowed = 0, beforeApplicable = 0, threshold = 0.8, minimum = 5 }) {
  const missed = triggerMissUnmatched + triggerMissMatched;
  const hasMiss = triggerMiss || missed > 0;
  const rate = applicable ? followed / applicable : null;
  const beforeRate = beforeApplicable ? beforeFollowed / beforeApplicable : null;
  // Owner decision: the only revert criterion is comparative. A migrated rule goes back to static only when it is
  // followed significantly less on demand than it was static, each measured on at least `minimum` samples.
  // Without a static baseline it is flagged for attention and never reverted. `threshold` is for reports only.
  const measured = applicable >= minimum;
  const noBaseline = measured && beforeApplicable < minimum;
  const lower = measured && !noBaseline && rate < beforeRate;
  const pValue = lower ? lowerFollowRatePValue(followed, applicable, beforeFollowed, beforeApplicable) : null;
  const worse = lower && pValue < ROLLBACK_SIGNIFICANCE_LEVEL;
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const comparison = `on-demand follow rate ${pct(rate)} below static ${pct(beforeRate)} (${applicable} on-demand, ${beforeApplicable} static samples)`;
  const noise = lower ? `${comparison}, not significant (p=${pValue.toFixed(3)})` : '';
  let reason = '';
  if (hasMiss) { reason = 'trigger miss (governed acts, never served)'; if (lower) reason += `; ${worse ? comparison : noise}`; }
  else if (noBaseline) reason = `no static baseline (${beforeApplicable} static samples, minimum ${minimum}); on demand ${pct(rate)} over ${applicable} samples`;
  else if (worse) reason = comparison;
  else if (lower) reason = noise;
  let recommendation = '';
  if (triggerMissUnmatched) recommendation = `fix the trigger: it does not select ${triggerMissUnmatched} governed act(s), e.g. ${triggerMissEvidence[0] ?? 'unknown act'}`;
  else if (triggerMissMatched) recommendation = 'the trigger matched but nothing was served: engine defect (serve-once / refusal channel), investigate before any revert';
  else if (triggerMiss) recommendation = 'Fix the trigger or reinstate as static after reviewing the acts';
  else if (noBaseline) recommendation = 'measure the static regime first; never reverted without a baseline';
  else if (worse) recommendation = 'Review the rule and reinstate as static or correct the check';
  return { reason, recommendation, followed, applicable, rate, beforeRate, pValue, attention: noBaseline || hasMiss && !worse, revert: worse, threshold };
}

const scalar = (value) => {
  const text = value.trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
};

function parseYamlSpec(text) {
  const result = { 'on-demand': { triggers: [] }, compliance: {} };
  let section = '';
  let trigger;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (/^on-demand:\s*$/.test(raw)) { section = 'on-demand'; continue; }
    if (/^\s{2}triggers:\s*$/.test(raw)) { section = 'triggers'; continue; }
    if (/^(?:\s{2})?compliance:\s*$/.test(raw)) { section = 'compliance'; continue; }
    const item = /^ {4}- ([a-z-]+):/.exec(raw);
    const triggerProperty = /^ {6}([a-z-]+):/.exec(raw);
    const complianceProperty = /^ {2,4}([a-z-]+):/.exec(raw);
    if (section === 'triggers' && item) {
      trigger = { [item[1]]: scalar(raw.slice(item[0].length)) };
      result['on-demand'].triggers.push(trigger);
    } else if (section === 'triggers' && triggerProperty && trigger) {
      trigger[triggerProperty[1]] = scalar(raw.slice(triggerProperty[0].length));
    } else if (section === 'compliance' && complianceProperty) {
      result.compliance[complianceProperty[1]] = scalar(raw.slice(complianceProperty[0].length));
    } else {
      throw new Error(`unsupported YAML spec line: ${raw.trim()}`);
    }
  }
  return result;
}

export async function readSpec(path) {
  const text = await readFile(path, 'utf8');
  let spec;
  try { spec = JSON.parse(text); } catch { spec = parseYamlSpec(text); }
  const triggers = spec?.['on-demand']?.triggers;
  const compliance = spec?.compliance ?? spec?.['on-demand']?.compliance;
  if (!Array.isArray(triggers) || !triggers.length) throw new Error('spec on-demand.triggers must not be empty');
  if (!compliance || typeof compliance !== 'object' || Array.isArray(compliance)) throw new Error('spec compliance block is required');
  for (const trigger of triggers) validateTrigger(trigger);
  // Same key lists as the runtime parser: a spec key the engine would not know is refused
  // here, before migrate writes it into a frontmatter the engine would then skip.
  assertKnownKeys(Object.keys(compliance), COMPLIANCE_KEYS, 'compliance');
  // Run the full runtime parser on exactly the frontmatter migrate would write, so a spec
  // prove accepts can never be refused later by apply.
  parseRuntimeRule('migration spec', frontmatter({ triggers, compliance }));
  return { triggers, compliance };
}

function validateTrigger(trigger) {
  if (trigger && typeof trigger === 'object') assertKnownKeys(Object.keys(trigger), TRIGGER_KEYS, 'trigger');
  if (!['bash', 'prompt', 'path', 'tool'].includes(trigger?.kind)) throw new Error(`unknown trigger kind: ${trigger?.kind ?? '(missing)'}`);
  if (['bash', 'prompt', 'path'].includes(trigger.kind) && !trigger.regex) throw new Error(`${trigger.kind} trigger requires regex`);
  if (['path', 'tool'].includes(trigger.kind) && !trigger.tool) throw new Error(`${trigger.kind} trigger requires tool`);
  if (trigger['input-regex'] !== undefined && trigger.kind !== 'tool') throw new Error('input-regex applies to tool triggers only');
  if (trigger['input-regex'] !== undefined && !trigger['input-regex']) throw new Error('input-regex must not be empty');
  if (trigger.unconditional !== undefined && ![true, false, 'true', 'false'].includes(trigger.unconditional)) throw new Error('unconditional must be true or false');
  if (trigger.detector !== undefined && trigger.kind !== 'tool') { throw new Error('detector applies to tool triggers only'); }
  if (trigger.kind === 'tool' && ![true, 'true'].includes(trigger.unconditional) && !trigger['input-regex'] && !trigger.detector) throw new Error('tool trigger requires unconditional: true, input-regex or detector');
  // Compiling catches invalid patterns before any lifecycle write.
  const patterns = [[trigger.regex ?? '', trigger.flags ?? '']];
  if (trigger.tool) patterns.push([trigger.tool, '']);
  if (trigger['input-regex']) patterns.push([trigger['input-regex'], trigger.flags ?? '']);
  for (const [source, flags] of patterns) safeRegex('migration spec', source, flags);
}

export const triggersHash = (triggers) => createHash('sha256').update(JSON.stringify(triggers)).digest('hex');

const yamlValue = (value) => typeof value === 'boolean' || typeof value === 'number'
  ? String(value)
  : `'${String(value).replace(/'/g, "''")}'`;

export function frontmatter(spec) {
  const lines = ['---', 'on-demand:', '  triggers:'];
  for (const trigger of spec.triggers) {
    const entries = Object.entries(trigger);
    lines.push(`    - ${entries[0][0]}: ${yamlValue(entries[0][1])}`);
    for (const [key, value] of entries.slice(1)) lines.push(`      ${key}: ${yamlValue(value)}`);
  }
  lines.push('  compliance:');
  for (const [key, value] of Object.entries(spec.compliance)) lines.push(`    ${key}: ${yamlValue(value)}`);
  return `${lines.join('\n')}\n---\n`;
}

export async function migrationPreflight(root, rule, spec, scope = 'project') {
  if (rule.includes('\\')) throw new Error(`rule path contains a literal backslash and cannot be ledgered portably: ${rule}`);
  const paths = rulePaths(root, rule, scope);
  const body = await readFile(paths.source, 'utf8');
  if (body.startsWith('---\n') || body.startsWith('---\r\n')) throw new Error('source rule already has frontmatter; refusing to alter its body');
  const rendered = `${frontmatter(spec)}${body}`;
  parseRuntimeRule(paths.name, rendered);
  return { paths, body, rendered };
}

export function stripGeneratedFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match || !/^on-demand:\r?\n {2}triggers:/m.test(match[1])) throw new Error('rule has no generated on-demand frontmatter');
  return text.slice(match[0].length);
}

const staticDirectoryOf = (scope) => scope === 'user' ? 'rules' : STATIC_DIR;
const ledgerPathOf = (root, scope) => resolve(root, scope === 'user' ? 'rules-on-demand-ledger.jsonl' : LEDGER);

// `rule` is a path RELATIVE TO THE STATIC DIRECTORY: `name.md` or `wt/name.md`. The on-demand destination is always
// FLAT (`<demand>/name.md`) because the runtime loader reads only the top level of the on-demand directory
// (hooks.js loadRuleDirectory skips every non-file entry); the origin subfolder is recorded in the ledger instead.
// Ledger paths are written with forward slashes on every OS, so a ledger reads the same wherever it was written
// (Windows relative() would otherwise record backslashes; locked by the three-OS run of the lifecycle test).
const ledgerPath = (root, path) => relative(root, path).split(sep).join('/');

export function rulePaths(root, rule, scope = 'project') {
  const name = basename(rule);
  if (!name.endsWith('.md')) throw new Error('rule must be a .md file');
  const locations = ruleDirectories(root, root);
  const staticRoot = resolve(scope === 'user' ? locations.userStatic : locations.projectStatic);
  const source = resolve(staticRoot, rule);
  if (isAbsolute(rule) || relative(staticRoot, source).startsWith('..')) throw new Error(`rule must be a path inside ${staticRoot}: ${rule}`);
  return { name, source, destination: resolve(scope === 'user' ? locations.user : locations.project, name) };
}

export async function ledger(root, entry, scope = 'project') {
  const path = ledgerPathOf(root, scope);
  await mkdir(dirname(path), { recursive: true });
  const previous = await readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const temp = `${path}.${process.pid}.tmp`;
  try { await writeFile(temp, `${previous}${JSON.stringify({ ...entry, time: new Date().toISOString() })}\n`); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

async function lastMigration(root, name, scope) {
  let text;
  try { text = await readFile(ledgerPathOf(root, scope), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.action === 'migrate' && row.rule === name) found = row;
  }
  return found;
}

// The time of the rule's last migration or revert in the ledger under `root`, or null. rollback-check ignores every
// session that ended before it: those sessions ran under the rule's previous state.
export async function lastLifecycleTime(root, name, scope = 'project') {
  let text;
  try { text = await readFile(ledgerPathOf(root, scope), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if ((row.action === 'migrate' || row.action === 'revert') && row.rule === name && Number.isFinite(Date.parse(row.time)) && (!found || Date.parse(row.time) > Date.parse(found))) found = row.time;
  }
  return found;
}

// Where a migrated rule goes back to: an explicit subpath wins; otherwise the origin the last migration ledgered
// (so `rules/wt/name.md` returns under `rules/wt/`); otherwise the top of the static directory.
async function revertPaths(root, rule, scope) {
  if (rule.includes('/')) return rulePaths(root, rule, scope);
  const origin = (await lastMigration(root, basename(rule), scope))?.from;
  if (typeof origin === 'string') {
    const staticRoot = resolve(root, staticDirectoryOf(scope));
    const subpath = relative(staticRoot, resolve(root, origin));
    if (!subpath.startsWith('..') && !isAbsolute(subpath) && basename(subpath) === basename(rule)) return rulePaths(root, subpath, scope);
  }
  return rulePaths(root, rule, scope);
}

async function realOrNull(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

// A mirror config dir holds the same layout as the primary. Per rule, each side of it is either SHARED with the primary
// (its directory resolves to the primary's directory: a directory symlink, nothing to do) or SEPARATE (it may carry a
// per-file symlink to the primary file, which must follow the move). "Same" is decided by realpath, never by name.
// Everything is planned and checked before the primary is touched.
async function planMirrors(root, from, to, mirrorDirs, scope, direction, name) {
  if (scope !== 'user' || !mirrorDirs.length) return [];
  const migration = direction === 'revert' ? await lastMigration(root, name, scope) : null;
  const fromDirectory = await realOrNull(dirname(from));
  const toDirectory = await realOrNull(dirname(to));
  const plans = [];
  for (const mirrorDir of mirrorDirs) {
    const mirrorFrom = resolve(mirrorDir, relative(root, from));
    const mirrorTo = resolve(mirrorDir, relative(root, to));
    const sharedFrom = fromDirectory !== null && await realOrNull(dirname(mirrorFrom)) === fromDirectory;
    const sharedTo = toDirectory !== null && await realOrNull(dirname(mirrorTo)) === toDirectory;
    let removeLink = false;
    if (!sharedFrom) {
      const info = await lstat(mirrorFrom).catch((error) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(error));
      if (info?.isSymbolicLink()) {
        const resolved = await realOrNull(mirrorFrom);
        removeLink = resolved !== null
          ? resolved === await realOrNull(from)
          : resolve(dirname(mirrorFrom), await readlink(mirrorFrom)) === from;
      }
    }
    // Recreate a per-file link on the arriving side only where the mirror had one: the link just removed, or (revert
    // into a separate static dir from a shared on-demand dir) the link the migration ledgered as removed.
    const hadLink = removeLink || (direction === 'revert' && (migration?.mirrors ?? []).some((mirror) => mirror?.from === mirrorTo));
    const createLink = !sharedTo && hadLink;
    if (createLink && await lstat(mirrorTo).catch(() => null)) throw new Error(`mirror ${mirrorDir}: ${mirrorTo} already exists; refusing to overwrite it`);
    if (removeLink || createLink) plans.push({ from: removeLink ? mirrorFrom : null, to: createLink ? mirrorTo : null, target: to });
  }
  return plans;
}

async function applyMirrors(plans) {
  const undo = [];
  for (const plan of plans) {
    try {
      if (plan.to) {
        await mkdir(dirname(plan.to), { recursive: true });
        await symlink(relative(dirname(plan.to), plan.target), plan.to);
        undo.push(async () => rm(plan.to, { force: true }));
      }
      if (plan.from) {
        const target = await readlink(plan.from);
        await rm(plan.from);
        undo.push(async () => symlink(target, plan.from));
      }
    } catch (error) {
       for (const revert of undo.reverse()) { await revert(); }
       throw new Error(`mirror ${plan.to || plan.from}: ${error.message}`, { cause: error });
    }
  }
  return undo;
}

async function transaction(root, scope, source, destination, rendered, plans, { entry, io = {} }) {
  if (await lstat(destination).catch(() => null)) throw new Error(`destination exists: ${destination}`);
  let undo = [];
  let created = false;
  const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const ledgerFile = ledgerPathOf(root, scope);
  const previous = await readFile(ledgerFile).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  let wroteLedger = false;
  try {
    await mkdir(dirname(destination), { recursive: true });
    await (io.writeDestination ?? writeFile)(temp, rendered, { flag: 'wx' });
    try {
      await (io.linkDestination ?? link)(temp, destination);
      created = true;
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`destination exists: ${destination}`, { cause: error });
      if (!['EPERM', 'ENOTSUP', 'EXDEV'].includes(error.code)) throw error;
      let handle;
      try {
        handle = await open(destination, 'wx');
      } catch (failure) {
        if (failure.code === 'EEXIST') throw new Error(`destination exists: ${destination}`, { cause: failure });
        throw failure;
      }
      try {
        await handle.writeFile(rendered);
        await handle.sync();
        created = true;
      } catch (failure) {
        const mine = await handle.stat();
        const current = await lstat(destination).catch(() => null);
        if (current?.ino === mine.ino && current.dev === mine.dev) await rm(destination, { force: true });
        throw failure;
      } finally { await handle.close(); }
    }
    await unlink(temp);
    try { undo = await applyMirrors(plans); } catch (error) { throw new Error(`apply mirrors: ${error.message}`, { cause: error }); }
    try { await (io.appendLedger ?? ledger)(root, entry, scope); wroteLedger = true; } catch (error) { throw new Error(`append ledger: ${error.message}`, { cause: error }); }
    // Source removal happens last. A failed unlink must roll the ledger back too.
    try { await rm(source); } catch (error) { throw new Error(`remove source: ${error.message}`, { cause: error }); }
  } catch (error) {
    if (wroteLedger) {
      if (previous === null) await rm(ledgerFile, { force: true });
      else await writeFile(ledgerFile, previous);
    }
    for (const revert of undo.reverse()) await revert();
    if (created) await rm(destination, { force: true });
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

// Lifecycle commands must be single-writer per scope. This lock is a best-effort guard
// against accidental overlap, not an exclusivity guarantee across processes or hosts.
// Keep it through planning, writes, rollback and the ledger snapshot.
async function withScopeLock(root, scope, fn) {
  const dir = resolve(root, scope === 'user' ? '.' : '.claude');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'rules-on-demand.lock');
  const staleMs = 5 * 60_000;
  let handle;
  const ownerText = JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now() });
  const wait = () => new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      handle = await open(path, 'wx');
      try { await handle.writeFile(ownerText); }
      catch (failure) {
        await handle.close();
        handle = undefined;
        if (await readFile(path, 'utf8').catch(() => null) === ownerText) await rm(path, { force: true });
        throw failure;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let recorded;
      let owner;
      try { recorded = await readFile(path, 'utf8'); owner = JSON.parse(recorded); } catch { /* Unknown owner is never safe to reclaim. */ }
      let dead = false;
      if (owner?.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
      }
      const age = Date.now() - (await stat(path).catch(() => null))?.mtimeMs;
      if (recorded && (dead || owner?.hostname && owner.hostname !== hostname() && age > staleMs)) {
        const moved = `${path}.stale.${randomUUID()}`;
        try {
          await rename(path, moved);
        } catch (failure) {
          if (failure.code !== 'ENOENT') throw failure;
          continue;
        }
        try {
          if (await readFile(moved, 'utf8') !== recorded) {
            // Avoid overwriting a newer lock observed after reclaim; this does not fence other writers.
            try { await link(moved, path); await unlink(moved); }
            catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
            continue;
          }
           console.warn(`rules-on-demand: reclaimed apparently stale lifecycle lock ${path} (${Math.round(age / 1000)}s old); run lifecycle commands single-writer per scope (best-effort guard, not cross-process or cross-host exclusivity)`);
        } finally {
          if (await readFile(moved, 'utf8').catch(() => null) === recorded) await rm(moved, { force: true });
        }
      }
       if (attempt === 99) throw new Error(`lifecycle lock held by ${owner?.hostname ?? 'unknown'}:${owner?.pid ?? 'unknown'} at ${path}; run lifecycle commands single-writer per scope and retry when the other operation finishes (best-effort guard, not cross-process or cross-host exclusivity)`, { cause: error });
      await wait();
    }
  }
   if (!handle) throw new Error(`lifecycle lock held by unknown at ${path}; run lifecycle commands single-writer per scope and retry when the other operation finishes (best-effort guard, not cross-process or cross-host exclusivity)`);
  try { return await fn(); }
  finally {
    await handle.close();
    if (await readFile(path, 'utf8').catch(() => null) === ownerText) await rm(path, { force: true });
  }
}

export async function migrateRule(root, rule, spec, proof, { scope = 'project', mirrorDirs = [], io } = {}) {
 return withScopeLock(root, scope, async () => {
     const { paths, body, rendered } = await migrationPreflight(root, rule, spec, scope);
   const mirrorPlans = await planMirrors(root, paths.source, paths.destination, mirrorDirs, scope, 'migrate', paths.name);
    await transaction(root, scope, paths.source, paths.destination, rendered, mirrorPlans, { entry: {
    action: 'migrate', scope, rule: paths.name,
    from: ledgerPath(root, paths.source), to: ledgerPath(root, paths.destination),
    mirrors: mirrorPlans.map((plan) => ({ from: plan.from, to: plan.to })),
     triggersHash: triggersHash(spec.triggers), ...proof, bodyHash: createHash('sha256').update(body).digest('hex'),
     }, io });
   return paths;
 });
}

export async function revertRule(root, rule, reason = 'manual', { scope = 'project', mirrorDirs = [] } = {}) {
 return withScopeLock(root, scope, async () => {
  const paths = await revertPaths(root, rule, scope);
  let migrated;
  try { migrated = await readFile(paths.destination, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { ...paths, changed: false };
    throw error;
  }
  const body = stripGeneratedFrontmatter(migrated);
   const mirrorPlans = await planMirrors(root, paths.destination, paths.source, mirrorDirs, scope, 'revert', paths.name);
    await transaction(root, scope, paths.destination, paths.source, body, mirrorPlans, { entry: {
    action: 'revert', scope, rule: paths.name,
    from: ledgerPath(root, paths.destination), to: ledgerPath(root, paths.source),
    mirrors: mirrorPlans.map((plan) => ({ from: plan.from, to: plan.to })), reason,
    } });
    return { ...paths, changed: true };
 });
}

export async function retireRule(root, rule, reason, { scope = 'project', mirrorDirs = [] } = {}) {
   if (!reason?.trim()) throw new Error('retire requires --reason');
 return withScopeLock(root, scope, async () => {
  const paths = rulePaths(root, rule, scope);
  const onDemand = await lstat(paths.destination).catch(() => null);
  const explicitStatic = rule.includes('/') || rule.includes('\\') ? await lstat(paths.source).catch(() => null) : null;
   let source = paths.source;
   if (!explicitStatic && onDemand) source = paths.destination;
  const body = await readFile(source);
  const archiveRoot = resolve(root, scope === 'user' ? 'rules-archive' : '.claude/rules-archive');
  const archive = resolve(archiveRoot, `${new Date().toISOString().slice(0, 10)}-${rule}`);
  if (!archive.startsWith(`${archiveRoot}${sep}`)) throw new Error('archive path escapes rules archive');
  const plans = await planMirrors(root, source, archive, mirrorDirs, scope, 'retire', paths.name);
   await transaction(root, scope, source, archive, body, plans, { entry: {
     action: 'retire', scope, rule: paths.name, from: ledgerPath(root, source), reason, archivedTo: ledgerPath(root, archive), mirrors: plans.map((plan) => ({ from: plan.from, to: plan.to })),
   } });
   return archive;
 });
}
