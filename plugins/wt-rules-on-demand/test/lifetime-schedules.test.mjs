import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hooks from '../hooks/hooks.js';

// Acceptance schedules for any change to how a context's compliance windows live and settle. Each schedule holds one
// handler at a named point with a promise gate (no timers) while another handler of the same context runs, and asserts
// one settlement per serve, attributed to its rule, session, context and act, with every serve journalled.
// A design that orders lifecycle work behind an admitted tool call cannot reach some of these gates as written: it
// must express the same interleaving at its own suspension points, never drop the schedule.

const ruleText = (trigger, compliance) => `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nFollow this rule.\n`;
const toolTrigger = (tool) => `    - kind: tool\n      tool: ^${tool}$\n      unconditional: true`;
const bashWindow = () => '    kind: bash-command\n    act-regex: git push\n    require-regex: origin\n    window: 100\n    on-close: not applicable';
const promptTrigger = '    - kind: prompt\n      regex: ready';
const rulesDir = '/config/rules-on-demand';

function host(rules, implementation = hooks) {
  implementation.resetForSelftest();
  const handlers = new Map(), stored = new Map();
  implementation.register((name, handler) => handlers.set(name, handler), { enabled: true });
  const files = new Map(Object.entries(rules).map(([name, text]) => [`${rulesDir}/${name}`, text]));
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/config', HOME: '/home' })[name] },
    fs: {
      list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => ({ kind: 'file', name: path.slice(dir.length + 1) })),
      read: async (path) => files.get(path),
      stat: async (path) => ({ kind: files.has(path) ? 'file' : 'dir', size: files.get(path)?.length ?? 0, realPath: path }),
    },
    ui: { log: async () => {} },
    store: { get: async (key) => stored.get(key), set: async (key, value) => { stored.set(key, value); } },
    session: { id: async () => 'fixture', messages: async () => [{ role: 'assistant' }] },
    model: { classify: async () => 'followed' },
  };
  const pass = async () => ({});
  return {
    $, stored, handlers,
    call: (event, next = pass) => handlers.get('tool.call')($, { cwd: '/project', ...event }, next),
    prompt: (event) => handlers.get('prompt.submit')($, { cwd: '/project', ...event }, pass),
    context: () => handlers.get('prompt.context')($, { cwd: '/project' }, pass),
    finish: () => handlers.get('turn.complete')($, {}, pass),
    compact: () => handlers.get('session.compact')($, {}, pass),
    verdicts: () => String(stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse),
    served: () => stored.get('served')?.['r.md']?.count ?? 0,
    injected: () => Object.values(stored.get('sessions')?.fixture?.contexts ?? {}).flatMap((ctx) => ctx.complianceInjected ?? []),
  };
}

function gate() {
  let open, mark;
  const opened = new Promise((resolve) => { open = resolve; });
  const entered = new Promise((resolve) => { mark = resolve; });
  return { open, entered, wait: async () => { mark(); await opened; } };
}

// Every row must belong to this rule, session and MAIN context, judge the named act, and every serve must be journalled.
function attributed(f, label, acts) {
  const rows = f.verdicts();
  for (const row of rows) {
    assert.equal(row.ruleIdentity, `user:${rulesDir}:r.md`, `${label}: verdict must name the served rule`);
    assert.equal(row.sessionId, 'fixture', `${label}: verdict must name the session`);
    assert.equal(row.agentId, null, `${label}: verdict must name the MAIN context`);
  }
  acts.forEach((act, index) => { if (act) assert.match(rows[index].evidence, act, `${label}: verdict ${index} must judge its own act`); });
  assert.equal(f.injected().length, f.served(), `${label}: every serve must be journalled`);
}

async function reached(held, operation, label) {
  const first = await Promise.race([
    held.entered.then(() => 'entered'),
    operation.then(() => 'completed', (error) => { throw error; }),
  ]);
  assert.equal(first, 'entered', `${label}: held next must enter before the operation completes`);
}

// A: a governed call outlives a MAIN context replacement.
test('schedule A: a held governed call after MAIN replacement is judged once', async () => {
  const f = host({ 'r.md': ruleText('    - kind: bash\n      regex: git push', bashWindow()) });
  const held = gate();
  const call = f.call({ tool: 'Bash', command: 'git push origin' }, async () => { await held.wait(); return {}; });
  try {
    await reached(held, call, 'A');
    f.$.session.messages = async () => [];
    await f.context();
  } finally { held.open(); }
  await call;
  await f.finish();
  assert.equal(f.served(), 1, 'A: matching Bash call must serve once');
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['followed'], 'A: one serve must yield exactly one followed verdict across MAIN replacement');
  attributed(f, 'A', [/^Bash: git push/]);
});

