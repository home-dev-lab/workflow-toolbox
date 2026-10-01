import { parseRuntimeRule } from './runtime-rule.js';
import { maskReadOnlyMentions } from './bash-mention.js';
import { bashCommandVerdict, isGovernedAct, classify } from './act-checks.js';
import { toolInputVerdict, correlateTurn } from './declarative-checks.js';
import { ruleDirectories, configDirectory, agentLoop, projectRuleRoots, sameDirectory, normal, rawAbsolute, joinSlash, worktreePlan } from '../paths.js';
import { bounded, argumentEvidence, RULE_CAP } from './evidence.js';
import { triggerMatches, testTriggerRegex, unevaluatedTrigger } from './trigger-match.js';
import { regexCallBudget } from './linear-regex.js';
import { sameRule, ruleBody } from '../duplicate-rule.js';
import { STORE_BUDGETS, FOREIGN_KEYS_BUDGET, MIN_BUDGET, VERDICTS, shrink, archiveTexts, familyOf, archiveName, retentionVictims,
  unsafeQualityPath, isSizeRefusal, jsonLength, property, sequenceNumber } from './store-budget.js';
import { extractSymbol, detectorEnvironment, servedExtensions, classifyGrep } from './lsp-symbol.js';

export { parseRuntimeRule, maskReadOnlyMentions };

const MAIN = 'main';
const MAX_CONTEXTS = 64;
let contexts = new Map();
let queue = Promise.resolve();
let reserve = false;
let limit = 1;
let enabled = false;
let currentMain = 0;
let archiveSequence = 0;
let storeSwept = false;
// This module instance's owner number, in archive names and segment ids: its pid times 1000, plus a random part for
// two instances under one pid; a host without a pid draws the whole number.
const owner = (typeof process !== 'undefined' && Number.isSafeInteger(process.pid) ? process.pid : Math.floor(Math.random() * 4_000_000)) * 1000 + Math.floor(Math.random() * 1000);
let segSequence = 0;
const newSeg = () => `${owner.toString(36)}-${Date.now().toString(36)}-${(segSequence++).toString(36)}`;
let sequence = 0;
const processPrefix = () => (typeof process !== 'undefined' ? `${process.pid}-` : '');
const newToken = () => processPrefix() + Date.now().toString(36);
let token = newToken();
const deliveryFields = ({ deliveryId, deliverySeq, servingSeq }) => ({ deliveryId, deliverySeq, servingSeq });
const advancesClose = (previous, closeMark) => closeMark && !(previous?.token === token && previous.seq >= closeMark.seq);
const logged = new Set();
const emptyHealth = () => ({ days: {}, lastErrors: [], calls: 0 });
let pendingHealth = emptyHealth();
let lastHealthFlush = Date.now();

// The host lists every variable a module reads, so each environment read names its variable literally.
async function detectorEnv($, name) {
  if (name === 'HOME') return $.env.get('HOME');
  if (name === 'USERPROFILE') return $.env.get('USERPROFILE');
  if (name === 'CLAUDE_CONFIG_DIR') return $.env.get('CLAUDE_CONFIG_DIR');
  if (name === 'PATHEXT') return $.env.get('PATHEXT');
  if (name === 'OS') return $.env.get('OS');
  if (name === 'PATH') return $.env.get('PATH');
  throw new Error(`detector requested an unlisted environment variable: ${name}`);
}

// The only bridge from pure detector requests to Function Hooks host operations.
async function runDetectorPlan($, plan) {
  let step = plan.next();
  while (!step.done) {
    const { op, path, options } = step.value;
    let response;
    try {
      let value;
      if (op === 'read') value = await $.fs.read(path);
      else if (op === 'stat') value = options ? await $.fs.stat(path, options) : await $.fs.stat(path);
      else if (op === 'list') value = await $.fs.list(path);
      else if (op === 'env') value = await detectorEnv($, path);
      else throw new Error(`unknown detector request: ${op}`);
      response = { value };
    } catch (error) { response = { error }; }
    step = plan.next(response);
  }
  return step.value;
}

async function lspSymbolGrep($, event, ctx) {
  const input = event.input ?? event;
  if (!extractSymbol(input?.pattern) || input['-i'] === true) return false;
  const prepared = await runDetectorPlan($, detectorEnvironment(event));
  if (!prepared) return false;
  const { env, key: cacheKey } = prepared;
  if (ctx.lspServed?.key !== cacheKey) ctx.lspServed = { key: cacheKey, scan: runDetectorPlan($, servedExtensions(env)) };
  const scan = ctx.lspServed.scan;
  let served;
  try { served = await scan; }
  catch (error) { if (ctx.lspServed?.scan === scan) { ctx.lspServed = null; } throw error; }
  if (!served.size) return false;
  return runDetectorPlan($, classifyGrep(input, env, served));
}

