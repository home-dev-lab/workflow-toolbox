import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const { register, resetForSelftest } = await import(process.env.ROD_TEST_HOOKS ? pathToFileURL(process.env.ROD_TEST_HOOKS).href : '../hooks/hooks.js');

// The shared hooks worker answers its host ping only between awaits on host calls:
// no stretch of synchronous matching work may keep the event loop from turning longer than this.
// Relative bound: machine load stretches handler time and lag alike, while a missing yield makes lag ~ total.
const MAX_LAG_SHARE = 1 / 3;
const MIN_TOTAL_MS = 600;
const HARD_PATTERN = '[a-y]{1,40}[a-y]{1,40}[Q]\\d+[Z]';
const hardRule = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Bash$'\n      input-regex: '${HARD_PATTERN}'\n    - kind: 'prompt'\n      regex: '${HARD_PATTERN}'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nSynthetic instruction.\n`;
// Refuses (tool.call) or rides (prompt.submit) on the first event, so the result is never empty.
const guardRule = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Bash$'\n      unconditional: 'true'\n      before-first-act: 'true'\n    - kind: 'prompt'\n      regex: 'abc'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nGuard text.\n`;
const checkRule = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Bash$'\n      unconditional: 'true'\n  compliance:\n    kind: 'check'\n    check: 'agent-model'\n---\nCheck text.\n`;
const subject = 'abcdefghijklmnopqrstuvwxy'.repeat(700).slice(0, 1536);

// A budget clock that never advances makes exhaustion impossible, whatever the machine load.
const frozen = () => 0;

// Event-loop lag probe, independent of `$`: the longest stretch in which timers could not run.
function lagProbe() {
  let last = performance.now(), max = 0;
  const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last); last = now; }, 5);
  return { stop() { clearInterval(timer); return Math.max(max, performance.now() - last); } };
}

function build({ rules, clock = 'immediate', budgetClock = frozen }) {
  resetForSelftest();
  const handlers = new Map();
  const store = new Map();
  const logs = [];
  const state = { sleeps: 0 };
  register((name, handler) => handlers.set(name, handler), { enabled: true }, budgetClock);
  const files = rules.map((text, i) => ({ kind: 'file', name: `r${i}.md`, text }));
  const $ = {
    env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
    fs: {
      list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? files : [],
      read: async (path) => files[Number(/r(\d+)\.md$/.exec(path)[1])].text,
      stat: async (path) => ({ kind: 'file', size: 100, realPath: path }),
    },
    ui: { log: async (message) => { logs.push(String(message)); } },
    session: { id: async () => 'synthetic-session', messages: async () => [{ role: 'assistant' }] },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
    model: { classify: async () => 'followed' },
  };
  if (clock === 'immediate') $.clock = { sleep: () => { state.sleeps++; return new Promise((resolve) => setImmediate(resolve)); } };
  else if (typeof clock === 'function') $.clock = { sleep: (ms) => { state.sleeps++; return clock(ms); } };
  const run = async (name, args) => {
    const probe = lagProbe();
    const began = performance.now();
    let result, error;
    try { result = await handlers.get(name)($, { cwd: '/synthetic-project', ...args }, async (event) => ({ context: event.context ?? null })); } catch (caught) { error = caught; }
    const total = performance.now() - began;
    return { result, error, total, lag: probe.stop(), sleeps: state.sleeps, logs, store };
  };
  return run;
}

const heavy = (count) => [guardRule, ...Array.from({ length: count }, () => hardRule)];
const events = [
  ['tool.call', { tool: 'Bash', command: subject, input: { command: subject } }],
  ['prompt.submit', { text: subject }],
];
for (const [name, args] of events) {
  test(`${name}: synchronous matching lets the event loop turn within a third of the handler time`, async () => {
    const withClock = await build({ rules: heavy(150) })(name, args);
    assert.equal(withClock.error, undefined);
    assert.ok(withClock.total >= MIN_TOTAL_MS, `precondition: handler wall ${withClock.total.toFixed(0)} ms must be >= ${MIN_TOTAL_MS} (raise the rule count)`);
    assert.ok(withClock.lag <= withClock.total * MAX_LAG_SHARE, `longest event-loop lag ${withClock.lag.toFixed(0)} ms > ${(withClock.total * MAX_LAG_SHARE).toFixed(0)} ms (a third of ${withClock.total.toFixed(0)} ms)`);
    assert.ok(withClock.sleeps >= 1, 'clock.sleep was called');
    const without = await build({ rules: heavy(150), clock: null })(name, args);
    assert.ok(JSON.stringify(withClock.result) !== '{}' && JSON.stringify(withClock.result) !== '{"context":null}', 'result is not empty');
    assert.deepEqual(withClock.result, without.result, 'same result with and without clock');
  });
}

test('every rule loop yields: served check rules on a second call and the turn-end loop reach clock.sleep', async () => {
  // A fake Date.now that moves 60 ms per read makes every slice stale, so each loop iteration must call breathe.
  const realNow = Date.now; let tick = 0;
  Date.now = () => (tick += 60);
  try {
    const count = 20;
    const run = build({ rules: [guardRule, ...Array.from({ length: count }, () => checkRule)] });
    const args = { tool: 'Bash', command: 'echo ok', input: { command: 'echo ok' } };
    const first = await run('tool.call', args);
    assert.ok(first.result.deny, 'first call is refused and serves the rules');
    const before = first.sleeps;
    const second = await run('tool.call', args);
    assert.equal(second.error, undefined);
    assert.ok(second.sleeps - before >= 3 * count, `selected(), the check loop and the declarative loop each yield per rule: ${second.sleeps - before}`);
    const turnBefore = second.sleeps;
    const turn = await run('turn.complete', {});
    assert.ok(turn.sleeps - turnBefore >= count, `the turn-end correlation loop yields per rule: ${turn.sleeps - turnBefore}`);
  } finally { Date.now = realNow; }
});

test('a sleep that rejects makes the handler reject; a host without clock behaves as before', async () => {
  const boom = new Error('host aborted the hook call');
  const rejecting = await build({ rules: heavy(150), clock: () => Promise.reject(boom) })('tool.call', events[0][1]);
  assert.equal(rejecting.error, boom, 'the rejection propagates instead of reading as "no clock"');
  const without = await build({ rules: heavy(5), clock: null })('tool.call', events[0][1]);
  assert.equal(without.error, undefined);
  assert.ok(without.result.deny, 'no clock: same refusal as before');
});

test('time spent yielding is not charged to the regex budget', async () => {
  // A fake budget clock moves only while a yield sleeps (400 ms each, after the call returns its promise); matching never advances it.
  let now = 0;
  const sleepMs = 400;
  const run = build({ rules: heavy(150), budgetClock: () => now, clock: () => new Promise((resolve) => setImmediate(() => { now += sleepMs; resolve(); })) });
  const slow = await run('tool.call', events[0][1]);
  assert.equal(slow.error, undefined);
  assert.ok(slow.sleeps >= 5, `precondition: ${slow.sleeps} yields must push an uncorrected clock past the 2000 ms budget`);
  const journalled = JSON.stringify([...slow.store.values()]) + slow.logs.join('\n');
  assert.doesNotMatch(journalled, /budget exhausted|unevaluated/, 'no exhaustion is journalled or logged');
  const fast = await build({ rules: heavy(150), clock: null })('tool.call', events[0][1]);
  assert.deepEqual(slow.result, fast.result, 'same result as a run that never yielded');
});