// B: a call held across compaction resumes after the same rule is re-served.
test('schedule B: compaction and re-serve do not double-judge the old call', async () => {
  const f = host({ 'r.md': ruleText(promptTrigger, bashWindow()) });
  await f.prompt({ text: 'ready' });
  const held = gate();
  const call = f.call({ tool: 'Bash', command: 'git push origin' }, async () => { await held.wait(); return {}; });
  try { await reached(held, call, 'B'); } catch (error) { held.open(); throw error; }
  try { await f.compact(); await f.prompt({ text: 'ready' }); } finally { held.open(); }
  await call;
  await f.finish();
  assert.equal(f.served(), 2, 'B: same rule must be served again after compaction');
  assert.deepEqual(f.verdicts().map(({ verdict, reason }) => [verdict, reason ?? null]),
    [['followed', null], ['not applicable', 'turn ended']], 'B: two serves must yield only the old followed verdict and the new turn-ended verdict');
  attributed(f, 'B', [/^Bash: git push/]);
});

// C: two reserve-mode deliveries are independent windows.
test('schedule C: reserve re-delivery creates two verdicts and two journal entries', async () => {
  const keys = ['WT_ROD_TIME_RESERVE', 'WT_ROD_RESERVE_MIN', 'WT_ROD_MAX_PER_CONTEXT'];
  const saved = keys.map((key) => process.env[key]);
  process.env.WT_ROD_TIME_RESERVE = '1';
  process.env.WT_ROD_RESERVE_MIN = '0';
  delete process.env.WT_ROD_MAX_PER_CONTEXT;
  try {
    const f = host({ 'r.md': ruleText(toolTrigger('Agent'), bashWindow()) });
    await f.call({ tool: 'Agent' });
    await f.call({ tool: 'Agent' });
    await f.finish();
    assert.equal(f.served(), 2, 'C: two Agent calls must serve twice in reserve mode');
    assert.equal(f.verdicts().length, 2, 'C: two reserve serves must produce two verdicts');
    assert.equal(f.injected().length, 2, 'C: two reserve serves must leave two complianceInjected entries');
    attributed(f, 'C', []);
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});

// D: a turn completion admitted during a held tool call returns after that call.
test('schedule D: a held call settles before an already-admitted turn completes', async () => {
  const f = host({ 'r.md': ruleText(toolTrigger('Agent'), bashWindow()) });
  const toolGate = gate(), turnGate = gate();
  const call = f.call({ tool: 'Agent' }, async () => { await toolGate.wait(); return {}; });
  try { await reached(toolGate, call, 'D tool'); } catch (error) { toolGate.open(); throw error; }
  const ending = f.handlers.get('turn.complete')(f.$, {}, async () => { await turnGate.wait(); return {}; });
  try { await reached(turnGate, ending, 'D turn'); } catch (error) { toolGate.open(); turnGate.open(); throw error; }
  toolGate.open();
  await call;
  turnGate.open();
  await ending;
  assert.equal(f.served(), 1, 'D: admitted Agent call must serve once');
  assert.deepEqual(f.verdicts().map(({ verdict, reason }) => [verdict, reason]),
    [['not applicable', 'turn ended']], 'D: turn completion must settle the one pending window');
  attributed(f, 'D', []);
});

// E: a non-journaling test call must be evaluated before the subsequent edit.
test('schedule E: a test before an edit remains followed across session lookup scheduling', async () => {
  const compliance = '    kind: test-before-edit\n    test-regex: npm test\n    path-regex: sample.js\n    window: 100\n    on-close: not applicable';
  const f = host({ 'r.md': ruleText(promptTrigger, compliance) });
  await f.prompt({ text: 'ready' });
  const held = gate();
  let once = true;
  f.$.session.id = async () => { if (once) { once = false; await held.wait(); } return 'fixture'; };
  const call = f.call({ tool: 'Bash', command: 'npm test' });
  let first;
  try {
    first = await Promise.race([held.entered.then(() => 'entered'), call.then(() => 'completed')]);
    if (first === 'completed') once = false;
    await f.call({ tool: 'Edit', path: 'sample.js' });
  } finally { held.open(); }
  await call;
  await f.finish();
  assert.equal(f.served(), 1, 'E: prompt must serve the test-before-edit rule once');
  // Where the test call looks its session up before evaluating (first === 'entered'), the Edit overtakes it here;
  // where it does not ('completed'), the schedule reduces to a sequential test then edit. Either way the verdict holds.
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['followed'], `E: test before edit must yield exactly one followed verdict (test call ${first})`);
  attributed(f, 'E', [/sample\.js/]);
});

// F: an initial failed session lookup must not prevent later journal writes.
test('schedule F: exhausted regex budget and transient session failure retain the journal', async () => {
  let clock = 0;
  const implementation = { ...hooks, register: (on, options) => hooks.register(on, options, () => clock += 3000) };
  const f = host({ 'r.md': ruleText(toolTrigger('Agent'), bashWindow()) }, implementation);
  let lookups = 0;
  f.$.session.id = async () => {
    lookups++;
    if (lookups === 1) throw Error('session temporarily unavailable');
    return 'fixture';
  };
  await f.call({ tool: 'Agent' });
  await f.finish();
  assert.equal(f.served(), 1, 'F: regex-budget exhaustion must still serve the rule');
  assert.equal(f.verdicts().length, 1, 'F: regex-budget exhaustion must produce one verdict');
  assert.equal(f.injected().filter((entry) => entry.rule === 'r.md').length, 1, 'F: later journal lookup must retain the served rule in this session');
  attributed(f, 'F', []);
});