// Reserve a store-write turn without retaining a host handle in a callback.
function writeTurn() {
  const previous = queue;
  let release;
  queue = new Promise((resolve) => { release = resolve; });
  return { previous, release };
}
const key = (name) => name.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
// Reserve the new context and detach the victim before any close I/O: a concurrent caller for the
// same loop then receives the same object, and no second caller can pick the same victim.
const context = async ($, loop) => {
  const existing = contexts.get(loop);
  if (existing) return existing;
  let victim = null;
  if (contexts.size >= MAX_CONTEXTS) {
    const oldest = [...contexts.keys()].find((name) => name !== MAIN);
    if (oldest) {
      const evicted = contexts.get(oldest);
      contexts.delete(oldest);
      victim = { loop: oldest, evicted, actSeq: ++sequence, closing: [...evicted.pending.splice(0), ...detachNext(evicted)] };
    }
  }
  const created = { rules: null, served: new Map(), pending: [], nextWindows: new Set(), refusing: new Map(), prompting: new Map(), correlation: [] };
  contexts.set(loop, created);
  if (victim) {
    for (const pending of victim.closing) await close($, pending, victim.loop, 'context evicted', victim.actSeq);
    await closeCorrelation($, victim.evicted, victim.loop, victim.actSeq);
    await journal($, [], victim.loop, [], [], [], { close: { seq: victim.actSeq } });
  }
  return created;
};
// The session root decides the project rule set, whatever directory the event (a sub-agent's included) runs in.
// The raw answer must be rooted (`/`, `X:\`, `X:/`, `\\server\share`): '', `C:`, `C:foo` or `\p` take the fallback.
async function sessionRoot($, cwd) {
  try {
    const root = await $.session.root();
    if (rawAbsolute(root)) return { root: normal(joinSlash('/', root)), fallback: false };
  } catch { /* An older host or a fixture without the capability throws here: fall back below, with a notice. */ }
  // An absolute cwd is normalised so `/x/`, `/x/.` and `C:\x` share the cache entry of `/x` and `C:/x`.
  return { root: rawAbsolute(cwd) ? normal(joinSlash('/', cwd)) : cwd, fallback: true };
}
function publish(ctx, root, rules) {
  ctx.rules = rules;
  ctx.rulesRoot = root;
}
// A rule counts as served in a context only when its identity matches the LAST copy of that name served there: a
// same-name rule from another root (another file) is a different rule. Only one copy per name is remembered, so a
// root that moves back and forth (fallback mode) serves each copy again on every switch.
const servedAs = (ctx, rule) => {
  const state = ctx.served.get(rule.name);
  return state && state.identity === rule.identity ? state : undefined;
};
async function rulesFor($, ctx, cwd) {
  const found = await sessionRoot($, cwd);
  let root = found.root;
  if (found.fallback) {
    if (!ctx.fallbackNoticed) { ctx.fallbackNoticed = true; await notice($, 'session root unavailable; project rules resolved from event cwd'); }
    // A relative cwd ('.') names no place: keep what this context already resolved rather than reload.
    if (!rawAbsolute(String(cwd)) && (ctx.loading || ctx.rules)) root = ctx.loading?.root ?? ctx.rulesRoot;
  }
  if (ctx.rules && ctx.rulesRoot === root) {
    // The published root is current again: a load still in flight for another root is retired, never published.
    if (ctx.loading && ctx.loading.root !== root) ctx.loading = null;
    return ctx.rules;
  }
  if (ctx.loading?.root !== root) ctx.loading = { root, promise: load($, root, found.fallback) };
  const pending = ctx.loading;
  let rules;
  try { rules = await pending.promise; }
  catch (error) { if (ctx.loading === pending) ctx.loading = null; throw error; }
  // Only the newest load publishes: one overtaken by a later root, or cleared by a compaction, keeps its result local.
  if (ctx.loading === pending) { ctx.loading = null; publish(ctx, root, rules); }
  return rules;
}
async function notice($, message) {
  if (/failed|skipped|unavailable|dangling|cannot|exhausted/i.test(message)) void recordHealth($, null, message).catch(() => {});
  if (!logged.has(message)) { logged.add(message); await $.ui.log(`wt-rules-on-demand: ${message}`); }
}
// Store writes stay under per-key budgets (store-budget.js): what a budget pushes out is written to an archive file in
// the quality data directory first, where every reader reads it back. Host I/O lives here, the plans are pure there.
async function qualityDirectory($) {
  const config = configDirectory({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'), HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE') });
  if (!config) throw new Error('cannot locate quality data for store archives');
  const directory = `${config}/plugins/data/wt-rules-on-demand/quality`;
  let physical = directory;
  try { physical = (await $.fs.stat(directory, { resolve: true })).realPath ?? directory; } catch { /* Not created yet: its spelling is checked. */ }
  if (unsafeQualityPath(physical)) throw new Error('unsafe quality data directory');
  return directory;
}
async function freshArchivePath($, directory, family) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const path = `${directory}/${archiveName(family, Date.now(), sequenceNumber(owner, archiveSequence++))}`;
    let taken = false;
    try { taken = await $.fs.exists(path); } catch { /* A host without exists: the name is new by its time and sequence. */ }
    if (!taken) return path;
  }
  throw new Error('no free archive name');
}
// A write the host rejected may have left part of the file: it is removed, so no reader parses a broken archive.
async function removePartial($, path, error) {
  try { await $.fs.remove(path); }
  catch (removal) {
    let left = true;
    try { left = await $.fs.exists(path); } catch { /* Unknown: reported as left. */ }
    if (left) throw new Error(`archive write failed (${error.message}) and its partial file ${path} could not be removed: ${removal.message}`);
  }
  throw error;
}
// Every complete archive stays, whatever happens next: a store write rejected after it may have committed, and readers
// count each segment once (verdict rows by id), so a copy left both archived and live is never counted twice.
async function writeArchives($, name, evicted) {
  const directory = await qualityDirectory($);
  const written = [];
  for (const text of archiveTexts(name, evicted)) {
    const path = await freshArchivePath($, directory, familyOf(name));
    try { await $.fs.write(path, text); }
    catch (error) { await removePartial($, path, error); }
    written.push(path);
  }
  return { directory, written };
}
async function retainArchives($, directory, family) {
  let entries = [];
  try { entries = await $.fs.list(directory); } catch { return; }
  for (const name of retentionVictims(entries, family)) await $.fs.remove(`${directory}/${name}`);
}
// Archive what the budget pushes out, then write. A rejected write is returned with the value it tried, so a retry
// starts from that value and never archives the same part twice.
async function setBounded($, name, value, budget, keep) {
  const { value: kept, evicted } = shrink(name, value, budget, keep);
  const archive = evicted ? await writeArchives($, name, evicted) : null;
  try { await $.store.set(name, kept); }
  catch (error) { return { kept, error }; }
  if (archive && Number.isFinite(familyOf(name).retained)) {
    try { await retainArchives($, archive.directory, familyOf(name)); }
    catch (error) { await notice($, `archive retention failed: ${error.message}`); }
  }
  return { kept };
}
// Bring every budgeted key under its budget: each write here shrinks the store, so it succeeds even on a store already
// at the limit. Runs before the first write after the hook loads, and again after the host refuses a write for size.
async function sweepStore($, except = null) {
  storeSwept = true;
  let keys = Object.keys(STORE_BUDGETS);
  try { keys = await $.store.keys(); } catch { /* A host without keys: the budgeted keys are swept, foreign ones go uncounted. */ }
  for (const name of Object.keys(STORE_BUDGETS)) {
    if (!keys.includes(name) || name === except) continue;
    const value = await $.store.get(name);
    if (value === undefined || jsonLength(value) <= STORE_BUDGETS[name]) continue;
    const { error } = await setBounded($, name, value, STORE_BUDGETS[name], null);
    if (error) throw error;
  }
  const foreign = keys.filter((name) => !Object.hasOwn(STORE_BUDGETS, name));
  let size = 0;
  for (const name of foreign) size += property(name, await $.store.get(name));
  if (size > FOREIGN_KEYS_BUDGET) await notice($, `store keys this version never writes hold ${size} characters (${foreign.join(', ')}); counted, never evicted`);
}
// A sweep that cannot archive leaves its key as it is and says so; the write it precedes is still attempted. The key
// being written is not swept: its caller already holds its value, and that value is the one shrunk and written.
async function sweepQuietly($, except) {
  try { await sweepStore($, except); }
  catch (error) { await notice($, `store sweep failed: ${error.message}`); }
}
// The one write path of a budgeted key. A size refusal (another writer grew the store) sweeps every key, then retries
// under a budget halved each time: more moves to the archives, nothing is dropped. Any other failure is thrown as is.
async function setWithin($, name, value, keep = null) {
  if (!Object.hasOwn(STORE_BUDGETS, name)) throw new Error(`store key without a budget: ${name}`);
  if (!storeSwept) await sweepQuietly($, name);
  let failure, current = value;
  for (let budget = STORE_BUDGETS[name]; budget >= MIN_BUDGET; budget = Math.floor(budget / 2)) {
    const { kept, error } = await setBounded($, name, current, budget, keep);
    if (!error) return kept;
    failure = error;
    if (!isSizeRefusal(error)) throw error;
    current = kept;
    if (budget === STORE_BUDGETS[name]) await sweepQuietly($, name);
  }
  throw failure;
}
const HEALTH_FIELDS = ['calls', 'errors', 'totalMs', 'maxMs', 'slow'];
// A stored day may come from an older shape: every counter missing, non-numeric or negative starts at zero.
const healthDay = (counts) => Object.fromEntries(HEALTH_FIELDS.map((field) => [field, Number.isFinite(counts?.[field]) && counts[field] >= 0 ? counts[field] : 0]));
// A stored error entry without a timestamp string cannot be ordered, so it is dropped rather than blocking every flush.
const healthErrors = (entries) => (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry?.at === 'string');
function mergeHealth(target, batch) {
  for (const [day, counts] of Object.entries(batch.days)) {
    const entry = target.days[day] ?? healthDay(null);
    for (const field of ['calls', 'errors', 'totalMs', 'slow']) entry[field] += counts[field];
    entry.maxMs = Math.max(entry.maxMs, counts.maxMs);
    target.days[day] = entry;
  }
  target.lastErrors.push(...batch.lastErrors);
  target.lastErrors = target.lastErrors.sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  if (Object.hasOwn(target, 'calls')) target.calls += batch.calls;
}
async function flushHealth($) {
  const turn = writeTurn();
  await turn.previous.catch(() => {});
  try {
    if (!pendingHealth.calls && !pendingHealth.lastErrors.length) return;
    const batch = pendingHealth;
    pendingHealth = emptyHealth();
    try {
      const stored = await $.store.get('health');
      const health = { days: Object.fromEntries(Object.entries(stored?.days ?? {}).map(([day, counts]) => [day, healthDay(counts)])),
        lastErrors: healthErrors(stored?.lastErrors) };
      mergeHealth(health, batch);
      health.days = Object.fromEntries(Object.entries(health.days).sort().slice(-31));
      health.lastErrors = health.lastErrors.slice(-20);
      await setWithin($, 'health', health);
      lastHealthFlush = Date.now();
    } catch (error) {
      mergeHealth(pendingHealth, batch);
      throw error;
    }
  } finally { turn.release(); }
}
function recordHealth($, elapsed, error = null, work = '') {
  const at = new Date().toISOString(), day = at.slice(0, 10);
  const entry = pendingHealth.days[day] ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0, slow: 0 };
  if (elapsed !== null) {
    entry.calls++;
    pendingHealth.calls++;
    entry.totalMs += elapsed;
    entry.maxMs = Math.max(entry.maxMs, elapsed);
    if (elapsed >= 100) entry.slow++;
  }
  if (error) { entry.errors++; pendingHealth.lastErrors.push({ at, message: String(error).slice(0, 160) }); pendingHealth.lastErrors = pendingHealth.lastErrors.slice(-20); }
  pendingHealth.days[day] = entry;
  if (work === 'turn.complete' || error || pendingHealth.calls >= 50 || Date.now() - lastHealthFlush >= 60_000) return flushHealth($);
  return Promise.resolve();
}
async function list($, dir) {
  try { return await $.fs.list(dir); } catch { return []; }
}
async function entryKind($, path, entry) {
  if (!entry.isLink && entry.kind !== 'symlink') return entry.kind;
  try {
    return (await $.fs.stat(path)).kind;
  } catch { await notice($, `dangling symlink ${path}`); return null; }
}
async function staticRules($, root, depth = 0, visited = new Set()) {
  if (depth > 32) return [];
  const entries = await list($, root);
  if (!entries.length) return [];
  const physical = await realPathOf($, root);
  if (visited.has(physical)) return [];
  visited.add(physical);
  const files = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    const kind = await entryKind($, path, entry);
    if (kind === 'file' && entry.name.endsWith('.md')) files.push({ name: entry.name, path });
    else if (kind === 'dir') files.push(...await staticRules($, path, depth + 1, visited));
  }
  return files;
}
async function realPathOf($, path) {
  try { return (await $.fs.stat(path, { resolve: true })).realPath ?? path; } catch { return path; }
}
const dotEntry = (dir, name) => `${dir === '/' ? '' : dir.replace(/\/$/, '')}/${name}`;
// The linked worktree holding the root, from git's own files (paths.js worktreePlan); unknown is said, never guessed.
async function linkedWorktree($, root) {
  let tree;
  try { tree = await runDetectorPlan($, worktreePlan(root)); } catch (error) { tree = { unknown: String(error?.message ?? error) }; }
  if (!tree?.unknown) return tree ?? {};
  await notice($, `nested-worktree check unknown: ${tree.unknown}`);
  return {};
}
async function readCapped($, file) {
  const info = await $.fs.stat(file, { resolve: true });
  if (info.size > RULE_CAP) throw new Error(`rule exceeds ${RULE_CAP} bytes`);
  const text = await $.fs.read(file);
  if (new TextEncoder().encode(text).length > RULE_CAP) throw new Error(`rule exceeds ${RULE_CAP} bytes`);
  return text;
}
async function load($, root, fallback = false) {
  const env = { CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'), HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE') };
  const config = configDirectory(env);
  if (!config) { await notice($, 'HOME and USERPROFILE unavailable; cannot locate user rules'); return []; }
  const { mainRepoRoot = null, worktreeRoot = null } = await linkedWorktree($, root);
  let candidates = projectRuleRoots(root, { configDir: config, mainRepoRoot, worktreeRoot });
  if (!candidates.length && fallback) candidates = [root];
  const configReal = await realPathOf($, config);
  // One stat per ancestor: an absent `.claude` costs nothing more, and one that IS the config directory is user scope.
  const roots = [];
  for (const dir of candidates) {
    const claude = dotEntry(dir, '.claude');
    const real = await $.fs.stat(claude, { resolve: true }).then((info) => info.realPath ?? claude, () => null);
    if (real !== null && !sameDirectory(real, configReal)) roots.push(dir);
  }
  const user = ruleDirectories(root, config);
  const staticDirs = [...roots.map((item) => ruleDirectories(item, config).projectStatic), user.userStatic];
  const staticFiles = [];
  for (const dir of staticDirs) staticFiles.push(...await staticRules($, dir));
  // Every copy of a name, user first, then project directories root first: the last one is the nearest, and wins.
  const copies = new Map();
  const physicalDirs = new Map();
  for (const [scope, dir] of [['user', user.user], ...roots.map((item) => ['project', ruleDirectories(item, config).project])]) {
    for (const entry of await list($, dir)) {
      const file = `${dir}/${entry.name}`;
      const kind = await entryKind($, file, entry);
      if (kind !== 'file' || !entry.name.endsWith('.md')) continue;
      if (!copies.has(entry.name)) copies.set(entry.name, []);
      copies.get(entry.name).push({ scope, dir, file });
    }
  }
  const rules = [];
  for (const [name, found] of copies) {
    const winner = found.at(-1);
    try {
      const text = await readCapped($, winner.file);
      for (const outer of found.slice(0, -1)) {
        const other = await readCapped($, outer.file).catch(() => null);
        if (other !== null && ruleBody(other, true) !== ruleBody(text, true)) await notice($, `shadowed: ${outer.file} by ${winner.file}`);
      }
      let suppressed = false;
      for (const item of staticFiles.filter((candidate) => candidate.name === name)) {
        const equal = sameRule(await $.fs.read(item.path), text);
        if (equal) suppressed = true;
        await notice($, equal ? `loaded twice: ${item.path} and ${winner.file}; the on-demand copy is not served` : `same name, different rule: ${item.path} and ${winner.file}`);
      }
      if (suppressed) continue;
      if (!physicalDirs.has(winner.dir)) physicalDirs.set(winner.dir, await realPathOf($, winner.dir));
      rules.push({ ...parseRuntimeRule(name, text), identity: `${winner.scope}:${physicalDirs.get(winner.dir)}:${name}` });
    } catch (error) { await notice($, `skipped ${winner.file}: ${error.message}`).catch(() => {}); }
  }
  return rules;
}
const textOf = (event) => {
  if (event.input !== undefined) return argumentEvidence(event.input);
  const args = Object.fromEntries(Object.entries(event).filter(([name]) => !['tool', 'tool_use_id', 'consent', 'agentId', 'cwd'].includes(name)));
  return Object.keys(args).length ? argumentEvidence(args) : null;
};
const pathOf = (e) => e.path ?? e.file_path ?? e.input?.path ?? e.input?.file_path ?? '';
const triggerItem = (e, prompt) => prompt
  ? { channel: 'prompt', text: e.text } : { channel: 'tool', tool: e.tool, command: e.command, path: pathOf(e), input: textOf(e) };
