import { parseRuntimeRule } from './runtime-rule.js';
import { maskReadOnlyMentions } from './bash-mention.js';
import { bashCommandVerdict, isGovernedAct, classify } from './act-checks.js';
import { toolInputVerdict, correlateTurn } from './declarative-checks.js';
import { ruleDirectories, configDirectory, agentLoop } from '../paths.js';
import { bounded, argumentEvidence, RULE_CAP } from './evidence.js';
import { triggerMatches } from './trigger-match.js';
import { sameRule } from '../duplicate-rule.js';

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

const serial = (fn) => {
  const run = queue.catch(() => {}).then(fn);
  queue = run;
  return run;
};
const key = (name) => name.replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
const context = async ($, loop) => {
  if (!contexts.has(loop)) {
    if (contexts.size >= MAX_CONTEXTS) {
      const oldest = [...contexts.keys()].find((name) => name !== MAIN);
      if (oldest) {
        const evicted = contexts.get(oldest);
        for (const pending of evicted.pending.splice(0)) await close($, pending, oldest, 'context evicted');
        await closeCorrelation($, evicted, oldest);
        contexts.delete(oldest);
      }
    }
     contexts.set(loop, { rules: null, served: new Map(), pending: [], refusing: new Map(), prompting: new Map(), correlation: [] });
  }
  return contexts.get(loop);
};
async function rulesFor($, ctx, cwd) {
  if (ctx.rules) return ctx.rules;
  ctx.loading ??= load($, cwd);
  try { ctx.rules = await ctx.loading; }
  finally { ctx.loading = null; }
  return ctx.rules;
}
async function notice($, message) {
  if (!logged.has(message)) { logged.add(message); await $.ui.log(`wt-rules-on-demand: ${message}`); }
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
  const staticFiles = (await Promise.all([paths.projectStatic, paths.userStatic].map((root) => staticRules($, root)))).flat();
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
const matches = (trigger, e, prompt) => triggerMatches(trigger, prompt
  ? { channel: 'prompt', text: e.text } : { channel: 'tool', tool: e.tool, command: e.command, path: pathOf(e), input: textOf(e) });
const selected = (rules, e, prompt) => rules.filter((rule) => rule.triggers.some((trigger) => matches(trigger, e, prompt)));
const block = (rule) => `<rule name="${rule.name}">\n${rule.content}\n</rule>`;
const sessionId = async ($) => { try { return await $.session.id(); } catch { return null; } };
const summary = (e) => e.tool === 'Bash' ? `Bash: ${bounded(e.command ?? '').trim().split(/\s+/).slice(0, 2).join(' ')}`
  : `${e.tool}: ${String(pathOf(e)).split(/[\\/]/).at(-1) || 'call'}`;

async function journal($, names, loop, suppressed = [], acts = [], injected = [], channel = 'tool.call') {
  if (!names.length && !suppressed.length && !acts.length && !injected.length) return;
  await serial(async () => {
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
      session.contexts[ck] = ctx;
      sessions[id] = session;
       const ordered = Object.entries(sessions).sort((a, b) => b[1].last.localeCompare(a[1].last));
       for (let count = Math.min(50, ordered.length); count >= 1; count = Math.floor(count / 2)) {
         try { await $.store.set('sessions', Object.fromEntries(ordered.slice(0, count))); break; }
         catch (error) { if (count === 1) throw error; }
       }
     } catch (error) { await notice($, `journal write failed: ${error.message}`).catch(() => {}); }
  });
}
async function verdict($, pending, loop, value, evidence, reason) {
  const { rule } = pending;
  const record = { rule: rule.name, ruleIdentity: rule.identity, trigger: pending.trigger, verdict: value, evidence: String(evidence).slice(0, 160), sessionId: await sessionId($), agentId: loop === MAIN ? null : loop, injectedAt: pending.injectedAt, decidedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  await serial(async () => {
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
  });
}
async function safeVerdict($, pending, loop, value, evidence, reason) {
  try { await verdict($, pending, loop, value, evidence, reason); }
  catch (error) { await notice($, `verdict write failed: ${error.message}`).catch(() => {}); }
}
async function evaluate($, ctx, e, loop) {
  const remaining = [];
  for (const pending of ctx.pending) {
    const c = pending.rule.compliance;
    pending.remaining--;
      pending.calls.push({ detail: `${e.tool}: ${bounded(textOf(e) ?? '')}`, summary: summary(e) });
      if (c.kind === 'bash-command' && isGovernedAct(c, e)) await safeVerdict($, pending, loop, bashCommandVerdict(c, e.command ?? ''), summary(e));
      else if (c.kind === 'tool-input' && toolInputVerdict(c, { tool: e.tool, input: e.input ?? e }) !== null) await safeVerdict($, pending, loop, toolInputVerdict(c, { tool: e.tool, input: e.input ?? e }), summary(e));
     else if (c.kind === 'test-before-edit' && e.tool === 'Bash' && c.test.test(bounded(e.command))) { pending.testSeen = true; if (pending.remaining <= 0) await close($, pending, loop); else remaining.push(pending); }
      else if (c.kind === 'test-before-edit' && isGovernedAct(c, e)) await safeVerdict($, pending, loop, pending.testSeen ? 'followed' : 'not followed', summary(e));
    else if (pending.remaining <= 0) await close($, pending, loop);
    else remaining.push(pending);
  }
  ctx.pending = remaining;
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
function inject(ctx, rules, trigger) {
   const injectedAt = new Date().toISOString();
   const injected = rules.filter((rule) => rule.compliance && !['check', 'unregistered', 'turn-correlation'].includes(rule.compliance.kind));
   for (const rule of injected) ctx.pending.push({ rule, trigger, injectedAt, remaining: rule.compliance.window, calls: [], testSeen: false });
   return injected;
}
async function closeCorrelation($, ctx, loop) {
  const events = [...ctx.correlation, { kind: 'turn' }];
   for (const rule of ctx.rules ?? []) if (rule.compliance?.kind === 'turn-correlation') {
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
export const register = (on, options) => {
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
  on('prompt.context', async ($, e, next) => {
    if (enabled) {
      try { if (!(await $.session.messages()).some((message) => message?.role === 'assistant')) { contexts.delete(MAIN); currentMain++; } } catch { /* Message history may be unavailable at startup. */ }
       await rulesFor($, await context($, MAIN), e.cwd ?? '.');
    }
    return next(e);
  });
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
     if (!result || typeof result !== 'object' || !('skip' in result)) {
       const loop = agentLoop(e.agentId), ctx = contexts.get(loop);
       if (ctx) {
         for (const pending of ctx.pending.splice(0)) await close($, pending, loop, 'compaction');
         await closeCorrelation($, ctx, loop);
          ctx.rules = null;
          ctx.loading = null;
          ctx.served.clear();
            ctx.prompting = new Map(ctx.prompting);
       }
     }
    return result;
  });
  on('prompt.submit', async ($, e, next) => {
    if (!enabled) return next(e);
    const ctx = await context($, MAIN);
     await rulesFor($, ctx, e.cwd ?? '.');
      const candidates = selected(ctx.rules, e, true);
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
       if (!ride.length) return result;
       claim(ctx, ride); const injected = inject(ctx, ride, 'prompt.submit'); await journal($, ride, MAIN, [], ride, injected, 'prompt.submit');
       for (const rule of ride) await progress($, `wt-rules-on-demand: serving ${rule.name}`);
       return result;
      } finally {
        for (const rule of chosen) for (const state of new Set([prompting, ctx.prompting])) if (state.get(rule.name) === reservation) state.delete(rule.name);
        release();
     }
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
     if (enabled) {
       const loop = agentLoop(e.agentId);
       const ctx = await context($, loop);
       for (const pending of ctx.pending.splice(0)) await close($, pending, loop, 'turn ended');
       await closeCorrelation($, ctx, loop);
     }
    return result;
  });
  // One matcherless tool.call handler: the host permits only one per module.
  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e);
    const loop = agentLoop(e.agentId);
    const ctx = await context($, loop);
     await rulesFor($, ctx, e.cwd ?? '.');
    await evaluate($, ctx, e, loop);
    if (textOf(e) === null) for (const rule of ctx.rules) {
       if (rule.triggers.some((trigger) => trigger.kind === 'tool' && trigger.tool.test(bounded(e.tool)) && trigger.input))
        await notice($, `${rule.name}: input-regex trigger not fired, the ${e.tool} call carried no input`);
    }
    const chosen = selected(ctx.rules, e, false);
     const before = chosen.filter((rule) => rule.triggers.some((trigger) => trigger.beforeFirstAct && matches(trigger, e, false)) && ((ctx.refusing.get(rule.name) ?? 0) > 0 || !ctx.served.has(rule.name)));
    if (before.length) {
      // Keep pending refusals in flight until the result is returned; do not claim on failed logging/store.
       for (const rule of before) ctx.refusing.set(rule.name, (ctx.refusing.get(rule.name) ?? 0) + 1);
      try {
        await $.ui.log(`wt-rules-on-demand: before-act refusal serving ${before.map((r) => r.name).join(', ')}`);
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
    if (ctx.rules.some((rule) => rule.compliance?.kind === 'turn-correlation')) {
      const id = String(e.tool_use_id ?? `${ctx.correlation.length}`);
      ctx.correlation.push({ kind: 'use', id, name: e.tool, input: e.input ?? e });
      ctx.correlation.push({ kind: 'result', id, text: typeof result === 'string' ? result : JSON.stringify(result ?? ''), isError: result?.isError === true });
    }
    const acts = ctx.rules.filter((rule) => rule.compliance && !['model', 'check'].includes(rule.compliance.kind) ? isGovernedAct(rule.compliance, e) : chosen.includes(rule));
     const ride = chosen.filter((rule) => !ctx.refusing.has(rule.name) && eligible(ctx, rule));
      if (ride.length) claim(ctx, ride);
      const injected = inject(ctx, ride, `tool.call:${e.tool}`);
       await journal($, ride, loop, chosen.filter((rule) => !ride.includes(rule)), acts, injected);
       const classified = classify(e.tool, e.input ?? e);
       for (const rule of ctx.rules) if (rule.compliance?.kind === 'check' && ctx.served.has(rule.name)) {
         for (const item of Array.isArray(classified) ? classified : [classified]) if (item?.check === rule.compliance.check)
           await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop,
             item.verdict === 'FOLLOWED' ? 'followed' : 'not followed', summary(e));
       }
      for (const rule of ride) await progress($, `wt-rules-on-demand: serving ${rule.name}`);
    for (const rule of ride) if (rule.compliance?.kind === 'bash-command' && isGovernedAct(rule.compliance, e)) {
      ctx.pending = ctx.pending.filter((pending) => pending.rule !== rule);
        await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, bashCommandVerdict(rule.compliance, bounded(e.command)), summary(e));
    }
    for (const rule of ride) if (rule.compliance?.kind === 'tool-input') {
      const value = toolInputVerdict(rule.compliance, { tool: e.tool, input: e.input ?? e });
      if (value) { ctx.pending = ctx.pending.filter((pending) => pending.rule !== rule); await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, value, summary(e)); }
    }
    for (const rule of ride) if (rule.compliance?.kind === 'unregistered') await safeVerdict($, { rule, trigger: `tool.call:${e.tool}`, injectedAt: new Date().toISOString() }, loop, 'unregistered check', summary(e), rule.compliance.reason);
    return ride.length ? { ...result, context: [...(result.context ?? []), ...ride.map(block)] } : result;
  });
};

export function resetForSelftest() { contexts = new Map(); queue = Promise.resolve(); counter = 0; currentMain = 0; logged.clear(); }
