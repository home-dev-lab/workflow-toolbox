import { parseRuntimeRule } from './runtime-rule.js';
import { maskReadOnlyMentions } from './bash-mention.js';
import { bashCommandVerdict, isGovernedAct, classify } from './act-checks.js';
import { toolInputVerdict, correlateTurn } from './declarative-checks.js';
import { ruleDirectories, configDirectory, shippedFile, agentLoop, projectRuleRoots, sameDirectory, normal, rawAbsolute, joinSlash, worktreePlan } from '../paths.js';
import { bounded, argumentEvidence, RULE_CAP } from './evidence.js';
import { triggerMatches, testTriggerRegex, unevaluatedTrigger } from './trigger-match.js';
import { regexCallBudget } from './linear-regex.js';
import { refusedAfterRun } from './guard-refusal.js';
import { sameRule, ruleBody } from '../duplicate-rule.js';
import { STORE_BUDGETS, FOREIGN_KEYS_BUDGET, MIN_BUDGET, VERDICTS, shrink, archiveTexts, familyOf, archiveName,
  unsafeQualityPath, isSizeRefusal, jsonLength, property, sequenceNumber, OWNER_BITS } from './store-budget.js';
import { extractSymbol, detectorEnvironment, servedExtensions, classifyGrep } from './lsp-symbol.js';
import { joinIdentityActivity, migrationGeneration, noteActivity, stampActivity, healthActivity } from './identity-activity.js';
import { ownerNumber } from './owner-number.js';
import { configureAgentTypes, resetAgentTypes, agentTypeOptOutConfigured, neverRefuseType, knownAgentType, rememberAgentType,
  pendingAgentType, beginAgentLookup, finishAgentLookup, recordAgentType, forgetAgentType } from './agent-types.js';
import { prepareFlight, startFlight, entryFlight, finallyFlight, completeFlight, harvestFlight, markHarvested,
  mergeFlightHealth, noteFlightCall, resetFlightRecorder, disableFlightRecorder } from './flight-recorder.js';

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
// This module instance's owners, drawn once per load so two instances under one pid (a hot reload) differ as much as
// two separate hosts do: OWNER_BITS random bits in archive names (the most that keep the name's number a safe integer), and
// 52 in segment ids, which are strings. Delivery/verdict tokens use the same generator, redrawn on registration.
const owner = ownerNumber(OWNER_BITS, Math.random);
const newToken = () => ownerNumber(52, Math.random).toString(36).padStart(11, '0');
const segOwner = newToken();
let segSequence = 0;
const newSeg = () => `${segOwner}-${Date.now().toString(36)}-${(segSequence++).toString(36)}`;
let sequence = 0;
let token = newToken();
const deliveryFields = ({ deliveryId, deliverySeq, servingSeq }) => ({ deliveryId, deliverySeq, servingSeq });
const applicability = (value, noAct) => ['followed', 'not followed'].includes(value) ? 'applicable'
  : value === 'not applicable' ? (noAct ? 'no act' : 'not applicable') : 'unknown';
const measurementFields = (pending) => pending.later
  ? { later: true, servedDeliveryId: pending.servedDeliveryId ?? null } : { later: false };
const advancesClose = (previous, closeMark) => closeMark && !(previous?.token === token && previous.seq >= closeMark.seq);
const logged = new Set();
const emptyHealth = () => ({ days: {}, lastErrors: [], calls: 0 });
let pendingHealth = emptyHealth();
let lastHealthFlush = Date.now();
const activityWrites = new Map();
const pendingActivity = new Map();
let activityProfile = null;
let activityRetryAt = 0;
let flightReady = false;
let flightPending = false;
let flightConfig = null;
let flightSession = null;
let flightDisabled = false;
let usageMissing = false;
let usageStalled = false;
let scanUnavailable = false;
let scanStalled = false;

function rememberFlightConfig(config) {
  flightConfig ??= config;
  return config;
}

// A named async step, not a closure: the host validator refuses $ captured in a function expression.
async function chainFlightPhase($, previous, plan) {
  await previous;
  return runFlightPlan($, plan);
}

function queueFlightPhase($, flight, plan) {
  if (!flight?.path) return;
  flight.writes = chainFlightPhase($, flight.writes, plan);
}

// Imported plans are pure: host operations stay literal, local calls here.
async function writeFlight($, path, value) {
  try { return await $.fs.write(path, value); }
  catch (error) {
    // The host forbids capability member reads; detect an unavailable operation by calling it.
    if (error?.name === 'TypeError') { flightDisabled = true; disableFlightRecorder(); }
    throw error;
  }
}

async function flightOperation($, op, path, value) {
  if (flightDisabled) throw new TypeError('flight recorder disabled for this load');
  if (op === 'write') return writeFlight($, path, value);
  if (op === 'list') return $.fs.list(path);
  if (op === 'read') return $.fs.read(path);
  if (op === 'log') return $.ui.log(path);
}

async function runFlightPlan($, plan) {
  try {
    let step = plan.next();
    while (!step.done) {
      const { op, path, value } = step.value;
      let response;
      try {
        response = { value: await flightOperation($, op, path, value) };
      } catch (error) { response = { error }; }
      step = plan.next(response);
    }
    return step.value;
  } catch { return null; }
}

async function collectFlights($, harvested) {
  try {
    if (!harvested?.length) return;
    mergeFlightHealth(pendingHealth, { interruptedCalls: harvested.map(({ path, row }) => ({ ...row, path })) });
    // Only the engine's normal flush persists this batch; harvest never takes its write turn.
    await runFlightPlan($, markHarvested(harvested));
  } catch { /* Diagnostic collection must never affect serving. */ }
}

function beginFlight(e, work, start) {
  try {
    if (flightDisabled || !flightReady) return null;
    return startFlight(e, work, start);
  } catch { return null; }
}

async function scheduleFlights($) {
  if (flightDisabled || flightReady || flightPending || !flightConfig || !flightSession) return;
  flightPending = true;
  void finishFlightSetup($);
}

async function finishFlightSetup($) {
  try { flightReady = await initializeFlights($); }
  catch { flightReady = false; }
  finally { flightPending = false; }
}

async function initializeFlights($) {
  prepareFlight(flightConfig, flightSession);
  // Setup is background-only; calls cannot claim a slot until scanning and marking finish.
  const harvested = await runFlightPlan($, harvestFlight());
  if (!harvested) return false;
  // Unconfirmed slots stay reserved until background announcement and marking finish.
  await collectFlights($, harvested);
  return true;
}

function noteIdentityActivity(rules, field, now = new Date().toISOString()) {
  noteActivity(pendingActivity, activityWrites, rules, field, now);
}

function activityWriterProfile() {
  if (!activityProfile) throw new Error('identity activity writer profile unknown');
  return activityProfile;
}

async function recordHealthActivity($, batch, health) {
  if (!activityProfile || Date.now() < activityRetryAt) return;
  try {
    const activity = healthActivity(await readKey($, 'identityActivity'), batch, health, activityWriterProfile(), token, new Date().toISOString());
    await setWithin($, 'identityActivity', activity);
  } catch (error) {
    activityRetryAt = Date.now() + 600_000;
    try { await $.ui.log(`wt-rules-on-demand: health writer activity unavailable: ${error.message}`); } catch { /* Keep the health report. */ }
  }
}

async function flushIdentityActivity($) {
  if (!pendingActivity.size || !activityProfile || Date.now() < activityRetryAt) return;
  const turn = writeTurn();
  await turn.previous.catch(() => {});
  if (Date.now() < activityRetryAt) { turn.release(); return; }
  const batch = new Map(pendingActivity);
  pendingActivity.clear();
  try {
    if (!batch.size) return;
    const facts = stampActivity(Object.fromEntries(batch), activityWriterProfile(), token);
    const activity = joinIdentityActivity(await readKey($, 'identityActivity'), facts);
    await setWithin($, 'identityActivity', activity);
  } catch (error) {
    for (const [identity, fields] of batch) {
      const pending = pendingActivity.get(identity) ?? {};
      pendingActivity.set(identity, joinIdentityActivity({ id: fields }, { id: pending }).id);
    }
    activityRetryAt = Date.now() + 600_000;
    // Activity is one write per hook. Do not turn a failed activity write into an immediate health flush and retry storm.
    try { await $.ui.log(`wt-rules-on-demand: identity activity write failed: ${error.message}`); } catch { /* Reporting cannot abort the hook. */ }
  } finally { turn.release(); }
}