const exhaustionRefuses = (rule, item) => rule.triggers.some((trigger) => trigger.beforeFirstAct
  && (!trigger.detector || item.detected.get(trigger) === true));
async function selected($, ctx, rules, e, prompt, { errors, budget, beforeMatched }) {
  const item = { ...triggerItem(e, prompt), detected: new Map(), prechecked: new Map(), inputPrechecked: new Map() };
  const chosen = [];
  for (const rule of rules) {
    let matched = false;
    for (const trigger of rule.triggers) {
      if (trigger.detector) {
        if ((!eligible(ctx, rule) && !ctx.refusing.has(rule.name)) || prompt) continue;
        if (budget.exhausted) {
          errors.push({ rule: rule.name, kind: 'tool', pattern: trigger.detector, error: 'shared regex call budget exhausted; detector unevaluated' });
          continue;
        }
        let failed = false;
        const report = (error) => { failed = true; errors.push({ rule: rule.name, ...error }); };
        const tool = testTriggerRegex(trigger, trigger.tool, e.tool, report, budget);
        item.prechecked.set(trigger, !failed && tool);
        if (failed || !tool || budget.exhausted) continue;
        if (trigger.input) {
          if (item.input === null) continue;
          const inputMatches = testTriggerRegex(trigger, trigger.input, item.input, report, budget);
          item.inputPrechecked.set(trigger, !failed && inputMatches);
          if (failed || !inputMatches || budget.exhausted) continue;
        }
         const started = budget.pause();
         try { item.detected.set(trigger, await lspSymbolGrep($, e, ctx) === true); }
         catch (error) { errors.push({ rule: rule.name, kind: 'tool', pattern: trigger.detector, error: `detector failed: ${error.message ?? error}` }); }
         finally { budget.resume(started); }
        if (item.detected.get(trigger) !== true) continue;
      }
      if (budget.exhausted) {
        errors.push({ rule: rule.name, ...unevaluatedTrigger(trigger, item) });
        budget.unresolved.add(rule.name);
        matched = true;
          if (exhaustionRefuses(rule, item)) beforeMatched?.add(rule.name);
        break;
      }
      if (triggerMatches(trigger, item, (error) => errors.push({ rule: rule.name, ...error }), budget)) {
        matched = true;
        if (trigger.beforeFirstAct) beforeMatched?.add(rule.name);
        if (!beforeMatched && !budget.exhausted) break;
      }
      if (budget.exhausted && !trigger.detector) {
        budget.unresolved.add(rule.name);
        matched = true;
        if (exhaustionRefuses(rule, item)) beforeMatched?.add(rule.name);
        break;
      }
    }
    if (matched) chosen.push(rule);
  }
  return chosen;
}
const exhaustionNotice = (budget) => `wt-rules-on-demand: shared regex budget exhausted: ${budget.unresolved.size} rules served unevaluated`;
const block = (rule) => `<rule name="${rule.name}">\n${rule.content}\n</rule>`;
async function sessionId($) { try { return await $.session.id(); } catch { return null; } }
const summary = (e) => e.tool === 'Bash' ? `Bash: ${bounded(e.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}`
  : `${e.tool}: ${String(pathOf(e)).split(/[\\/]/).at(-1) || 'call'}`;

