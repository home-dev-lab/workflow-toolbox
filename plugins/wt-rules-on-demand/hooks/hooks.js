import { parseRuntimeRule } from './runtime-rule.js';
import { maskReadOnlyMentions } from './bash-mention.js';
import { bashCommandVerdict, isGovernedAct } from './act-checks.js';
import { ruleDirectories, configDirectory, agentLoop } from '../paths.js';
import { bounded, argumentEvidence, RULE_CAP } from './evidence.js';
import { triggerMatches } from './trigger-match.js';
import { sameRule } from '../duplicate-rule.js';

export { parseRuntimeRule, maskReadOnlyMentions };

const MAIN = 'main';
const MAX_BYTES = 3_500_000;
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
const context = (loop) => {
  if (!contexts.has(loop)) contexts.set(loop, { rules: null, served: new Map(), pending: [], refusing: new Map() });
  return contexts.get(loop);
};
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
      catch (error) { await notice($, `skipped ${file}: ${error.message}`); }
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

async function journal($, names, loop, suppressed = [], acts = []) {
  if (!names.length && !suppressed.length && !acts.length) return;
  await serial(async () => {
    try {
      const now = new Date().toISOString();
      const served = await $.store.get('served') ?? {};
       for (const rule of names) {
         const name = typeof rule === 'string' ? rule : rule.name;
        const item = served[key(name)] ?? { count: 0, byChannel: {} };
        item.count++; item.last = now; item.byChannel['tool.call'] = (item.byChannel['tool.call'] ?? 0) + 1;
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
      for (const rule of acts) ctx.governedActs.push({ rule: rule.name, ruleIdentity: rule.identity, at: now, last: now, count: 1 });
      session.contexts[ck] = ctx;
      sessions[id] = session;
      await $.store.set('sessions', Object.fromEntries(Object.entries(sessions).sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, 50)));
     } catch (error) { await notice($, `journal write failed: ${error.message}`).catch(() => {}); }
  });
}
async function verdict($, rule, loop, value, evidence, reason) {
  const record = { rule: rule.name, ruleIdentity: rule.identity, trigger: 'tool.call', verdict: value, evidence: String(evidence).slice(0, 160), sessionId: await sessionId($), agentId: loop === MAIN ? null : loop, injectedAt: new Date().toISOString(), decidedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  await serial(async () => {
    const old = String(await $.store.get('compliance-verdicts-jsonl') ?? '');
    const line = `${JSON.stringify(record)}\n`;
    if (new TextEncoder().encode(old + line).length > MAX_BYTES && old) {
      await $.store.set(`compliance-verdicts-archive-${Date.now()}-${counter++}`, old);
      await $.store.set('compliance-verdicts-jsonl', line);
    } else await $.store.set('compliance-verdicts-jsonl', old + line);
  });
}
async function safeVerdict($, rule, loop, value, evidence, reason) {
  try { await verdict($, rule, loop, value, evidence, reason); }
  catch (error) { await notice($, `verdict write failed: ${error.message}`).catch(() => {}); }
}
async function evaluate($, ctx, e, loop) {
  const remaining = [];
  for (const pending of ctx.pending) {
    const c = pending.rule.compliance;
    pending.remaining--;
     pending.calls.push(`${e.tool}: ${bounded(textOf(e) ?? '')}`);
     if (c.kind === 'bash-command' && isGovernedAct(c, e)) await safeVerdict($, pending.rule, loop, bashCommandVerdict(c, e.command ?? ''), e.tool);
     else if (c.kind === 'test-before-edit' && e.tool === 'Bash' && c.test.test(bounded(e.command))) { pending.testSeen = true; if (pending.remaining <= 0) await close($, pending, loop); else remaining.push(pending); }
     else if (c.kind === 'test-before-edit' && isGovernedAct(c, e)) await safeVerdict($, pending.rule, loop, pending.testSeen ? 'followed' : 'not followed', e.tool);
    else if (pending.remaining <= 0) await close($, pending, loop);
    else remaining.push(pending);
  }
  ctx.pending = remaining;
}
async function close($, pending, loop) {
  const c = pending.rule.compliance;
  if (c.kind === 'model') {
    try {
      const v = await $.model.classify([pending.rule.content, c.prompt, ...pending.calls].join('\n'), ['followed', 'not followed', 'not applicable'], { model: c.model });
       await safeVerdict($, pending.rule, loop, v || 'unknown', pending.calls.join(' | ') || 'no following calls');
     } catch (error) { await safeVerdict($, pending.rule, loop, 'unknown', '', error.message); }
   } else await safeVerdict($, pending.rule, loop, c.onClose, pending.calls.at(-1) ?? 'no governed act', 'window closed');
}
function inject(ctx, rules) {
  for (const rule of rules) if (rule.compliance && rule.compliance.kind !== 'check') ctx.pending.push({ rule, remaining: rule.compliance.window, calls: [], testSeen: false });
}
const eligible = (ctx, rule) => {
  const state = ctx.served.get(rule.name);
  const minutes = Number((typeof process !== 'undefined' && process.env?.WT_ROD_RESERVE_MIN) || 30);
  return !state || (reserve && state.count < limit && Date.now() - state.at >= minutes * 60_000);
};
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
      context(MAIN).rules ??= await load($, e.cwd ?? '.');
    }
    return next(e);
  });
  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (!result || typeof result !== 'object' || !('skip' in result)) contexts.delete(agentLoop(e.agentId));
    return result;
  });
  on('prompt.submit', async ($, e, next) => {
    if (!enabled) return next(e);
    const ctx = context(MAIN);
    ctx.rules ??= await load($, e.cwd ?? '.');
    const chosen = selected(ctx.rules, e, true).filter((rule) => eligible(ctx, rule));
    const result = await next(e);
    if (result?.deny || result?.drop || !chosen.length) return result;
    claim(ctx, chosen); inject(ctx, chosen); await journal($, chosen, MAIN);
    return { ...result, context: [...(result.context ?? []), ...chosen.map(block)] };
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (enabled) { const loop = agentLoop(e.agentId); const ctx = context(loop); const pending = ctx.pending.splice(0); for (const p of pending) await close($, p, loop); }
    return result;
  });
  // One matcherless tool.call handler: the host permits only one per module.
  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e);
    const loop = agentLoop(e.agentId);
    const ctx = context(loop);
    ctx.rules ??= await load($, e.cwd ?? '.');
    await evaluate($, ctx, e, loop);
    if (textOf(e) === null) for (const rule of ctx.rules) {
      if (rule.triggers.some((trigger) => trigger.kind === 'tool' && trigger.tool.test(e.tool) && trigger.input))
        await notice($, `${rule.name}: input-regex trigger not fired, the ${e.tool} call carried no input`);
    }
    const chosen = selected(ctx.rules, e, false);
     const before = chosen.filter((rule) => rule.triggers.some((trigger) => trigger.beforeFirstAct && matches(trigger, e, false)) && ((ctx.refusing.get(rule.name) ?? 0) > 0 || !ctx.served.has(rule.name)));
    if (before.length) {
      // Keep pending refusals in flight until the result is returned; do not claim on failed logging/store.
       for (const rule of before) ctx.refusing.set(rule.name, (ctx.refusing.get(rule.name) ?? 0) + 1);
      try {
        await $.ui.log(`wt-rules-on-demand: before-act refusal serving ${before.map((r) => r.name).join(', ')}`);
         await journal($, before, loop);
        inject(ctx, before);
        const result = { deny: ['wt-rules-on-demand: read the rule below before this action, then retry the call.', ...before.map(block)].join('\n\n') };
        claim(ctx, before);
        return result;
       } finally { for (const rule of before) { const count = ctx.refusing.get(rule.name) - 1; if (count) ctx.refusing.set(rule.name, count); else ctx.refusing.delete(rule.name); } }
    }
    const result = await next(e);
    if (result?.deny || result?.drop) return result;
    const acts = ctx.rules.filter((rule) => rule.compliance && !['model', 'check'].includes(rule.compliance.kind) ? isGovernedAct(rule.compliance, e) : chosen.includes(rule));
     const ride = chosen.filter((rule) => !ctx.refusing.has(rule.name) && eligible(ctx, rule));
     if (ride.length) { claim(ctx, ride); inject(ctx, ride); }
     await journal($, ride, loop, chosen.filter((rule) => !ride.includes(rule)), acts);
    for (const rule of ride) if (rule.compliance?.kind === 'bash-command' && isGovernedAct(rule.compliance, e)) {
      ctx.pending = ctx.pending.filter((pending) => pending.rule !== rule);
       await safeVerdict($, rule, loop, bashCommandVerdict(rule.compliance, bounded(e.command)), e.tool);
    }
    return ride.length ? { ...result, context: [...(result.context ?? []), ...ride.map(block)] } : result;
  });
};

export function resetForSelftest() { contexts = new Map(); queue = Promise.resolve(); counter = 0; currentMain = 0; logged.clear(); }