async function loadedRules($, rules) {
  noteIdentityActivity(rules, 'loadedAt');
  return rules;
}

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
// A hit moves the loop to the recent end of the map (delete then set), so the first non-main key is always the least recently used.
// The main context returned is the one the model now reads: a compaction it was never told about resets it first.
// `verify` (the main turn end) reads the conversation of an existing context whatever the live window says.
const context = async ($, loop, verify = false) => {
  const existing = contexts.get(loop);
  if (existing) {
    contexts.delete(loop);
    contexts.set(loop, existing);
    if (existing.filling) await existing.filling;
    await detectCompaction($, existing, loop, verify);
    return existing;
  }
  let victim = null;
  if (contexts.size >= MAX_CONTEXTS) {
    const oldest = [...contexts.keys()].find((name) => name !== MAIN);
    if (oldest) {
      const evicted = contexts.get(oldest);
      contexts.delete(oldest);
      victim = { loop: oldest, evicted, actSeq: ++sequence, closing: [...evicted.pending.splice(0), ...detachNext(evicted)] };
    }
  }
  const created = { rules: null, served: new Map(), pending: [], nextWindows: new Set(), refusing: new Map(), prompting: new Map(), correlation: [], filling: null, held: null, found: 0, expected: [], turns: 0, confirmedTurn: -1 };
  contexts.set(loop, created);
  created.filling = fillContext($, created, loop).finally(() => { created.filling = null; });
  if (victim) {
    for (const pending of victim.closing) await close($, pending, victim.loop, 'context evicted', victim.actSeq);
    await closeCorrelation($, victim.evicted, victim.loop, victim.actSeq);
    await journal($, [], victim.loop, [], [], [], { close: { seq: victim.actSeq } });
  }
  if (created.filling) await created.filling;
  await detectCompaction($, created, loop, false);
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
  holdServed(ctx, rules);
}
// The only record of what a context was served is the conversation its next request is built from: a rule counts as
// served only when that conversation holds the rule's exact served or pre-upgrade file-body block. This read (`as: 'api'`)
// runs once per context, when it is created, and its text is spent by the first load of its rules. (Every dispatched
// prompt.context reads the history too, apart from this one, to tell a cleared conversation: promptContextWork.)
// Unreadable (a throw, a refusal, no list), it holds nothing, so every rule is served again, never withheld.
// The main loop notes where its transcript ends BEFORE it reads the conversation: a compaction that lands between the two
// then lies past the cursor, and the first check of the context reads it.
async function fillContext($, ctx, loop) {
  if (loop === MAIN) await openCursor($, ctx);
  ctx.held = await conversationHeld($, loop);
}
async function conversationHeld($, loop) {
  let failure = 'the host returned no message list';
  try {
    const found = await hostCall($, $.session.messages(loop === MAIN ? { as: 'api' } : { as: 'api', agentId: loop }));
    if (Array.isArray(found)) return JSON.stringify(found);
    if (found && typeof found === 'object' && 'deny' in found) failure = 'the host refused the messages';
  } catch (error) { failure = error.message; }
  await notice($, `conversation unavailable, every rule counts as unserved: ${failure}`).catch(() => {});
  return null;
}
// A host read answers within its deadline (HOST_DEADLINE_MS unless given) or fails: one that never settles would
// otherwise hold every later check of the context, and the tool calls and prompts queued behind them. The bound is far
// above a real read (a 3.6 MB conversation serialises in under 10 ms) and well inside a hook's 10 s budget, which a
// clock wait spends. A host without a clock has no deadline.
const HOST_DEADLINE_MS = 2_000;
async function hostCall($, pending, deadline = HOST_DEADLINE_MS) {
  let stop, waiting;
  try {
    stop = new AbortController();
    waiting = $.clock.sleep(deadline, { signal: stop.signal });
  } catch { return pending; }
  // A wait the host itself ends early (a reload) leaves the read without a deadline rather than failing it.
  try { return await Promise.race([pending, waiting.then(() => pastDeadline(deadline), () => pending)]); }
  finally { stop.abort(); }
}
function pastDeadline(deadline) {
  throw Object.assign(new Error(`no answer within ${deadline} ms`), { deadline: true });
}
function holdServed(ctx, rules) {
  const held = ctx.held;
  ctx.held = null;
  if (!held) return;
  for (const rule of rules) {
    if (!servedAs(ctx, rule) && holdsRule(held, rule)) ctx.served.set(rule.name, { count: 1, at: Date.now(), identity: rule.identity });
  }
}
function holdsRule(held, rule) {
  return held.includes(JSON.stringify(block(rule)).slice(1, -1)) ||
    held.includes(JSON.stringify(block({ ...rule, content: rule.fileContent })).slice(1, -1));
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
    return loadedRules($, ctx.rules);
  }
  if (ctx.loading?.root !== root) ctx.loading = { root, promise: load($, root, found.fallback) };
  const pending = ctx.loading;
  let rules;
  try { rules = await pending.promise; }
  catch (error) { if (ctx.loading === pending) { ctx.loading = null; } throw error; }
  // Only the newest load publishes: one overtaken by a later root, or cleared by a compaction, keeps its result local.
  if (ctx.loading === pending) { ctx.loading = null; publish(ctx, root, rules); }
  return loadedRules($, rules);
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
// A rejected host write may have left a partial: empty it so readers count no rows; Node startup later removes it.
async function removePartial($, path, error) {
  try { await $.fs.write(path, ''); }
  catch (neutralisation) {
    let left = true;
    try { left = await $.fs.exists(path); } catch { /* Unknown: reported as left. */ }
    if (left) throw new Error(`archive write failed (${error.message}) and its partial file ${path} could not be neutralised: ${neutralisation.message}`, { cause: neutralisation });
  }
  throw error;
}
// Every complete archive stays, whatever happens next: a store write rejected after it may have committed, and readers
// count each segment once (verdict rows by id), so a copy left both archived and live is never counted twice.
async function writeArchives($, name, evicted) {
  const directory = await qualityDirectory($);
  const written = [];
  for (const text of archiveTexts(name, evicted, undefined, { splitId: newSeg })) {
    const path = await freshArchivePath($, directory, familyOf(name));
    try { await $.fs.write(path, text); }
    catch (error) { await removePartial($, path, error); }
    written.push(path);
  }
  return { directory, written };
}
// Archive what the budget pushes out, then write. A rejected write is returned with the value it tried, so a retry
// starts from that value and never archives the same part twice.
async function setBounded($, name, value, budget, keep) {
  const { value: planned, evicted } = shrink(name, value, budget, keep);
  if (evicted) await writeArchives($, name, evicted);
  // The host get/set/keys API has no verified atomic merge. Refresh after any intervening sweep/archive I/O.
  const kept = name === 'identityActivity' ? await freshIdentityActivity($, planned, budget, keep) : planned;
  try { await $.store.set(name, kept); }
  catch (error) { return { kept, error }; }
  return { kept };
}
async function freshIdentityActivity($, value, budget, keep) {
  let incoming = value;
  for (let attempt = 0; attempt < 3; attempt++) {
    const live = await $.store.get('identityActivity');
    const merged = joinIdentityActivity(live, incoming);
    const plan = shrink('identityActivity', merged, budget, keep);
    if (!plan.evicted) return plan.value;
    await writeArchives($, 'identityActivity', plan.evicted);
    const latest = await $.store.get('identityActivity');
    if (JSON.stringify(latest) === JSON.stringify(live)) return plan.value;
    incoming = joinIdentityActivity(merged, latest);
  }
  throw new Error('identity activity changed repeatedly while archiving; retry later');
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
// A write refused (for any reason but size) after its archives were written leaves the store at the value before it,
// while the archives already hold what it added. The next write of that key starts from the value this one tried, as
// long as the store still holds what it held at the refusal: rebuilding on the rolled-back value would count again, from
// the old count, what the archive already counts (a counter's copies join by maximum). A store changed in between by
// another writer is taken as it is.
const unsaved = new Map();
async function remember($, name, value) {
  try { unsaved.set(name, { base: JSON.stringify((await $.store.get(name)) ?? null), value }); }
  catch { unsaved.delete(name); }
}
async function readKey($, name) {
  const value = await $.store.get(name);
  const carried = unsaved.get(name);
  if (!carried) return value;
  if (JSON.stringify(value ?? null) === carried.base) return JSON.parse(JSON.stringify(carried.value));
  unsaved.delete(name);
  return value;
}
// The one write path of a budgeted key. A size refusal (another writer grew the store) sweeps every key, then retries
// under a budget halved each time: more moves to the archives, nothing is dropped. Any other failure is thrown as is.
async function setWithin($, name, value, keep = null) {
  if (!Object.hasOwn(STORE_BUDGETS, name)) throw new Error(`store key without a budget: ${name}`);
  if (!storeSwept) await sweepQuietly($, name);
  let failure, current = value;
  for (let budget = STORE_BUDGETS[name]; budget >= MIN_BUDGET; budget = Math.floor(budget / 2)) {
    const { kept, error } = await setBounded($, name, current, budget, keep);
    if (!error) { unsaved.delete(name); return kept; }
    failure = error;
    current = kept;
    if (!isSizeRefusal(error)) break;
    if (budget === STORE_BUDGETS[name]) await sweepQuietly($, name);
  }
  await remember($, name, current);
  throw failure;
}
const HEALTH_FIELDS = ['calls', 'errors', 'totalMs', 'maxMs', 'slow'];
// A stored day may come from an older shape: every counter missing, non-numeric or negative starts at zero.
const healthDay = (counts) => Object.fromEntries(HEALTH_FIELDS.map((field) => [field, Number.isFinite(counts?.[field]) && counts[field] >= 0 ? counts[field] : 0]));
// A stored error entry without a timestamp string cannot be ordered, so it is dropped rather than blocking every flush.
const healthErrors = (entries) => (Array.isArray(entries) ? entries : []).filter((entry) => typeof entry?.at === 'string');
function mergeHealth(target, batch) {
  mergeFlightHealth(target, batch);
  for (const [day, counts] of Object.entries(batch.days)) {
    const entry = target.days[day] ?? healthDay(null);
    for (const field of ['calls', 'errors', 'totalMs', 'slow']) entry[field] += counts[field];
    entry.maxMs = Math.max(entry.maxMs, counts.maxMs);
    target.days[day] = entry;
  }
  appendValues(target.lastErrors, batch.lastErrors);
  target.lastErrors = target.lastErrors.sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
  if (Object.hasOwn(target, 'calls')) target.calls += batch.calls;
}
// An error recorded while a health flush writes (its sweep or archive failing, say) is kept for the next flush and never
// schedules one: otherwise a store that cannot archive turns each failed flush into the next one, without end.
let healthFlushing = 0;
async function flushHealth($) {
  const turn = writeTurn();
  await turn.previous.catch(() => {});
  healthFlushing++;
  try {
    if (!pendingHealth.calls && !pendingHealth.lastErrors.length && !pendingHealth.interruptedCalls?.length) return;
    const batch = pendingHealth;
    pendingHealth = emptyHealth();
    try {
      const stored = await $.store.get('health');
      const health = { days: Object.fromEntries(Object.entries(stored?.days ?? {}).map(([day, counts]) => [day, healthDay(counts)])),
        lastErrors: healthErrors(stored?.lastErrors) };
      mergeFlightHealth(health, stored);
      mergeHealth(health, batch);
      health.days = Object.fromEntries(Object.entries(health.days).sort().slice(-31));
      health.lastErrors = health.lastErrors.slice(-20);
      await setWithin($, 'health', health);
      await recordHealthActivity($, batch, health);
      lastHealthFlush = Date.now();
    } catch (error) {
      mergeHealth(pendingHealth, batch);
      throw error;
    }
  } finally { healthFlushing--; turn.release(); }
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
  if (error && healthFlushing) return Promise.resolve();
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
// Iteration keeps input-sized arrays out of a function's argument list.
function appendValues(target, values) {
  for (const value of values) target.push(value);
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
    else if (kind === 'dir') appendValues(files, await staticRules($, path, depth + 1, visited));
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
function loadRootCandidates(root, config, linked, fallback) {
  const { mainRepoRoot = null, worktreeRoot = null } = linked;
  let candidates = projectRuleRoots(root, { configDir: config, mainRepoRoot, worktreeRoot });
  if (!candidates.length && fallback) candidates = [root];
  return candidates;
}
const projectScope = (real, configReal) => real !== null && !sameDirectory(real, configReal);

// Synchronous plans expose the existing awaited operations without adding a helper's async completion turn.
function* loadRuleCopies($, locations, copies, staticFiles, physicalDirs, rules) {
  for (const [scope, dir] of locations) {
    for (const entry of yield list($, dir)) {
      const file = `${dir}/${entry.name}`;
      const kind = yield entryKind($, file, entry);
      if (kind !== 'file' || !entry.name.endsWith('.md')) continue;
      if (!copies.has(entry.name)) copies.set(entry.name, []);
      copies.get(entry.name).push({ scope, dir, file });
    }
  }
  for (const [name, found] of copies) yield* loadWinner($, name, found, staticFiles, physicalDirs, rules);
}

function* loadWinner($, name, found, staticFiles, physicalDirs, rules) {
  const winner = found.at(-1);
  try {
    const text = yield readCapped($, winner.file);
    for (const outer of found.slice(0, -1)) {
      const other = yield readCapped($, outer.file).catch(() => null);
      if (other !== null && ruleBody(other, true) !== ruleBody(text, true)) yield notice($, `shadowed: ${outer.file} by ${winner.file}`);
    }
    let suppressed = false;
    for (const item of staticFiles.filter((candidate) => candidate.name === name)) {
      const equal = sameRule(yield $.fs.read(item.path), text);
      if (equal) suppressed = true;
      yield notice($, equal ? `loaded twice: ${item.path} and ${winner.file}; the on-demand copy is not served` : `same name, different rule: ${item.path} and ${winner.file}`);
    }
    if (suppressed) return;
    if (!physicalDirs.has(winner.dir)) physicalDirs.set(winner.dir, yield realPathOf($, winner.dir));
    rules.push({ ...parseRuntimeRule(name, text), generation: migrationGeneration(text), identity: `${winner.scope}:${physicalDirs.get(winner.dir)}:${name}` });
  } catch (error) { yield notice($, `skipped ${winner.file}: ${error.message}`).catch(() => {}); }
}

async function load($, root, fallback = false) {
  const env = { CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'), HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE') };
  const config = rememberFlightConfig(configDirectory(env));
  if (!config) { await notice($, 'HOME and USERPROFILE unavailable; cannot locate user rules'); return []; }
  const candidates = loadRootCandidates(root, config, await linkedWorktree($, root), fallback);
  const configReal = await realPathOf($, config);
  activityProfile = configReal;
  // One stat per ancestor: an absent `.claude` costs nothing more, and one that IS the config directory is user scope.
  const roots = [];
  for (const dir of candidates) {
    const claude = dotEntry(dir, '.claude');
    const real = await $.fs.stat(claude, { resolve: true }).then((info) => info.realPath ?? claude, () => null);
    if (projectScope(real, configReal)) roots.push(dir);
  }
  const user = ruleDirectories(root, config);
  const staticDirs = [...roots.map((item) => ruleDirectories(item, config).projectStatic), user.userStatic];
  const staticFiles = [];
  for (const dir of staticDirs) appendValues(staticFiles, await staticRules($, dir));
  // Every copy of a name, user first, then project directories root first: the last one is the nearest, and wins.
  const copies = new Map();
  const physicalDirs = new Map();
  const rules = [];
  const locations = [['user', user.user], ...roots.map((item) => ['project', ruleDirectories(item, config).project])];
  const plan = loadRuleCopies($, locations, copies, staticFiles, physicalDirs, rules);
  let step = plan.next();
  while (!step.done) {
    let value;
    try { value = await step.value; }
    catch (error) { step = plan.throw(error); continue; }
    step = plan.next(value);
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
// Synchronous matching never runs longer than this before handing control back to the shared hooks worker, which can only answer its host ping at an await.
const SLICE_MS = 50;
async function breathe($, slice, budget) {
  if (Date.now() - slice.start < SLICE_MS) return;
  // Only a synchronous throw means "this host has no clock"; a rejection (abort, reload) is the host speaking and propagates.
  // Time spent yielding belongs to other agents' work, so it is not charged to this event's regex budget.
  let pending;
  try { pending = $.clock.sleep(0); } catch { return; }
  const started = budget?.pause();
  try { await pending; } finally { budget?.resume(started); }
  slice.start = Date.now();
}
function detectorAllowed(ctx, rule, trigger, prompt, errors, budget) {
  if (!detectorNeeded(ctx, rule) || prompt) return false;
  if (budget.exhausted) {
    errors.push({ rule: rule.name, kind: 'tool', pattern: trigger.detector, error: 'shared regex call budget exhausted; detector unevaluated' });
    return false;
  }
  return true;
}
const detectorNeeded = (ctx, rule) => eligible(ctx, rule) || ctx.refusing.has(rule.name)
  || Boolean(rule.compliance?.kind === 'model' && servedAs(ctx, rule));

function detectorInput(trigger, item, report, budget, failure) {
  if (item.input === null) return false;
  const inputMatches = testTriggerRegex(trigger, trigger.input, item.input, report, budget);
  item.inputPrechecked.set(trigger, !failure.failed && inputMatches);
  if (failure.failed || !inputMatches || budget.exhausted) return false;
  return true;
}

function detectorPrechecked(ctx, rule, trigger, e, prompt, { item, errors, budget }) {
  if (!detectorAllowed(ctx, rule, trigger, prompt, errors, budget)) return false;
  const failure = { failed: false };
  const report = (error) => { failure.failed = true; errors.push({ rule: rule.name, ...error }); };
  const tool = testTriggerRegex(trigger, trigger.tool, e.tool, report, budget);
  item.prechecked.set(trigger, !failure.failed && tool);
  if (failure.failed || !tool || budget.exhausted) return false;
  if (trigger.input) return detectorInput(trigger, item, report, budget, failure);
  return true;
}

function recordExhaustedRule(rule, item, budget, beforeMatched) {
  budget.unresolved.add(rule.name);
  if (exhaustionRefuses(rule, item)) beforeMatched?.add(rule.name);
}

function recordTriggerMatch(trigger, rule, beforeMatched, budget) {
  if (trigger.beforeFirstAct) beforeMatched?.add(rule.name);
  return !beforeMatched && !budget.exhausted;
}

function selectedTrigger(rule, trigger, item, errors, budget, beforeMatched) {
  if (budget.exhausted) {
    errors.push({ rule: rule.name, ...unevaluatedTrigger(trigger, item) });
    recordExhaustedRule(rule, item, budget, beforeMatched);
    return 'stop';
  }
  let matched = false;
  if (triggerMatches(trigger, item, (error) => errors.push({ rule: rule.name, ...error }), budget)) {
    matched = true;
    if (recordTriggerMatch(trigger, rule, beforeMatched, budget)) return 'stop';
  }
  if (budget.exhausted && !trigger.detector) {
    recordExhaustedRule(rule, item, budget, beforeMatched);
    return 'stop';
  }
  return matched ? 'matched' : null;
}

const detectorFailure = (rule, trigger, error) => ({ rule: rule.name, kind: 'tool', pattern: trigger.detector, error: `detector failed: ${error.message ?? error}` });

async function selected($, ctx, rules, e, prompt, { errors, budget, beforeMatched, slice }) {
  const item = { ...triggerItem(e, prompt), detected: new Map(), prechecked: new Map(), inputPrechecked: new Map() };
  const chosen = [];
  for (const rule of rules) {
    await breathe($, slice, budget);
    let matched = false;
    for (const trigger of rule.triggers) {
      if (trigger.detector) {
        if (!detectorPrechecked(ctx, rule, trigger, e, prompt, { item, errors, budget })) continue;
        const started = budget.pause();
        try { item.detected.set(trigger, await lspSymbolGrep($, e, ctx) === true); }
        catch (error) { errors.push(detectorFailure(rule, trigger, error)); }
        finally { budget.resume(started); }
        if (item.detected.get(trigger) !== true) continue;
      }
      const status = selectedTrigger(rule, trigger, item, errors, budget, beforeMatched);
      if (status) matched = true;
      if (status === 'stop') break;
    }
    if (matched) chosen.push(rule);
  }
  return chosen;
}
const exhaustionNotice = (budget) => `wt-rules-on-demand: shared regex budget exhausted: ${budget.unresolved.size} rules served unevaluated`;
const block = (rule) => `<rule name="${rule.name}">\n${rule.content}\n</rule>`;
async function sessionId($) {
  try {
    const id = await $.session.id();
    flightSession ??= id;
    return id;
  } catch { return null; }
}
const summary = (e) => e.tool === 'Bash' ? `Bash: ${bounded(e.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}`
  : `${e.tool}: ${String(pathOf(e)).split(/[\\/]/).at(-1) || 'call'}`;

function journalOptions(options) {
  const { channel = 'tool.call', triggerErrors = [], close: closeMark } = options;
  return { channel, triggerErrors, closeMark };
}
const journalEmpty = (names, suppressed, acts, injected, triggerErrors, closeMark) =>
  !names.length && !suppressed.length && !acts.length && !injected.length && !triggerErrors.length && !closeMark;
const storedObject = (value) => value ?? {};

function journalServed(served, names, now, channel) {
  for (const rule of names) {
    const name = typeof rule === 'string' ? rule : rule.name;
    const item = served[key(name)] ?? { count: 0, byChannel: {}, seg: newSeg() };
    item.count++; item.last = now; item.byChannel[channel] = (item.byChannel[channel] ?? 0) + 1;
    served[key(name)] = item;
  }
}

function journalSession(sessions, id, now, loop) {
  const session = sessions[id] ?? { first: now, contexts: {} };
  session.last = now;
  const ck = loop === MAIN ? String(currentMain) : `agent:${loop}`;
  const ctx = session.contexts[ck] ?? { served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [], seg: newSeg() };
  ctx.last = now;
  return { session, ck, ctx };
}

function journalRuleCounts(ctx, rules, field, identities) {
  for (const rule of rules) {
    const name = typeof rule === 'string' ? rule : rule.name;
    ctx[field][key(name)] = (ctx[field][key(name)] ?? 0) + 1;
    if (rule.identity) { ctx[identities] ??= {}; ctx[identities][rule.identity] = (ctx[identities][rule.identity] ?? 0) + 1; }
  }
}

function journalActs(ctx, acts, now) {
  for (const rule of acts) {
    const existing = ctx.governedActs.find((item) => item.ruleIdentity === rule.identity);
    if (existing) { existing.count++; existing.last = now; }
    else ctx.governedActs.push({ rule: rule.name, ruleIdentity: rule.identity, at: now, last: now, count: 1 });
  }
}

function journalContext(ctx, names, { suppressed, acts, injected }, { triggerErrors, now, channel, closeMark }) {
  journalRuleCounts(ctx, names, 'served', 'servedIdentity');
  journalRuleCounts(ctx, suppressed, 'suppressedCap', 'suppressedIdentity');
  journalActs(ctx, acts, now);
  for (const pending of injected) ctx.complianceInjected.push({ rule: pending.rule.name, ruleIdentity: pending.rule.identity, at: now, ...deliveryFields(pending) });
  if (advancesClose(ctx.lastClose, closeMark)) ctx.lastClose = { token, seq: closeMark.seq, at: now };
  journalReset(ctx, closeMark);
  if (triggerErrors.length) {
    ctx.triggerErrors ??= [];
    // IDs belong to this event, not to stored history: a refused write must not issue the same ID twice.
    appendValues(ctx.triggerErrors, triggerErrors.map((error) => ({ ...error, at: now, channel, eid: newSeg() })));
    // Retain every error from this call, even when a mass serve exceeds the usual history cap; older rows yield first.
    ctx.triggerErrors = ctx.triggerErrors.slice(-Math.max(100, triggerErrors.length));
  }
}

// A close that reset the served set counts under its reason: 'compaction' when session.compact reached this plugin,
// 'compaction-detected' when the live window showed one it was never told about.
function journalReset(ctx, closeMark) {
  if (!closeMark?.reason) return;
  ctx.resets = { ...ctx.resets, [closeMark.reason]: (ctx.resets?.[closeMark.reason] ?? 0) + 1 };
}

async function journal($, names, loop, suppressed = [], acts = [], injected = [], options = {}) {
  const { channel, triggerErrors, closeMark } = journalOptions(options);
  if (journalEmpty(names, suppressed, acts, injected, triggerErrors, closeMark)) return;
  noteIdentityActivity(names, 'servedAt');
  const turn = writeTurn();
  await turn.previous.catch(() => {});
  try {
    try {
      const now = new Date().toISOString();
      const served = storedObject(await readKey($, 'served'));
      journalServed(served, names, now, channel);
      if (names.length) await setWithin($, 'served', served);
      const id = await sessionId($);
      if (!id) return;
      const sessions = storedObject(await readKey($, 'sessions'));
      const { session, ck, ctx } = journalSession(sessions, id, now, loop);
      journalContext(ctx, names, { suppressed, acts, injected }, { triggerErrors, now, channel, closeMark });
      session.contexts[ck] = ctx;
      sessions[id] = session;
      // Over its budget, the oldest contexts move to an archive file first; this context moves last.
      await setWithin($, 'sessions', sessions, { id, ck, newSeg });
    } catch (error) { await notice($, `journal write failed: ${error.message}`).catch(() => {}); }
  } finally { turn.release(); }
}
 async function verdict($, pending, loop, value, evidence, reason, act = {}) {
   const { rule } = pending;
   const { seq: actSeq, discharged = [], noAct } = act;
   const verdictId = `${token}-${++sequence}`;
   const record = { rule: rule.name, ruleIdentity: rule.identity, trigger: pending.trigger, verdict: value, evidence: String(evidence).slice(0, 160), sessionId: await sessionId($), agentId: loop === MAIN ? null : loop, injectedAt: pending.injectedAt, decidedAt: new Date().toISOString(), verdictId, actSeq,
      applicability: applicability(value, noAct), ...measurementFields(pending),
      ...(pending.deliveryId ? deliveryFields(pending) : {}), ...(discharged.length ? { discharged: discharged.map(deliveryFields) } : {}), ...(reason ? { reason } : {}) };
   const turn = writeTurn();
   await turn.previous.catch(() => {});
   try {
    const old = String(await readKey($, VERDICTS) ?? '');
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
    catch (failure) { error = failure; appendValues(remaining, windows.slice(index)); break; }
  }
  ctx.pending = remaining;
  return { actions, error };
}
function decideWindow(pending, e, measured, actions, remaining) {
  const c = pending.rule.compliance;
  consumeInitialModelAct(pending, measured);
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
function consumeInitialModelAct(pending, measured) {
  // A prompt/refusal window's first following call supplies its original act;
  // opening a later window for that same call would count the retry twice.
  if (pending.rule.compliance.kind === 'model' && !pending.later && !pending.calls.length) measured.add(pending.rule.name);
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
      records.push({ pending, value, evidence: summary(e), reason: error?.message ?? (matches ? undefined : 'window closed'), noAct: noNextAct(matches, error) });
    }
  }
  return records;
}
const noNextAct = (matches, error) => !matches && !error;
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
  if (emptyModelWindow(c, pending)) {
    await safeVerdict($, pending, loop, c.onClose, 'no following calls', reason, { seq: actSeq, noAct: true });
    return;
  }
  if (c.kind === 'model') {
    try {
       const v = await $.model.classify([pending.rule.content, c.prompt, ...pending.calls.map((call) => call.detail)].join('\n'), ['followed', 'not followed', 'not applicable'], { model: c.model });
         await safeVerdict($, pending, loop, v || 'unknown', pending.calls.map((call) => call.summary).join(' | ') || 'no following calls', v === 'not applicable' ? c.onClose : undefined, { seq: actSeq });
       } catch (error) { await safeVerdict($, pending, loop, 'unknown', '', error.message, { seq: actSeq }); }
      } else await safeVerdict($, pending, loop, c.onClose, pending.calls.at(-1)?.summary ?? 'no governed act', reason, { seq: actSeq, noAct: true });
}
const emptyModelWindow = (c, pending) => c.kind === 'model' && !pending.calls.length;
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
       rememberDelivery(ctx, rule, pending);
       if (rule.compliance.kind === 'next-call') { pending.terminal = false; ctx.nextWindows.add(pending); }
      else ctx.pending.push(pending);
    }
    return opened;
}
function rememberDelivery(ctx, rule, pending) {
  const state = servedAs(ctx, rule);
  if (state) state.deliveryId = pending.deliveryId;
}
function perActPending(ctx, rule, e, first = false) {
  return { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString(),
    later: !first, servedDeliveryId: servedAs(ctx, rule)?.deliveryId ?? null };
}
function openLaterModels(ctx, chosen, ride, e, measured) {
  for (const rule of chosen) {
    if (rule.compliance?.kind !== 'model' || ride.includes(rule) || measured.has(rule.name) || !servedAs(ctx, rule)) continue;
    ctx.pending.push({ ...perActPending(ctx, rule, e), remaining: rule.compliance.window,
      calls: [{ detail: `${e.tool}: ${bounded(textOf(e) ?? '')}`, summary: summary(e) }], testSeen: false });
  }
}
 async function closeCorrelation($, ctx, loop, actSeq) {
  const events = [...ctx.correlation, { kind: 'turn' }];
  const slice = { start: Date.now() };
    for (const rule of ctx.rules ?? []) if (await breathe($, slice), rule.compliance?.kind === 'turn-correlation' && servedAs(ctx, rule)) {
      try { for (const item of correlateTurn(rule.compliance, events)) await safeVerdict($, correlationPending(ctx, rule), loop, item.verdict, item.id, item.detail, { seq: actSeq }); }
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
  ctx.detectedSinceServe = false;
  for (const rule of rules) { const state = servedAs(ctx, rule); ctx.served.set(rule.name, { count: (state?.count ?? 0) + 1, at: Date.now(), identity: rule.identity }); }
}

function reserveRequested(options) {
  return options?.time_reserve === true || options?.time_reserve === '1' || (typeof process !== 'undefined' && process.env?.WT_ROD_TIME_RESERVE === '1');
}

function reserveEnvironmentLimit() {
  return Number(typeof process !== 'undefined' ? process.env?.WT_ROD_MAX_PER_CONTEXT : NaN);
}

function configureReserve(options) {
  reserve = reserveRequested(options);
  // Read the environment even when reserve is off, preserving registration order.
  const envLimit = reserveEnvironmentLimit();
  // Host userConfig defaults arrive as explicit options: max_per_context only applies with time_reserve.
  limit = 1;
  if (reserve) {
    limit = 3;
    const configured = Number(options?.max_per_context);
    if (Number.isInteger(configured) && configured > 0) limit = configured;
    if (Number.isInteger(envLimit) && envLimit > 0) limit = envLimit;
  }
}

/** @type {import('claude-code').Register} */
export const register = (on, options, clock = Date.now) => {
  token = newToken();
  activityProfile = null;
  activityWrites.clear();
  pendingActivity.clear();
  activityRetryAt = 0;
  triggerClock = clock;
  enabled = options?.enabled === true;
  resetAgentTypes();
  agentTypeSetting = UNREAD;
  configureReserve(options);
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
  on('agent.spawn', agentSpawnEvent);
};

let triggerClock = Date.now;

// The hooks module runs without Node.js globals, and register() receives no $: the project's settings env reaches it
// only through the host's environment API, called inside a hook. The list is therefore read when a spawn or a refusal
// needs it, and the learned types are reset whenever the parsed set changes.
const UNREAD = Symbol('unread');
let agentTypeSetting = UNREAD;
let agentTypeRead = 0;
let agentTypeApplied = 0;
async function agentTypeOptOutActive($) {
  const ticket = ++agentTypeRead;
  let value;
  try { value = await hostCall($, $.env.get('WT_ROD_NO_REFUSE_AGENT_TYPES')); } catch { value = undefined; }
  if (ticket < agentTypeApplied) return agentTypeOptOutConfigured();
  agentTypeApplied = ticket;
  if (value !== agentTypeSetting) {
    agentTypeSetting = value;
    configureAgentTypes(value);
  }
  return agentTypeOptOutConfigured();
}

async function agentSpawnEvent($, e, next) {
  if (!enabled) return next(e);
  const active = agentTypeOptOutActive($).catch(() => false);
  const result = await next(e);
  let id;
  try {
    if (!result || result.deny !== undefined) return result;
    id = result.agentId ?? e.resume?.agentId;
    if (await active && agentTypeOptOutConfigured()) recordAgentType(id, e.subagentType);
  } catch { forgetAgentType(id); }
  return result;
}

async function lookupAgentType($, id, entry) {
  const version = entry.version;
  let type = null;
  try { type = (await hostCall($, $.agent.list())).find((agent) => agent.id === id)?.type ?? null; }
  catch { /* Missing evidence is retried on the next refusable call. */ }
  if (pendingAgentType(id) !== entry) return knownAgentType(id);
  if (entry.version !== version) { finishAgentLookup(id, entry); return knownAgentType(id); }
  if (typeof type === 'string' && type) rememberAgentType(id, type);
  finishAgentLookup(id, entry);
  return type;
}

async function refusalsForAgent($, e, before) {
  if (!before.length || agentLoop(e.agentId) === MAIN || !(await agentTypeOptOutActive($))) return before;
  let type = knownAgentType(e.agentId);
  if (type === undefined) {
    let entry = pendingAgentType(e.agentId);
    if (!entry) {
      entry = beginAgentLookup(e.agentId);
      entry.promise = lookupAgentType($, e.agentId, entry);
    }
    type = await entry.promise;
  }
  if (!neverRefuseType(type)) return before;
  await progress($, `wt-rules-on-demand: waiving before-act refusal for agent type ${type}; serving ${before.map((rule) => rule.name).join(', ')} with the result`);
  if ((knownAgentType(e.agentId) ?? null) !== type) return before;
  return [];
}

// Only the host-facing promise settles on abort; the body retains its real lifetime.
async function settleHook(signal, body) {
  let abandon;
  const settled = new Promise((resolve, reject) => {
    abandon = () => resolve();
    // Keep observing rejection even after abandonment.
    body.then(resolve, reject);
    signal.addEventListener('abort', abandon, { once: true });
    if (signal.aborted) abandon();
  });
  try { return await settled; }
  finally { signal.removeEventListener('abort', abandon); }
}

async function abortableEvent($, e, next, work) {
  const signal = next.signal;
  if (signal?.aborted) return;
  const body = trackedEvent($, e, next, work);
  if (!signal) return body;
  return settleHook(signal, body);
}

async function trackedEvent($, e, next, work) {
  if (!enabled) return next(e);
  const start = Date.now();
  const flight = beginFlight(e, work, start);
  // Dispatch immediately from a named async host step; never wait for the write.
  if (flight?.path) flight.writes = runFlightPlan($, entryFlight(flight));
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
  } finally {
    queueFlightPhase($, flight, finallyFlight(flight));
    void scheduleFlights($);
    try {
      await loadedRules($, [...contexts.values()].flatMap((ctx) => ctx.rules ?? []));
      await flushIdentityActivity($);
      noteFlightCall(pendingHealth, flight, Date.now() - start);
      await recordHealth($, Math.max(0, Date.now() - start - downstreamMs - healthMs), null, work).catch(() => {});
    } finally { queueFlightPhase($, flight, completeFlight(flight)); }
  }
}
async function promptContextEvent($, e, next) { return abortableEvent($, e, next, 'prompt.context'); }
async function sessionCompactEvent($, e, next) { return abortableEvent($, e, next, 'session.compact'); }
async function promptSubmitEvent($, e, next) { return abortableEvent($, e, next, 'prompt.submit'); }
async function turnCompleteEvent($, e, next) { return abortableEvent($, e, next, 'turn.complete'); }
async function toolCallEvent($, e, next) { return abortableEvent($, e, next, 'tool.call'); }