async function journal($, names, loop, suppressed = [], acts = [], injected = [], options = {}) {
  const { channel = 'tool.call', triggerErrors = [], close: closeMark } = options;
  if (!names.length && !suppressed.length && !acts.length && !injected.length && !triggerErrors.length && !closeMark) return;
  const turn = writeTurn();
  await turn.previous.catch(() => {});
  try {
     try {
      const now = new Date().toISOString();
      const served = await $.store.get('served') ?? {};
       for (const rule of names) {
         const name = typeof rule === 'string' ? rule : rule.name;
        const item = served[key(name)] ?? { count: 0, byChannel: {}, seg: newSeg() };
         item.count++; item.last = now; item.byChannel[channel] = (item.byChannel[channel] ?? 0) + 1;
        served[key(name)] = item;
      }
      if (names.length) await setWithin($, 'served', served);
      const id = await sessionId($);
      if (!id) return;
      const sessions = await $.store.get('sessions') ?? {};
      const session = sessions[id] ?? { first: now, contexts: {} };
      session.last = now;
      const ck = loop === MAIN ? String(currentMain) : `agent:${loop}`;
      const ctx = session.contexts[ck] ?? { served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [], seg: newSeg() };
      ctx.last = now;
      for (const rule of names) {
        const name = typeof rule === 'string' ? rule : rule.name;
        ctx.served[key(name)] = (ctx.served[key(name)] ?? 0) + 1;
        if (rule.identity) { ctx.servedIdentity ??= {}; ctx.servedIdentity[rule.identity] = (ctx.servedIdentity[rule.identity] ?? 0) + 1; }
      }
      for (const rule of suppressed) {
        const name = typeof rule === 'string' ? rule : rule.name;
        ctx.suppressedCap[key(name)] = (ctx.suppressedCap[key(name)] ?? 0) + 1;
        if (rule.identity) { ctx.suppressedIdentity ??= {}; ctx.suppressedIdentity[rule.identity] = (ctx.suppressedIdentity[rule.identity] ?? 0) + 1; }
      }
       for (const rule of acts) {
         const existing = ctx.governedActs.find((item) => item.ruleIdentity === rule.identity);
         if (existing) { existing.count++; existing.last = now; }
         else ctx.governedActs.push({ rule: rule.name, ruleIdentity: rule.identity, at: now, last: now, count: 1 });
       }
        for (const pending of injected) ctx.complianceInjected.push({ rule: pending.rule.name, ruleIdentity: pending.rule.identity, at: now, ...deliveryFields(pending) });
        if (advancesClose(ctx.lastClose, closeMark)) ctx.lastClose = { token, seq: closeMark.seq, at: now };
       if (triggerErrors.length) {
         ctx.triggerErrors ??= [];
         ctx.triggerErrors.push(...triggerErrors.map((error) => ({ ...error, at: now, channel })));
          // Retain every error from this call, even when a mass serve exceeds
          // the usual 100-row history cap; older rows yield first.
          ctx.triggerErrors = ctx.triggerErrors.slice(-Math.max(100, triggerErrors.length));
       }
      session.contexts[ck] = ctx;
      sessions[id] = session;
      // Over its budget, the oldest contexts move to an archive file first; this context moves last.
      await setWithin($, 'sessions', sessions, { id, ck, newSeg });
     } catch (error) { await notice($, `journal write failed: ${error.message}`).catch(() => {}); }
   } finally { turn.release(); }
}
 async function verdict($, pending, loop, value, evidence, reason, act = {}) {
   const { rule } = pending;
   const { seq: actSeq, discharged = [] } = act;
   const verdictId = `${token}-${++sequence}`;
   const record = { rule: rule.name, ruleIdentity: rule.identity, trigger: pending.trigger, verdict: value, evidence: String(evidence).slice(0, 160), sessionId: await sessionId($), agentId: loop === MAIN ? null : loop, injectedAt: pending.injectedAt, decidedAt: new Date().toISOString(), verdictId, actSeq,
     ...(pending.deliveryId ? deliveryFields(pending) : {}), ...(discharged.length ? { discharged: discharged.map(deliveryFields) } : {}), ...(reason ? { reason } : {}) };
   const turn = writeTurn();
   await turn.previous.catch(() => {});
   try {
    const old = String(await $.store.get(VERDICTS) ?? '');
    const line = `${JSON.stringify(record)}\n`;
    // Over its budget, every older line moves to a verdict archive in quality data before the new line is written.
    await setWithin($, VERDICTS, old + line, { line });
   } finally { turn.release(); }
}
 async function safeVerdict($, pending, loop, value, evidence, reason, act) {
   try { await verdict($, pending, loop, value, evidence, reason, act); }
  catch (error) { await notice($, `verdict write failed: ${error.message}`).catch(() => {}); }
}
// Claim every window synchronously before verdict I/O can interleave with another call.
// A window whose decision throws stays open with every window not yet visited; the decisions taken
// before it are still written, then the error propagates as it did before the split.
function decideEvaluate(ctx, e, measured) {
  const remaining = [];
  const actions = [];
  const windows = ctx.pending;
  let error = null;
  for (let index = 0; index < windows.length; index++) {
    const pending = windows[index];
    try { decideWindow(pending, e, measured, actions, remaining); }
    catch (failure) { error = failure; remaining.push(...windows.slice(index)); break; }
  }
  ctx.pending = remaining;
  return { actions, error };
}
function decideWindow(pending, e, measured, actions, remaining) {
  const c = pending.rule.compliance;
  pending.remaining--;
  pending.calls.push({ detail: `${e.tool}: ${bounded(textOf(e) ?? '')}`, summary: summary(e) });
  if (c.kind === 'bash-command' && isGovernedAct(c, e)) {
     if (!measured.has(pending.rule.name)) actions.push({ type: 'verdict', pending, value: bashCommandVerdict(c, e.command ?? ''), evidence: summary(e) });
     else dischargeMeasured(actions, pending);
    measured.add(pending.rule.name);
  }
  else if (c.kind === 'tool-input') {
    const { verdict: value, matchError } = toolInputVerdict(c, { tool: e.tool, input: e.input ?? e });
    if (value === null) {
      if (pending.remaining <= 0) actions.push({ type: 'close', pending });
      else remaining.push(pending);
      return;
    }
     if (!measured.has(pending.rule.name)) actions.push({ type: 'verdict', pending, value, evidence: summary(e), reason: matchError });
     else dischargeMeasured(actions, pending);
    measured.add(pending.rule.name);
  }
  else if (c.kind === 'test-before-edit' && e.tool === 'Bash' && c.test.test(bounded(e.command))) {
    pending.testSeen = true;
    if (pending.remaining <= 0) actions.push({ type: 'close', pending });
    else remaining.push(pending);
  }
  else if (c.kind === 'test-before-edit' && isGovernedAct(c, e)) actions.push({ type: 'verdict', pending, value: pending.testSeen ? 'followed' : 'not followed', evidence: summary(e) });
  else if (pending.remaining <= 0) actions.push({ type: 'close', pending });
  else remaining.push(pending);
}
function dischargeMeasured(actions, pending) {
  const owner = actions.find((action) => action.type === 'verdict' && action.pending.rule.name === pending.rule.name);
  if (!owner) return;
  owner.discharged ??= [];
  owner.discharged.push(pending);
}
 async function evaluate($, ctx, e, loop, measured, actSeq) {
  const { actions, error } = decideEvaluate(ctx, e, measured);
  for (const action of actions) {
     if (action.type === 'verdict') await safeVerdict($, action.pending, loop, action.value, action.evidence, action.reason, { seq: actSeq, discharged: action.discharged });
     else await close($, action.pending, loop, 'window closed', actSeq);
  }
  if (error) throw error;
}
// Claim every window at call start before any verdict I/O can interleave with another call.
function decideNext(ctx, e) {
  const records = [];
  for (const pending of ctx.nextWindows) {
    const c = pending.rule.compliance;
    pending.remaining--;
    pending.calls.push({ summary: summary(e) });
    let matches = false;
    let error;
    try { matches = c.tool.test(bounded(e.tool)); } catch (failure) { error = failure; }
    if (error || matches || pending.remaining <= 0) {
      terminalNext(ctx, pending);
      let value = c.onClose;
      if (error) value = 'unknown';
      else if (matches) {
        try { value = c.requireTool.test(bounded(e.tool)) ? 'followed' : 'not followed'; }
        catch (failure) { value = 'unknown'; error = failure; }
      }
      records.push({ pending, value, evidence: summary(e), reason: error?.message ?? (matches ? undefined : 'window closed') });
    }
  }
  return records;
}
function terminalNext(ctx, pending) {
  if (pending.terminal) return false;
  pending.terminal = true;
  ctx.nextWindows.delete(pending);
  return true;
}
function detachNext(ctx) {
  const closing = [...ctx.nextWindows];
  for (const pending of closing) terminalNext(ctx, pending);
  return closing;
}
 async function closePending($, ctx, loop, reason, actSeq = ++sequence) {
   const closing = [...ctx.pending.splice(0), ...detachNext(ctx)];
   for (const pending of closing) await close($, pending, loop, reason, actSeq);
   return actSeq;
}
 async function close($, pending, loop, reason = 'window closed', actSeq) {
  const c = pending.rule.compliance;
  if (c.kind === 'model') {
    try {
       const v = await $.model.classify([pending.rule.content, c.prompt, ...pending.calls.map((call) => call.detail)].join('\n'), ['followed', 'not followed', 'not applicable'], { model: c.model });
         await safeVerdict($, pending, loop, v || 'unknown', pending.calls.map((call) => call.summary).join(' | ') || 'no following calls', v === 'not applicable' ? c.onClose : undefined, { seq: actSeq });
       } catch (error) { await safeVerdict($, pending, loop, 'unknown', '', error.message, { seq: actSeq }); }
     } else await safeVerdict($, pending, loop, c.onClose, pending.calls.at(-1)?.summary ?? 'no governed act', reason, { seq: actSeq });
}
// A served declarative rule judges every act it governs, like a named check does while served.
function servedVerdict(c, e) {
  if (c?.kind === 'bash-command') return { verdict: isGovernedAct(c, e) ? bashCommandVerdict(c, bounded(e.command ?? '')) : null, matchError: null };
  if (c?.kind === 'tool-input') return toolInputVerdict(c, { tool: e.tool, input: e.input ?? e });
  return { verdict: null, matchError: null };
}
 function inject(ctx, rules, trigger, admission, event = null) {
    const injectedAt = new Date().toISOString();
    const injected = rules.filter((rule) => rule.compliance && !['check', 'unregistered', 'turn-correlation'].includes(rule.compliance.kind));
    const opened = [];
    for (const rule of injected) {
       const deliverySeq = ++sequence;
      const pending = { rule, trigger, injectedAt, remaining: rule.compliance.window,
         deliveryId: `${token}-${deliverySeq}`, deliverySeq, servingSeq: admission,
         calls: event && rule.compliance.kind === 'model' ? [{ detail: `${event.tool}: ${bounded(textOf(event) ?? '')}`, summary: summary(event) }] : [], testSeen: false };
       opened.push(pending);
       if (rule.compliance.kind === 'next-call') { pending.terminal = false; ctx.nextWindows.add(pending); }
      else ctx.pending.push(pending);
    }
    return opened;
}
 async function closeCorrelation($, ctx, loop, actSeq) {
  const events = [...ctx.correlation, { kind: 'turn' }];
    for (const rule of ctx.rules ?? []) if (rule.compliance?.kind === 'turn-correlation' && servedAs(ctx, rule)) {
      try { for (const item of correlateTurn(rule.compliance, events)) await safeVerdict($, { rule, trigger: 'turn.complete', injectedAt: new Date().toISOString() }, loop, item.verdict, item.id, item.detail, { seq: actSeq }); }
     catch (error) { await notice($, `${rule.name}: correlation failed: ${error.message}`).catch(() => {}); }
   }
  ctx.correlation = [];
}
const eligible = (ctx, rule) => {
  const state = servedAs(ctx, rule);
  const minutes = Number((typeof process !== 'undefined' && process.env?.WT_ROD_RESERVE_MIN) || 30);
  return !state || (reserve && state.count < limit && Date.now() - state.at >= minutes * 60_000);
};
// The host types ui.log as returning void: a progress line never aborts serving, whether it returns, rejects or throws.
async function progress($, message) {
  try { await $.ui.log(message); } catch { /* A progress line is best effort. */ }
}
function claim(ctx, rules) {
  for (const rule of rules) { const state = servedAs(ctx, rule); ctx.served.set(rule.name, { count: (state?.count ?? 0) + 1, at: Date.now(), identity: rule.identity }); }
}

