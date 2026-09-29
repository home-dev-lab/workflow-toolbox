import { parseRuntimeRule } from './runtime-rule.js';
import { maskReadOnlyMentions } from './bash-mention.js';
import { bashCommandVerdict, isGovernedAct, classify } from './act-checks.js';
import { toolInputVerdict, correlateTurn } from './declarative-checks.js';
import { ruleDirectories, configDirectory, agentLoop } from '../paths.js';
import { bounded, argumentEvidence, RULE_CAP } from './evidence.js';
import { triggerMatches, testTriggerRegex, unevaluatedTrigger } from './trigger-match.js';
import { regexCallBudget } from './linear-regex.js';
import { sameRule } from '../duplicate-rule.js';
import { extractSymbol, detectorEnvironment, servedExtensions, classifyGrep } from './lsp-symbol.js';

export { parseRuntimeRule, maskReadOnlyMentions };

const MAIN = 'main';
const MAX_BYTES = 3_500_000;
const MAX_CONTEXTS = 64;
let contexts = new Map();
let queue = Promise.resolve();
let reserve = false;
let limit = 1;
let enabled = false;
let counter = 0;
let currentMain = 0;
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
      victim = { loop: oldest, evicted, closing: [...evicted.pending.splice(0), ...detachNext(evicted)] };
    }
  }
  const created = { rules: null, served: new Map(), pending: [], nextWindows: new Set(), refusing: new Map(), prompting: new Map(), correlation: [] };
  contexts.set(loop, created);
  if (victim) {
    for (const pending of victim.closing) await close($, pending, victim.loop, 'context evicted');
    await closeCorrelation($, victim.evicted, victim.loop);
  }
  return created;
};
async function rulesFor($, ctx, cwd) {
  if (ctx.rules) return ctx.rules;
  ctx.loading ??= load($, cwd);
  try { ctx.rules = await ctx.loading; }
  finally { ctx.loading = null; }
  return ctx.rules;
}
async function notice($, message) {
  if (/failed|skipped|unavailable|dangling|cannot|exhausted/i.test(message)) void recordHealth($, null, message).catch(() => {});
  if (!logged.has(message)) { logged.add(message); await $.ui.log(`wt-rules-on-demand: ${message}`); }
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
      await $.store.set('health', health);
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
  const physical = await $.fs.stat(root, { resolve: true }).then((info) => info.realPath ?? root).catch(() => root);
  if (visited.has(physical)) return [];
  visited.add(physical);
  const files = [];
  for (const entry of await list($, root)) {
    const path = `${root}/${entry.name}`;
    const kind = await entryKind($, path, entry);
    if (kind === 'file' && entry.name.endsWith('.md')) files.push({ name: entry.name, path });
    else if (kind === 'dir') files.push(...await staticRules($, path, depth + 1, visited));
  }
  return files;
}
async function load($, cwd) {
  const env = { CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'), HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE') };
  const config = configDirectory(env);
  if (!config) { await notice($, 'HOME and USERPROFILE unavailable; cannot locate user rules'); return []; }
  const paths = ruleDirectories(cwd, config);
   const staticFiles = (await Promise.all([staticRules($, paths.projectStatic), staticRules($, paths.userStatic)])).flat();
  const rules = [];
  for (const [scope, dir] of [['user', paths.user], ['project', paths.project]]) {
    for (const entry of await list($, dir)) {
      const file = `${dir}/${entry.name}`;
      const kind = await entryKind($, file, entry);
      if (kind !== 'file' || !entry.name.endsWith('.md')) continue;
      try {
        const info = await $.fs.stat(file, { resolve: true });
        if (info.size > RULE_CAP) throw new Error(`rule exceeds ${RULE_CAP} bytes`);
        const text = await $.fs.read(file);
        if (new TextEncoder().encode(text).length > RULE_CAP) throw new Error(`rule exceeds ${RULE_CAP} bytes`);
        const duplicates = staticFiles.filter((item) => item.name === entry.name);
        let suppressed = false;
        for (const item of duplicates) {
          const equal = sameRule(await $.fs.read(item.path), text);
          if (equal) suppressed = true;
          await notice($, equal ? `loaded twice: ${item.path} and ${file}; the on-demand copy is not served` : `same name, different rule: ${item.path} and ${file}`);
        }
        if (suppressed) continue;
        const physical = await $.fs.stat(dir, { resolve: true }).then((stat) => stat.realPath ?? dir).catch(() => dir);
        rules.push({ ...parseRuntimeRule(entry.name, text), identity: `${scope}:${physical}:${entry.name}` });
      }
       catch (error) { await notice($, `skipped ${file}: ${error.message}`).catch(() => {}); }
    }
  }
  return [...new Map(rules.map((rule) => [rule.name, rule])).values()];
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
  const { channel = 'tool.call', triggerErrors = [] } = options;
  if (!names.length && !suppressed.length && !acts.length && !injected.length && !triggerErrors.length) return;
  const turn = writeTurn();
  await turn.previous.catch(() => {});
  try {
     try {
      const now = new Date().toISOString();
      const served = await $.store.get('served') ?? {};
       for (const rule of names) {
         const name = typeof rule === 'string' ? rule : rule.name;
        const item = served[key(name)] ?? { count: 0, byChannel: {} };
         item.count++; item.last = now; item.byChannel[channel] = (item.byChannel[channel] ?? 0) + 1;
        served[key(name)] = item;
      }
      if (names.length) await $.store.set('served', served);
      const id = await sessionId($);
      if (!id) return;
      const sessions = await $.store.get('sessions') ?? {};
      const session = sessions[id] ?? { first: now, contexts: {} };
      session.last = now;
      const ck = loop === MAIN ? String(currentMain) : `agent:${loop}`;
      const ctx = session.contexts[ck] ?? { served: {}, suppressedCap: {}, governedActs: [], complianceInjected: [] };
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
       for (const rule of injected) ctx.complianceInjected.push({ rule: rule.name, ruleIdentity: rule.identity, at: now });
       if (triggerErrors.length) {
         ctx.triggerErrors ??= [];
         ctx.triggerErrors.push(...triggerErrors.map((error) => ({ ...error, at: now, channel })));
          // Retain every error from this call, even when a mass serve exceeds
          // the usual 100-row history cap; older rows yield first.
          ctx.triggerErrors = ctx.triggerErrors.slice(-Math.max(100, triggerErrors.length));
       }
      session.contexts[ck] = ctx;
      sessions[id] = session;
       const ordered = Object.entries(sessions).sort((a, b) => b[1].last.localeCompare(a[1].last));
       for (let count = Math.min(50, ordered.length); count >= 1; count = Math.floor(count / 2)) {
         try { await $.store.set('sessions', Object.fromEntries(ordered.slice(0, count))); break; }
         catch (error) { if (count === 1) throw error; }
       }
     } catch (error) { await notice($, `journal write failed: ${error.message}`).catch(() => {}); }
   } finally { turn.release(); }
}
async function verdict($, pending, loop, value, evidence, reason) {
  const { rule } = pending;
  const record = { rule: rule.name, ruleIdentity: rule.identity, trigger: pending.trigger, verdict: value, evidence: String(evidence).slice(0, 160), sessionId: await sessionId($), agentId: loop === MAIN ? null : loop, injectedAt: pending.injectedAt, decidedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
   const turn = writeTurn();
   await turn.previous.catch(() => {});
   try {
    const old = String(await $.store.get('compliance-verdicts-jsonl') ?? '');
    const line = `${JSON.stringify(record)}\n`;
    if (new TextEncoder().encode(old + line).length > MAX_BYTES && old) {
      const config = configDirectory({ CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'), HOME: await $.env.get('HOME'), USERPROFILE: await $.env.get('USERPROFILE') });
      if (!config) throw new Error('cannot locate quality data for verdict rotation');
      const directory = `${config}/plugins/data/wt-rules-on-demand/quality`;
      const physical = await $.fs.stat(directory, { resolve: true }).then((info) => info.realPath ?? directory).catch(() => directory);
      if (/(^|[\\/])(?:rules|rules-on-demand|\.git)(?:[\\/]|$)/.test(physical)) throw new Error('unsafe quality data directory');
      const path = `${directory}/compliance-verdicts-archive-${Date.now()}-${counter++}.jsonl`;
      await $.fs.write(path, old);
      await $.store.set('compliance-verdicts-jsonl', line);
      const numbers = (name) => name.slice('compliance-verdicts-archive-'.length, -'.jsonl'.length).split('-').map(Number);
      const files = (await list($, directory)).map((item) => item.name)
        .filter((name) => name.startsWith('compliance-verdicts-archive-') && name.endsWith('.jsonl')
          && numbers(name).length === 2 && numbers(name).every((n) => Number.isSafeInteger(n) && n >= 0))
        .sort((a, b) => numbers(a)[0] - numbers(b)[0] || numbers(a)[1] - numbers(b)[1]);
      for (const name of files.slice(0, -14)) await $.fs.remove(`${directory}/${name}`);
    } else await $.store.set('compliance-verdicts-jsonl', old + line);
   } finally { turn.release(); }
}
async function safeVerdict($, pending, loop, value, evidence, reason) {
  try { await verdict($, pending, loop, value, evidence, reason); }
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
async function evaluate($, ctx, e, loop, measured) {
  const { actions, error } = decideEvaluate(ctx, e, measured);
  for (const action of actions) {
    if (action.type === 'verdict') await safeVerdict($, action.pending, loop, action.value, action.evidence, action.reason);
    else await close($, action.pending, loop);
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
async function closePending($, ctx, loop, reason) {
  const closing = [...ctx.pending.splice(0), ...detachNext(ctx)];
  for (const pending of closing) await close($, pending, loop, reason);
}
async function close($, pending, loop, reason = 'window closed') {
  const c = pending.rule.compliance;
  if (c.kind === 'model') {
    try {
       const v = await $.model.classify([pending.rule.content, c.prompt, ...pending.calls.map((call) => call.detail)].join('\n'), ['followed', 'not followed', 'not applicable'], { model: c.model });
        await safeVerdict($, pending, loop, v || 'unknown', pending.calls.map((call) => call.summary).join(' | ') || 'no following calls', v === 'not applicable' ? c.onClose : undefined);
      } catch (error) { await safeVerdict($, pending, loop, 'unknown', '', error.message); }
    } else await safeVerdict($, pending, loop, c.onClose, pending.calls.at(-1)?.summary ?? 'no governed act', reason);
}
// A served declarative rule judges every act it governs, like a named check does while served.
function servedVerdict(c, e) {
  if (c?.kind === 'bash-command') return { verdict: isGovernedAct(c, e) ? bashCommandVerdict(c, bounded(e.command ?? '')) : null, matchError: null };
  if (c?.kind === 'tool-input') return toolInputVerdict(c, { tool: e.tool, input: e.input ?? e });
  return { verdict: null, matchError: null };
}
function inject(ctx, rules, trigger, event = null) {
   const injectedAt = new Date().toISOString();
   const injected = rules.filter((rule) => rule.compliance && !['check', 'unregistered', 'turn-correlation'].includes(rule.compliance.kind));
    for (const rule of injected) {
      const pending = { rule, trigger, injectedAt, remaining: rule.compliance.window,
        calls: event && rule.compliance.kind === 'model' ? [{ detail: `${event.tool}: ${bounded(textOf(event) ?? '')}`, summary: summary(event) }] : [], testSeen: false };
       if (rule.compliance.kind === 'next-call') { pending.terminal = false; ctx.nextWindows.add(pending); }
      else ctx.pending.push(pending);
    }
   return injected;
}
async function closeCorrelation($, ctx, loop) {
  const events = [...ctx.correlation, { kind: 'turn' }];
    for (const rule of ctx.rules ?? []) if (rule.compliance?.kind === 'turn-correlation' && ctx.served.has(rule.name)) {
     try { for (const item of correlateTurn(rule.compliance, events)) await safeVerdict($, { rule, trigger: 'turn.complete', injectedAt: new Date().toISOString() }, loop, item.verdict, item.id, item.detail); }
     catch (error) { await notice($, `${rule.name}: correlation failed: ${error.message}`).catch(() => {}); }
   }
  ctx.correlation = [];
}
const eligible = (ctx, rule) => {
  const state = ctx.served.get(rule.name);
  const minutes = Number((typeof process !== 'undefined' && process.env?.WT_ROD_RESERVE_MIN) || 30);
  return !state || (reserve && state.count < limit && Date.now() - state.at >= minutes * 60_000);
};
// The host types ui.log as returning void: a progress line never aborts serving, whether it returns, rejects or throws.
async function progress($, message) {
  try { await $.ui.log(message); } catch { /* A progress line is best effort. */ }
}
function claim(ctx, rules) {
  for (const rule of rules) { const state = ctx.served.get(rule.name); ctx.served.set(rule.name, { count: (state?.count ?? 0) + 1, at: Date.now() }); }
}

/** @type {import('claude-code').Register} */
export const register = (on, options, clock = Date.now) => {
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
          await closePending($, ctx, loop, 'compaction');
         await closeCorrelation($, ctx, loop);
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
    const ctx = await context($, MAIN);
     await rulesFor($, ctx, e.cwd ?? '.');
       const triggerErrors = [];
        const budget = regexCallBudget(triggerClock);
          const candidates = await selected($, ctx, ctx.rules, e, true, { errors: triggerErrors, budget });
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
        const injected = inject(ctx, ride, 'prompt.submit');
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
        await closePending($, ctx, loop, 'turn ended');
       await closeCorrelation($, ctx, loop);
     }
    return result;
}
  // One matcherless tool.call handler: the host permits only one per module.
async function toolCallWork($, e, next) {
    if (!enabled) return next(e);
    const loop = agentLoop(e.agentId);
    const existing = contexts.get(loop);
    const nextRecords = existing ? decideNext(existing, e) : [];
    const ctx = await context($, loop);
       await rulesFor($, ctx, e.cwd ?? '.');
       const rules = ctx.rules;
         for (const record of nextRecords) await safeVerdict($, record.pending, loop, record.value, record.evidence, record.reason);
      const measured = new Set();
     await evaluate($, ctx, e, loop, measured);
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
      const before = chosen.filter((rule) => beforeMatched.has(rule.name) && ((ctx.refusing.get(rule.name) ?? 0) > 0 || !ctx.served.has(rule.name)));
      await journal($, [], loop, [], [], [], { triggerErrors: [...new Map(triggerErrors.map((error) => [JSON.stringify(error), error])).values()] });
      if (budget.exhausted) await progress($, exhaustionNotice(budget));
    if (before.length) {
      // Keep pending refusals in flight until the result is returned; do not claim on failed logging/store.
       for (const rule of before) ctx.refusing.set(rule.name, (ctx.refusing.get(rule.name) ?? 0) + 1);
      try {
        await $.ui.log(`wt-rules-on-demand: before-act refusal serving ${before.map((r) => r.name).join(', ')}`);
          // A refused call never runs: its retry, seen by evaluate(), is the classifier's evidence.
          const injected = inject(ctx, before, `tool.call:${e.tool}`);
         await journal($, before, loop, [], [], injected);
         for (const rule of before) if (rule.compliance?.kind === 'unregistered') await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, 'unregistered check', summary(e), rule.compliance.reason);
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
      const injected = inject(ctx, ride, `tool.call:${e.tool}`, e);
       await journal($, ride, loop, chosen.filter((rule) => !ride.includes(rule)), acts, injected);
       const classified = classify(e.tool, e.input ?? e);
        for (const rule of rules) if (rule.compliance?.kind === 'check' && ctx.served.has(rule.name)) {
         for (const item of Array.isArray(classified) ? classified : [classified]) if (item?.check === rule.compliance.check)
           await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop,
             item.verdict === 'FOLLOWED' ? 'followed' : 'not followed', summary(e));
       }
      for (const rule of ride) await progress($, `wt-rules-on-demand: serving ${rule.name}`);
     // This call is the act a served declarative rule judges: drop any window left for it, even one re-served just now.
      for (const rule of rules) if (ctx.served.has(rule.name)) {
       const { verdict: value, matchError } = servedVerdict(rule.compliance, e);
       if (value === null) continue;
       ctx.pending = ctx.pending.filter((pending) => pending.rule !== rule);
       if (!measured.has(rule.name)) await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, value, summary(e), matchError);
     }
    for (const rule of ride) if (rule.compliance?.kind === 'unregistered') await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, 'unregistered check', summary(e), rule.compliance.reason);
    return ride.length ? { ...result, context: [...(result.context ?? []), ...ride.map(block)] } : result;
}

export function resetForSelftest() { contexts = new Map(); queue = Promise.resolve(); counter = 0; currentMain = 0; logged.clear(); pendingHealth = emptyHealth(); lastHealthFlush = Date.now(); }