async function promptContextWork($, e, next) {
    if (enabled) {
      // Under the host-read deadline: a history that never answers keeps the current context rather than hold the prompt.
      try { if (!(await hostCall($, $.session.messages())).some((message) => message?.role === 'assistant')) { contexts.delete(MAIN); currentMain++; } } catch { /* Message history may be unavailable at startup. */ }
       await rulesFor($, await context($, MAIN), e.cwd ?? '.');
    }
    return next(e);
}
async function sessionCompactWork($, e, next) {
  const result = await next(e);
  if (!result || typeof result !== 'object' || !('skip' in result)) {
    const loop = agentLoop(e.agentId), ctx = contexts.get(loop);
    if (ctx) await inQueue(ctx, dispatchedReset($, ctx, loop, ctx.detecting));
  }
  return result;
}
// Both resets share one queue per context, and one compaction resets once: after a detected reset with nothing served
// since, the dispatched session.compact of that same compaction skips. A dispatched compaction of the main loop also
// expects its own boundary row in the transcript, written just after it: it asks the re-scan plan to find it, and the
// next new boundary is that one while the plan lives. Every other dispatched compaction, and every other new boundary,
// resets (the rules are loaded again).
async function dispatchedReset($, ctx, loop, previous) {
  try { await previous; } catch { /* The earlier event reported its own failure. */ }
  if (ctx.detectedSinceServe) return;
  await resetServed($, ctx, loop, 'compaction');
  if (loop !== MAIN) return;
  ctx.expected.push(monotonic() + RESCAN_LIFETIME_MS);
  requestRescan($, ctx, true);
}
// Close what the context measured and forget what it served: the next event loads its rules again and serves them as in a
// fresh context. Shared by the dispatched compaction and the detected one; `reason` tells the journal which.
// After it, the next live-window reading is the new baseline.
async function resetServed($, ctx, loop, reason) {
  const actSeq = ++sequence;
  await closePending($, ctx, loop, reason, actSeq);
  await closeCorrelation($, ctx, loop, actSeq);
  await journal($, [], loop, [], [], [], { close: { seq: actSeq, reason } });
  ctx.rules = null;
  ctx.loading = null;
  if (ctx.filling) await ctx.filling;
  ctx.held = null;
  ctx.served.clear();
  ctx.lspServed = null;
  ctx.prompting = new Map(ctx.prompting);
  ctx.detectedSinceServe = reason !== 'compaction';
  ctx.windowTokens = undefined;
  ctx.absentSigned = false;
}
// A host may forward session.compact (and prompt.context) past every plugin a person installs, so a compaction can reach
// the main loop untold. The host still records it: a `compact_boundary` row in the session's transcript. When the main
// context is created, the main loop notes where the transcript ends; it then reads only the rows added since, at every
// turn end and, earlier, when the live window gives a sign (its input tokens absent, until the first response after a
// compaction, or lower than the last reading that had them); a boundary it has not seen before resets the context.
// Agent contexts are not checked: they end with their turn.
// Checks and both resets run one at a time per context: a parallel call admitted while a reset runs waits for it.
async function detectCompaction($, ctx, loop, verify) {
  if (loop !== MAIN) return;
  await inQueue(ctx, chainCompactionCheck($, ctx, ctx.detecting, verify));
}
async function inQueue(ctx, step) {
  ctx.detecting = step;
  try { await step; } finally { if (ctx.detecting === step) ctx.detecting = null; }
}
// A named async step, not a closure: the host validator refuses $ captured in a function expression.
async function chainCompactionCheck($, ctx, previous, verify) {
  try { await previous; } catch { /* The earlier event reported its own failure. */ }
  return compactionCheck($, ctx, verify);
}
// The context noted where the transcript ended when it was created (fillContext). A sign whose scan finds nothing new asks
// the re-scan plan: the host writes the boundary row a little after the compaction ends.
async function compactionCheck($, ctx, verify) {
  if (ctx.cursor === undefined) await openCursor($, ctx);
  const sign = await windowShrank($, ctx, verify);
  if (!scanDue(ctx, sign, verify)) return;
  const fresh = await newBoundaries($, ctx);
  if (verify) ctx.turns++;
  if (sign && fresh?.length === 0) requestRescan($, ctx, false);
}
// The turn end always scans (and lifts a paused preparation). Mid-turn, the first sign of a turn scans, and so does the
// first event of a turn while a rule counts as served (held in the conversation, or served since) and no reading has
// completed since the last turn end: a boundary written after the turn-end scan, with no sign, never lets a served rule
// be withheld. At most one such scan per turn.
function scanDue(ctx, sign, verify) {
  if (verify) {
    ctx.midTurnScan = false;
    scanStalled = false;
    return true;
  }
  const firstSign = sign && !ctx.midTurnScan;
  if (firstSign) ctx.midTurnScan = true;
  const confirm = ctx.confirmedTurn !== ctx.turns && (ctx.served.size > 0 || Boolean(ctx.held?.includes('<rule name=')));
  if (confirm) ctx.confirmedTurn = ctx.turns;
  return firstSign || confirm;
}
async function boundaryReset($, ctx, fresh) {
  const now = monotonic(), expected = ctx.expected.filter((until) => until > now);
  const consumed = Math.min(expected.length, fresh.length);
  ctx.expected = expected.slice(consumed);
  if (fresh.length === consumed) return;
  await resetServed($, ctx, MAIN, 'compaction-detected');
  await progress($, 'wt-rules-on-demand: compaction detected; rules are served again');
}
// The re-scan plan serves the compactions that asked for it: a sign whose scan found nothing, and each dispatched
// compaction. A request made while it lives joins it (a dispatched one adds one boundary to wait for; a sign adds
// none, being no certain compaction). It scans after each back-off wait, and ends as soon as it found as many new
// boundaries as it waits for, or once RESCAN_LIFETIME_MS of monotonic time has passed since it started, however long its
// scans took, or when its context is replaced. A turn end never ends it, and the expectation of a dispatched compaction
// lives exactly as long.
const RESCAN_BACKOFF_MS = [100, 200, 400, 800, 1600, 3200];
const RESCAN_LIFETIME_MS = 10_000;
const monotonic = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
const planLive = (plan) => Boolean(plan) && !plan.ended && monotonic() - plan.startedAt < RESCAN_LIFETIME_MS;
const planServed = (ctx, plan) => ctx.found - plan.foundAt >= plan.requests;
const rescanWanted = (ctx, plan) => ctx.plan === plan && contexts.get(MAIN) === ctx && planLive(plan) && !planServed(ctx, plan);
function requestRescan($, ctx, dispatched) {
  const live = ctx.plan;
  if (planLive(live) && !planServed(ctx, live)) {
    if (dispatched) live.requests++;
    return;
  }
  const plan = { requests: 1, foundAt: ctx.found, startedAt: monotonic() };
  ctx.plan = plan;
  void rescanPlan($, ctx, plan);
}
async function rescanPlan($, ctx, plan) {
  try {
    for (const ms of RESCAN_BACKOFF_MS) {
      try { await $.clock.sleep(ms); } catch { return; }
      if (!rescanWanted(ctx, plan)) return;
      await inQueue(ctx, chainRescan($, ctx, ctx.detecting, plan));
    }
  } finally { plan.ended = true; }
}
async function chainRescan($, ctx, previous, plan) {
  try { await previous; } catch { /* The earlier event reported its own failure. */ }
  if (rescanWanted(ctx, plan)) await newBoundaries($, ctx);
}
// The transcript: `<config>/projects/<root with every character outside [A-Za-z0-9-] as '-'>/<session id>.jsonl`, the
// host's layout; when it is not there the scanner looks for `<session id>.jsonl` in every project folder. The cursor
// starts where the transcript ended when the main context was created, so no scan reads history, and each scan reads
// only what was added since. A boundary counts once (its uuid). A scan that had to read the file again from 0 (another
// file, a shorter one, or other bytes before the offset) counts only the boundaries dated after the previous scan
// began (RESTART_SKEW_MS earlier), and never marks the others seen. Every scan reads the session id: a new one (after
// /clear, for example) is a new conversation, whose transcript is noted where it ends, and the context is reset.
const RESTART_SKEW_MS = 5_000;
async function openCursor($, ctx) {
  ctx.cursor = null;
  const job = await scanBoundaries($, ctx, null);
  if (job) ctx.cursor = cursorOf(job);
  return Boolean(job);
}
const cursorOf = (job) => ({ path: job.scan.path, projects: job.place.projects, session: job.place.session, offset: job.scan.offset,
  identity: job.scan.identity, tail: job.scan.tail, scannedAt: job.startedAt, seen: new Set() });