/** @type {import('claude-code').Register} */
export const register = (on, options, clock = Date.now) => {
  token = newToken();
  triggerClock = clock;
  enabled = options?.enabled === true;
  reserve = options?.time_reserve === true || options?.time_reserve === '1' || (typeof process !== 'undefined' && process.env?.WT_ROD_TIME_RESERVE === '1');
  // Host userConfig defaults arrive as explicit options: max_per_context only applies with time_reserve.
  const envLimit = Number(typeof process !== 'undefined' ? process.env?.WT_ROD_MAX_PER_CONTEXT : NaN);
  limit = 1;
  if (reserve) {
    limit = 3;
    const configured = Number(options?.max_per_context);
    if (Number.isInteger(configured) && configured > 0) limit = configured;
    if (Number.isInteger(envLimit) && envLimit > 0) limit = envLimit;
  }
  contexts = new Map();
  archiveSequence = 0;
  storeSwept = false;
  pendingHealth = emptyHealth();
  lastHealthFlush = Date.now();
  on('prompt.context', promptContextEvent);
  on('session.compact', sessionCompactEvent);
  on('prompt.submit', promptSubmitEvent);
  on('turn.complete', turnCompleteEvent);
  on('tool.call', toolCallEvent);
};

let triggerClock = Date.now;
async function trackedEvent($, e, next, work) {
  if (!enabled) return next(e);
  const start = Date.now();
  let downstreamMs = 0, healthMs = 0, downstreamError = false;
  const timedNext = async (value) => {
    const began = Date.now();
    try { return await next(value); }
    catch (error) { downstreamError = true; throw error; }
    finally { downstreamMs += Date.now() - began; }
  };
  try {
    if (work === 'prompt.context') return await promptContextWork($, e, timedNext);
    if (work === 'session.compact') return await sessionCompactWork($, e, timedNext);
    if (work === 'prompt.submit') return await promptSubmitWork($, e, timedNext);
    if (work === 'turn.complete') return await turnCompleteWork($, e, timedNext);
    return await toolCallWork($, e, timedNext);
  } catch (error) {
    if (!downstreamError) {
      const began = Date.now();
      try { await recordHealth($, null, error.message).catch(() => {}); }
      finally { healthMs += Date.now() - began; }
    }
    throw error;
  } finally { await recordHealth($, Math.max(0, Date.now() - start - downstreamMs - healthMs), null, work).catch(() => {}); }
}
async function promptContextEvent($, e, next) { return trackedEvent($, e, next, 'prompt.context'); }
async function sessionCompactEvent($, e, next) { return trackedEvent($, e, next, 'session.compact'); }
async function promptSubmitEvent($, e, next) { return trackedEvent($, e, next, 'prompt.submit'); }
async function turnCompleteEvent($, e, next) { return trackedEvent($, e, next, 'turn.complete'); }
async function toolCallEvent($, e, next) { return trackedEvent($, e, next, 'tool.call'); }