async function newBoundaries($, ctx) {
  if (!ctx.cursor) return (await openCursor($, ctx)) ? [] : null;
  const job = await scanBoundaries($, ctx, ctx.cursor);
  if (!job) return null;
  if (job.changed) return sessionChanged($, ctx, job);
  ctx.confirmedTurn = ctx.turns;
  const fresh = freshBoundaries(ctx.cursor, job.scan);
  Object.assign(ctx.cursor, { path: job.scan.path, offset: job.scan.offset, identity: job.scan.identity, tail: job.scan.tail, scannedAt: job.startedAt });
  ctx.found += fresh.length;
  if (fresh.length) await boundaryReset($, ctx, fresh);
  return fresh;
}
// A re-read from 0 that stopped at its budget keeps its date filter on the scans that continue it, until one reaches the
// size the re-read started from.
function freshBoundaries(cursor, scan) {
  const unseen = scan.boundaries.filter((row) => !cursor.seen.has(row.uuid));
  const restart = scan.restarted ? { since: cursor.scannedAt - RESTART_SKEW_MS, until: scan.size } : cursor.restart;
  cursor.restart = restart && scan.partial && scan.offset < restart.until ? restart : null;
  const fresh = restart ? unseen.filter((row) => row.timestamp !== null && Date.parse(row.timestamp) >= restart.since) : unseen;
  for (const row of fresh) cursor.seen.add(row.uuid);
  return fresh.map((row) => row.uuid);
}
// The same file (device and inode) under another id is the same conversation: adopt the id and keep reading where the
// cursor stands. Only a KNOWN identity on both sides says so: a string with a non-zero inode (equal to the cursor's, so
// that one is known too). An inode of 0 (some Windows and network filesystems) is shared by different files, so it is a
// real change: reset, and read the new path.
const knownIdentity = (identity) => typeof identity === 'string' && /^[^:]+:(?!0$).+$/.test(identity);
async function sessionChanged($, ctx, job) {
  if (knownIdentity(job.scan.identity) && job.scan.identity === ctx.cursor.identity) {
    ctx.cursor.session = job.place.session;
    return null;
  }
  ctx.cursor = cursorOf(job);
  ctx.expected = [];
  ctx.plan = null;
  await resetServed($, ctx, MAIN, 'session-changed');
  await progress($, 'wt-rules-on-demand: a new session started; rules are served again');
  // Not an empty reading: the sign that found the new session was the cleared conversation, and no boundary will follow.
  return null;
}
async function transcriptPlace($) {
  try {
    const config = flightConfig ?? configDirectory({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'), HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE') });
    const root = await $.session.root(), session = await $.session.id();
    if (!config || !root || !session) return null;
    const projects = joinSlash(config, 'projects');
    return { path: `${projects}/${String(root).replace(/[^A-Za-z0-9-]/g, '-')}/${session}.jsonl`, projects, session };
  } catch { return null; }
}
// One `node` run of the scanner per scan, under its own time limit, a reading budget, and a deadline on the host call.
// The scanner ships beside this module; its path comes from this module's own URL. Its arguments are built inside the
// call: JavaScript evaluates the callee before them, so a host without child runs (older than the hosts that pass
// session.compact over a plugin: nothing is missing there) throws before any session, root or environment read, and
// nothing is said. One child at a time per context: while one still runs past its deadline, a scan reads nothing and
// starts none (the queue already bounds every waiting check by that one deadline). Any other failure, an unknown
// plugin directory or session included, is told once per load, as a progress line; the cursor stays where it was, so
// the next scan reads what this one missed.
const SCAN_TIMEOUT_MS = 5_000;
const SCAN_BUDGET_MS = 3_000;
const SCAN_DEADLINE_MS = 6_000;
const SCANNER = shippedFile(import.meta.url, 'scripts/compact-boundary.mjs');
async function scanBoundaries($, ctx, cursor) {
  if (!SCANNER) return scanFailed($, new Error(`the plugin directory is not known from ${import.meta.url}`));
  if (ctx.scanning || scanStalled) return null;
  const job = { startedAt: Date.now(), preparing: false, launched: false, abandoned: false };
  const started = runScanner($, job, cursor);
  ctx.scanning = started;
  started.then(() => endScan(ctx, started), () => endScan(ctx, started));
  try {
    job.scan = scanAnswer(await hostCall($, started, SCAN_DEADLINE_MS));
    return job;
  } catch (error) {
    return scanError($, ctx, job, started, error);
  }
}
// The deadline covers the preparation (the session, root and environment reads) as well as the child.
async function runScanner($, job, cursor) {
  return $.process.run(await launchArgv($, job, cursor), { timeoutMs: SCAN_TIMEOUT_MS });
}
async function launchArgv($, job, cursor) {
  job.preparing = true;
  const argv = await scanArgv($, job, cursor);
  if (job.abandoned) throw new Error('the scanner preparation outlived its deadline');
  job.launched = true;
  return argv;
}
// No child runs on this host (the callee threw before any preparation): nothing is missing, nothing is said. A preparation
// past its deadline is abandoned (it never starts a child), frees the context for the next scan, and pauses the scans
// until a turn end, so a host read that never answers costs one deadline per turn, not one per event.
function scanError($, ctx, job, started, error) {
  if (!job.preparing && !error?.unplaced) return null;
  if (error?.deadline && !job.launched) {
    job.abandoned = true;
    scanStalled = true;
    endScan(ctx, started);
  }
  return scanFailed($, error);
}
function scanAnswer(result) {
  if (result?.exitCode !== 0) throw new Error(`scanner exit ${result?.exitCode}: ${String(result?.stderr ?? '').slice(-200)}`);
  const scan = JSON.parse(result.stdout);
  if (!validScan(scan)) throw new Error('scanner answer not understood');
  return scan;
}
function endScan(ctx, started) {
  if (ctx.scanning === started) ctx.scanning = null;
}
// A new cursor, or a cursor of another session, snapshots where the transcript ends; otherwise the scan continues.
async function scanArgv($, job, cursor) {
  const place = await transcriptPlace($);
  if (!place) throw Object.assign(new Error('the session, its root or the configuration directory is not known'), { unplaced: true });
  job.place = place;
  job.changed = Boolean(cursor) && place.session !== cursor.session;
  if (!cursor || job.changed) return ['node', SCANNER, '--transcript', place.path, '--projects', place.projects, '--session', place.session, '--snapshot'];
  return ['node', SCANNER, '--transcript', cursor.path, '--projects', place.projects, '--session', place.session, '--from', String(cursor.offset),
    '--budget-ms', String(SCAN_BUDGET_MS), ...(cursor.identity ? ['--identity', cursor.identity] : []), ...(cursor.tail ? ['--tail', cursor.tail] : [])];
}
const validScan = (scan) => typeof scan?.path === 'string' && Number.isSafeInteger(scan.offset) && Array.isArray(scan.boundaries) &&
  scan.boundaries.every((row) => typeof row?.uuid === 'string');
function scanFailed($, error) {
  if (!scanUnavailable) void progress($, `wt-rules-on-demand: compaction detection unavailable, the transcript cannot be read: ${error.message}`);
  scanUnavailable = true;
  return null;
}
// The live window's input tokens: a number, null when absent, undefined when the host cannot answer (no sign then).
// A host without session.usage is older than the hosts that pass session.compact over a plugin, so it still dispatches
// it: nothing is missing there. A reading that fails otherwise is told once per load, as a progress line the hook never
// waits for, not as a plugin error. A reading past the deadline pauses the mid-turn readings: each would spend the
// deadline again, on every tool call. The turn end still reads, and its first answer resumes them.
async function windowTokens($, verify) {
  if (usageStalled && !verify) return undefined;
  try {
    const tokens = (await hostCall($, $.session.usage()))?.context?.tokens;
    usageStalled = false;
    return Number.isFinite(tokens) ? tokens : null;
  } catch (error) {
    usageFailed($, error);
    return undefined;
  }
}
function usageFailed($, error) {
  if (error?.deadline) {
    if (!usageStalled) void progress($, `wt-rules-on-demand: live window readings paused until a turn end reads it again: ${error.message}`);
    usageStalled = true;
  } else if (!usageMissing && !/is not a function/.test(String(error?.message))) { usageMissing = true; void progress($, `wt-rules-on-demand: compaction detection unavailable, the live window cannot be read: ${error.message}`); }
}
// A sign: tokens lower than the last reading that had them, or absent after one. An absent reading signs once per
// baseline: until a reading has tokens again, the next absent ones are the same compaction, not new ones.
async function windowShrank($, ctx, verify) {
  const tokens = await windowTokens($, verify);
  if (tokens === undefined) return false;
  const baseline = Number.isFinite(ctx.windowTokens);
  if (tokens === null) {
    const sign = baseline && !ctx.absentSigned;
    if (sign) ctx.absentSigned = true;
    return sign;
  }
  const previous = ctx.windowTokens;
  ctx.windowTokens = tokens;
  ctx.absentSigned = false;
  return baseline && tokens < previous;
}
 async function promptSubmitWork($, e, next) {
     if (!enabled) return next(e);
     const admission = ++sequence;
    const ctx = await context($, MAIN);
     const rules = await rulesFor($, ctx, e.cwd ?? '.');
       const triggerErrors = [];
        const budget = regexCallBudget(triggerClock);
          const candidates = await selected($, ctx, rules, e, true, { errors: triggerErrors, budget, slice: { start: Date.now() } });
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
       const ctx = await context($, loop, true);
         const actSeq = ++sequence;
         await closePending($, ctx, loop, 'turn ended', actSeq);
        await closeCorrelation($, ctx, loop, actSeq);
        await journal($, [], loop, [], [], [], { close: { seq: actSeq } });
        if (loop !== MAIN && contexts.get(loop) === ctx) contexts.delete(loop);
     }
    return result;
}
function* inputlessSteps($, e, rules, budget, slice, triggerErrors) {
  if (textOf(e) === null) for (const rule of rules) {
    if (budget.exhausted) break;
    yield breathe($, slice, budget);
    let failed = false;
    if (rule.triggers.some((trigger) => trigger.kind === 'tool' && trigger.input && !trigger.detector && testTriggerRegex(trigger, trigger.tool, e.tool, (error) => {
      failed = true; triggerErrors.push({ rule: rule.name, ...error });
    }, budget)) && !failed) yield notice($, `${rule.name}: input-regex trigger not fired, the ${e.tool} call carried no input`);
  }
}