async function promptContextWork($, e, next) {
    if (enabled) {
      try { if (!(await $.session.messages()).some((message) => message?.role === 'assistant')) { contexts.delete(MAIN); currentMain++; } } catch { /* Message history may be unavailable at startup. */ }
       await rulesFor($, await context($, MAIN), e.cwd ?? '.');
    }
    return next(e);
}
async function sessionCompactWork($, e, next) {
    const result = await next(e);
     if (!result || typeof result !== 'object' || !('skip' in result)) {
       const loop = agentLoop(e.agentId), ctx = contexts.get(loop);
       if (ctx) {
           const actSeq = ++sequence;
           await closePending($, ctx, loop, 'compaction', actSeq);
          await closeCorrelation($, ctx, loop, actSeq);
          await journal($, [], loop, [], [], [], { close: { seq: actSeq } });
          ctx.rules = null;
          ctx.loading = null;
           ctx.served.clear();
           ctx.lspServed = null;
            ctx.prompting = new Map(ctx.prompting);
       }
     }
    return result;
}
 async function promptSubmitWork($, e, next) {
     if (!enabled) return next(e);
     const admission = ++sequence;
    const ctx = await context($, MAIN);
     const rules = await rulesFor($, ctx, e.cwd ?? '.');
       const triggerErrors = [];
        const budget = regexCallBudget(triggerClock);
          const candidates = await selected($, ctx, rules, e, true, { errors: triggerErrors, budget });
        await journal($, [], MAIN, [], [], [], { channel: 'prompt.submit', triggerErrors });
        if (budget.exhausted) await progress($, exhaustionNotice(budget));
      while (true) {
        const conflicts = candidates.filter((rule) => eligible(ctx, rule)).map((rule) => ctx.prompting.get(rule.name)).filter(Boolean);
        if (!conflicts.length) break;
        await Promise.all(conflicts);
      }
      const prompting = ctx.prompting;
     const chosen = candidates.filter((rule) => eligible(ctx, rule));
     let release;
     const reservation = new Promise((resolve) => { release = resolve; });
      for (const rule of chosen) { prompting.set(rule.name, reservation); }
      let result;
      try {
        result = await next(chosen.length ? { ...e, context: [...(e.context ?? []), ...chosen.map(block)] } : e);
        const currentPrompting = ctx.prompting;
        if (result && ('deny' in result || 'drop' in result) || !chosen.length) return result;
       const ride = chosen.filter((rule) => currentPrompting.get(rule.name) === reservation && eligible(ctx, rule));
        if (!ride.length) { return result; }
        claim(ctx, ride);
         const injected = inject(ctx, ride, 'prompt.submit', admission);
        await journal($, ride, MAIN, [], ride, injected, { channel: 'prompt.submit' });
       for (const rule of ride) await progress($, `wt-rules-on-demand: serving ${rule.name}`);
       return result;
      } finally {
        for (const rule of chosen) for (const state of new Set([prompting, ctx.prompting])) if (state.get(rule.name) === reservation) state.delete(rule.name);
        release();
     }
}
async function turnCompleteWork($, e, next) {
    const result = await next(e);
     if (enabled) {
       const loop = agentLoop(e.agentId);
       const ctx = await context($, loop);
         const actSeq = ++sequence;
         await closePending($, ctx, loop, 'turn ended', actSeq);
        await closeCorrelation($, ctx, loop, actSeq);
        await journal($, [], loop, [], [], [], { close: { seq: actSeq } });
     }
    return result;
}
  // One matcherless tool.call handler: the host permits only one per module.
 async function toolCallWork($, e, next) {
     if (!enabled) return next(e);
     const admission = ++sequence;
    const loop = agentLoop(e.agentId);
    const existing = contexts.get(loop);
    const nextRecords = existing ? decideNext(existing, e) : [];
    const ctx = await context($, loop);
       const rules = await rulesFor($, ctx, e.cwd ?? '.');
          for (const record of nextRecords) await safeVerdict($, record.pending, loop, record.value, record.evidence, record.reason, { seq: admission });
      const measured = new Set();
      await evaluate($, ctx, e, loop, measured, admission);
      const triggerErrors = [];
      const budget = regexCallBudget(triggerClock);
       if (textOf(e) === null) for (const rule of rules) {
        if (budget.exhausted) break;
        let failed = false;
         if (rule.triggers.some((trigger) => trigger.kind === 'tool' && trigger.input && !trigger.detector && testTriggerRegex(trigger, trigger.tool, e.tool, (error) => {
          failed = true; triggerErrors.push({ rule: rule.name, ...error });
        }, budget)) && !failed) await notice($, `${rule.name}: input-regex trigger not fired, the ${e.tool} call carried no input`);
      }
      const beforeMatched = new Set();
        const chosen = await selected($, ctx, rules, e, false, { errors: triggerErrors, budget, beforeMatched });
      const before = chosen.filter((rule) => beforeMatched.has(rule.name) && ((ctx.refusing.get(rule.name) ?? 0) > 0 || !servedAs(ctx, rule)));
      await journal($, [], loop, [], [], [], { triggerErrors: [...new Map(triggerErrors.map((error) => [JSON.stringify(error), error])).values()] });
      if (budget.exhausted) await progress($, exhaustionNotice(budget));
    if (before.length) {
      // Keep pending refusals in flight until the result is returned; do not claim on failed logging/store.
       for (const rule of before) ctx.refusing.set(rule.name, (ctx.refusing.get(rule.name) ?? 0) + 1);
      try {
        await $.ui.log(`wt-rules-on-demand: before-act refusal serving ${before.map((r) => r.name).join(', ')}`);
          // A refused call never runs: its retry, seen by evaluate(), is the classifier's evidence.
           const injected = inject(ctx, before, `tool.call:${e.tool}`, admission);
         await journal($, before, loop, [], [], injected);
          for (const rule of before) if (rule.compliance?.kind === 'unregistered') await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, 'unregistered check', summary(e), rule.compliance.reason, { seq: admission });
         const result = { deny: ['wt-rules-on-demand: read the rule below before this action, then retry the same call unchanged or corrected by the rule; this refusal happens once per rule per context.', ...before.map(block)].join('\n\n') };
        claim(ctx, before);
          return result;
       } finally { for (const rule of before) { const count = ctx.refusing.get(rule.name) - 1; if (count) ctx.refusing.set(rule.name, count); else ctx.refusing.delete(rule.name); } }
    }
      const result = await next(e);
       if (result && ('deny' in result || 'drop' in result)) return result;
     if (rules.some((rule) => rule.compliance?.kind === 'turn-correlation')) {
      const id = String(e.tool_use_id ?? `${ctx.correlation.length}`);
      ctx.correlation.push({ kind: 'use', id, name: e.tool, input: e.input ?? e });
      ctx.correlation.push({ kind: 'result', id, text: typeof result === 'string' ? result : JSON.stringify(result ?? ''), isError: result?.isError === true });
    }
     const acts = rules.filter((rule) => rule.compliance && !['model', 'check'].includes(rule.compliance.kind) ? isGovernedAct(rule.compliance, e) : chosen.includes(rule));
     const ride = chosen.filter((rule) => !ctx.refusing.has(rule.name) && eligible(ctx, rule));
      if (ride.length) claim(ctx, ride);
      const injected = inject(ctx, ride, `tool.call:${e.tool}`, admission, e);
       await journal($, ride, loop, chosen.filter((rule) => !ride.includes(rule)), acts, injected);
       const classified = classify(e.tool, e.input ?? e);
        for (const rule of rules) if (rule.compliance?.kind === 'check' && servedAs(ctx, rule)) {
         for (const item of Array.isArray(classified) ? classified : [classified]) if (item?.check === rule.compliance.check)
           await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop,
              item.verdict === 'FOLLOWED' ? 'followed' : 'not followed', summary(e), undefined, { seq: admission });
       }
      for (const rule of ride) await progress($, `wt-rules-on-demand: serving ${rule.name}`);
     // This call is the act a served declarative rule judges: drop any window left for it, even one re-served just now.
      for (const rule of rules) if (servedAs(ctx, rule)) {
       const { verdict: value, matchError } = servedVerdict(rule.compliance, e);
       if (value === null) continue;
       const discharged = ctx.pending.filter((pending) => pending.rule === rule);
       ctx.pending = ctx.pending.filter((pending) => pending.rule !== rule);
       if (!measured.has(rule.name)) await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, value, summary(e), matchError, { seq: admission, discharged });
     }
     for (const rule of ride) if (rule.compliance?.kind === 'unregistered') await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, 'unregistered check', summary(e), rule.compliance.reason, { seq: admission });
    return ride.length ? { ...result, context: [...(result.context ?? []), ...ride.map(block)] } : result;
}

export function resetForSelftest() { contexts = new Map(); queue = Promise.resolve(); currentMain = 0; sequence = 0; token = newToken(); logged.clear(); archiveSequence = 0; storeSwept = false; pendingHealth = emptyHealth(); lastHealthFlush = Date.now(); }