const beforeRules = (chosen, ctx, beforeMatched) => chosen.filter((rule) => beforeMatched.has(rule.name) && ((ctx.refusing.get(rule.name) ?? 0) > 0 || !servedAs(ctx, rule)));
const uniqueTriggerErrors = (errors) => [...new Map(errors.map((error) => [JSON.stringify(error), error])).values()];

function* unregisteredSteps($, rules, e, loop, admission) {
  for (const rule of rules) if (rule.compliance?.kind === 'unregistered') yield safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, 'unregistered check', summary(e), rule.compliance.reason, { seq: admission });
}

function* refusalSteps($, ctx, before, e, loop, admission) {
  // Keep pending refusals in flight until the result is returned; do not claim on failed logging/store.
  for (const rule of before) ctx.refusing.set(rule.name, (ctx.refusing.get(rule.name) ?? 0) + 1);
  try {
    yield $.ui.log(`wt-rules-on-demand: before-act refusal serving ${before.map((r) => r.name).join(', ')}`);
    // A refused call never runs: its retry, seen by evaluate(), is the classifier's evidence.
    const injected = inject(ctx, before, `tool.call:${e.tool}`, admission);
    yield journal($, before, loop, [], [], injected);
    yield* unregisteredSteps($, before, e, loop, admission);
    const result = { deny: ['wt-rules-on-demand: read the rule below before this action, then retry the same call unchanged or corrected by the rule; this refusal happens once per rule per context.', ...before.map(block)].join('\n\n') };
    claim(ctx, before);
    for (const pending of injected) rememberDelivery(ctx, pending.rule, pending);
    return result;
  } finally { for (const rule of before) { const count = ctx.refusing.get(rule.name) - 1; if (count) ctx.refusing.set(rule.name, count); else ctx.refusing.delete(rule.name); } }
}

const skipToolResult = (result, refused) => result && ('drop' in result || refused && !refusedAfterRun(result.deny));
function recordCorrelation(ctx, rules, e, result, refused) {
  if (rules.some((rule) => rule.compliance?.kind === 'turn-correlation')) {
    const id = String(e.tool_use_id ?? `${ctx.correlation.length}`);
    ctx.correlation.push({ kind: 'use', id, name: e.tool, input: e.input ?? e });
    ctx.correlation.push({ kind: 'result', id, text: typeof result === 'string' ? result : JSON.stringify(result ?? ''), isError: refused || result?.isError === true });
  }
}
const toolActs = (rules, e, chosen) => rules.filter((rule) => rule.compliance && !['model', 'check'].includes(rule.compliance.kind) ? isGovernedAct(rule.compliance, e) : chosen.includes(rule));
const ridingRules = (chosen, ctx) => chosen.filter((rule) => !ctx.refusing.has(rule.name) && eligible(ctx, rule));

function* checkSteps($, { ctx, e, loop, admission, slice, budget }, rules, classified) {
  for (const rule of rules) if (yield breathe($, slice, budget), rule.compliance?.kind === 'check' && servedAs(ctx, rule)) {
    for (const item of Array.isArray(classified) ? classified : [classified]) if (item?.check === rule.compliance.check)
      yield safeVerdict($, perActPending(ctx, rule, e, firstRecord(ctx, rule)), loop,
        item.verdict === 'FOLLOWED' ? 'followed' : 'not followed', summary(e), undefined, { seq: admission });
  }
}

const callFirst = (ctx, rule, admission) => servedAs(ctx, rule)?.servingSeq === admission;
// Named checks and turn-correlation open no delivery window: their first record in a context is the
// initial measurement whatever channel served the text (ride-along, refusal, prompt).
function firstRecord(ctx, rule) {
  const state = servedAs(ctx, rule);
  const first = !state?.recorded;
  if (state) state.recorded = true;
  return first;
}
const correlationPending = (ctx, rule) => {
  const first = firstRecord(ctx, rule);
  return { rule, trigger: 'turn.complete', injectedAt: new Date().toISOString(), later: !first,
    servedDeliveryId: servedAs(ctx, rule)?.deliveryId ?? null };
};
function markServing(ctx, rules, admission) {
  for (const rule of rules) servedAs(ctx, rule).servingSeq = admission;
}

function* servedSteps($, { ctx, e, loop, admission, slice, budget }, rules, measured) {
  // This call is the act a served declarative rule judges: drop any window left for it, even one re-served just now.
  for (const rule of rules) if (yield breathe($, slice, budget), servedAs(ctx, rule)) {
    const { verdict: value, matchError } = servedVerdict(rule.compliance, e);
    if (value === null) continue;
    const discharged = ctx.pending.filter((pending) => pending.rule === rule);
    ctx.pending = ctx.pending.filter((pending) => pending.rule !== rule);
    if (!measured.has(rule.name)) yield safeVerdict($, perActPending(ctx, rule, e, callFirst(ctx, rule, admission)), loop, value, summary(e), matchError, { seq: admission, discharged });
  }
}

function* toolResultSteps($, call, next, rules, chosen, measured) {
  const { ctx, e, loop, admission } = call;
  const result = yield next(e);
  const refused = Boolean(result && 'deny' in result);
  if (skipToolResult(result, refused)) return result;
  recordCorrelation(ctx, rules, e, result, refused);
  const acts = toolActs(rules, e, chosen);
  const ride = ridingRules(chosen, ctx);
  if (ride.length) claim(ctx, ride);
  markServing(ctx, ride, admission);
  const injected = inject(ctx, ride, `tool.call:${e.tool}`, admission, e);
  openLaterModels(ctx, chosen, ride, e, measured);
  yield journal($, ride, loop, chosen.filter((rule) => !ride.includes(rule)), acts, injected);
  const classified = classify(e.tool, e.input ?? e);
  yield* checkSteps($, call, rules, classified);
  for (const rule of ride) yield progress($, `wt-rules-on-demand: serving ${rule.name}`);
  yield* servedSteps($, call, rules, measured);
  yield* unregisteredSteps($, ride, e, loop, admission);
  if (!ride.length) return result;
  // A refusal carries only its text: what rides on it goes inside, after the guard's own words.
  if (refused) return { deny: [result.deny, ...ride.map(block)].join('\n\n') };
  return { ...result, context: [...(result.context ?? []), ...ride.map(block)] };
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
  for (const record of nextRecords) await safeVerdict($, record.pending, loop, record.value, record.evidence, record.reason, { seq: admission, noAct: record.noAct });
  const measured = new Set();
  await evaluate($, ctx, e, loop, measured, admission);
  const triggerErrors = [];
  const budget = regexCallBudget(triggerClock);
  const slice = { start: Date.now() };
  for (const pending of inputlessSteps($, e, rules, budget, slice, triggerErrors)) await pending;
  const beforeMatched = new Set();
  const chosen = await selected($, ctx, rules, e, false, { errors: triggerErrors, budget, beforeMatched, slice });
  const before = await refusalsForAgent($, e, beforeRules(chosen, ctx, beforeMatched));
  await journal($, [], loop, [], [], [], { triggerErrors: uniqueTriggerErrors(triggerErrors) });
  if (budget.exhausted) await progress($, exhaustionNotice(budget));
  const plan = before.length ? refusalSteps($, ctx, before, e, loop, admission)
    : toolResultSteps($, { ctx, e, loop, admission, slice, budget }, next, rules, chosen, measured);
  let step = plan.next();
  while (!step.done) {
    let value;
    try { value = await step.value; }
    catch (error) { step = plan.throw(error); continue; }
    step = plan.next(value);
  }
  return step.value;
}

export function resetForSelftest(keepFlightConfig = false) { resetAgentTypes(); agentTypeSetting = UNREAD; resetFlightRecorder(); flightReady = false; flightPending = false; flightConfig = keepFlightConfig ? flightConfig : null; flightSession = keepFlightConfig ? flightSession : null; flightDisabled = false; usageMissing = false; usageStalled = false; scanUnavailable = false; scanStalled = false; activityWrites.clear(); pendingActivity.clear(); activityProfile = null; activityRetryAt = 0; unsaved.clear(); contexts = new Map(); queue = Promise.resolve(); currentMain = 0; sequence = 0; token = newToken(); logged.clear(); archiveSequence = 0; storeSwept = false; pendingHealth = emptyHealth(); lastHealthFlush = Date.now(); }
