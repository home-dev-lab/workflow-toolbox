// A compaction the plugin is never told about still leaves the served set: a host may forward session.compact past
// every plugin a person installs. The host records every compaction as a `compact_boundary` row in the session's
// transcript; the main loop notes where the transcript ends when its context is created, then reads the rows added since
// its last look, at every turn end and when the live window gives a sign (its input tokens absent, then lower), and a
// boundary it has not seen resets the context. These tests write a real transcript file and run the plugin's real
// scanner as a child process, the way the host runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile, rm, readFile, rename, link } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostStore, hookFixture, sandboxRoot, bashRule } from './store-host-fake.mjs';
import { sumContexts, joinContexts } from '../scripts/delivery-join.mjs';
import { scanTranscript, boundaryRows, parseArgs, consume, identityOf, MAX_LINE_BYTES } from '../scripts/compact-boundary.mjs';
import { shippedFile } from '../paths.js';
import { externalTest } from './external-test.mjs';

const PUSH = { command: 'git push origin main' };
const served = (result) => JSON.stringify(result ?? {}).includes('<rule name=\\"sample.md\\">');
const idle = async () => ({});
let ids = 0;

// `$.process.run` as the host runs it: the real executable, a time limit, every exit code answered. Every run is
// recorded (its argv and options, and the answer), so a test can read what the hook asked for.
function realRun(state) {
  return (argv, init = {}) => {
    state.scans++;
    state.runs.push({ argv, init });
    if (state.hangScans) return new Promise((resolve) => state.hung.push(resolve));
    return new Promise((resolve) => {
      execFile(process.execPath, argv.slice(1), { timeout: init.timeoutMs ?? 30_000 }, (error, stdout, stderr) => {
        if (!error) state.answers.push(JSON.parse(stdout));
        resolve({ exitCode: exitCodeOf(error), stdout, stderr });
      });
    });
  };
}
const request = (run) => parseArgs(run.argv.slice(2));
function exitCodeOf(error) {
  if (!error) return 0;
  return typeof error.code === 'number' ? error.code : 1;
}
// A host whose live-window reading and history are set by the test; scans and usage readings are counted.
function world() {
  const state = { tokens: undefined, scans: 0, usageCalls: 0, hung: [], hangScans: false, runs: [], answers: [] };
  state.messages = async () => [{ role: 'assistant' }];
  state.usage = async () => { state.usageCalls++; return { startedAt: 0, context: { window: 200_000, ...(state.tokens === undefined ? {} : { tokens: state.tokens }) }, rateLimits: [] }; };
  return state;
}
async function fixture(t, state, extra = {}) {
  const store = hostStore();
  const f = await hookFixture(await sandboxRoot(t, 'rod-compact-'), store, {
    messages: (args) => state.messages(args), usage: () => state.usage(), processRun: realRun(state), ...extra });
  const transcript = join(f.config, 'projects', f.project.replace(/[^A-Za-z0-9-]/g, '-'), 'sample-session.jsonl');
  await mkdir(dirname(transcript), { recursive: true });
  await writeFile(transcript, `${JSON.stringify({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'go' } })}\n`);
  return { ...f, store, transcript };
}
// What the host writes after a compaction; `sidechain` is a sub-agent's own.
async function compacted(f, { at = new Date(), sidechain = false } = {}) {
  const uuid = `boundary-${++ids}`;
  await appendFile(f.transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', isSidechain: sidechain, uuid, timestamp: at.toISOString(), compactMetadata: { trigger: 'manual' } })}\n`);
  return uuid;
}
const resets = (f, session = 'sample-session') => f.store.snapshot().sessions?.[session]?.contexts?.['0']?.resets ?? {};
const prompt = (f, text = 'go', next = idle) => f.handlers.get('prompt.submit')(f.$, { cwd: f.project, text }, next);
const turnEnd = (f) => f.handlers.get('turn.complete')(f.$, { cwd: f.project }, idle);
const dispatch = (f) => f.handlers.get('session.compact')(f.$, { cwd: f.project }, idle);
const spinUntil = async (done, limit = 2_000) => { for (let spin = 0; !done() && spin < limit; spin++) await new Promise((resolve) => setImmediate(resolve)); };
const until = async (done, ms = 5_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20)); };

// Serve the rule in main, with a growing live window.
async function servedOnce(f, state) {
  state.tokens = 1_000;
  assert.ok(served(await f.call({ ...PUSH })), 'the first call serves the rule');
  state.tokens = 5_000;
  assert.equal(served(await f.call({ ...PUSH })), false, 'once per context');
}

test('A. /compact the plugin was not told about: the boundary row resets the context and the rule is served again', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  state.tokens = undefined;
  assert.ok(served(await f.call({ ...PUSH })), 'the absent reading scanned the transcript: served again');
  const scans = state.scans;
  state.tokens = 1_200;
  assert.equal(served(await f.call({ ...PUSH })), false, 'once again per context afterwards');
  assert.equal(state.scans, scans, 'the reset dropped the old baseline: the first reading after it is no sign');
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'one reset, journaled apart from session.compact');
});

test('A. an automatic compaction with no token sign is caught at that turn\'s end', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  state.tokens = 6_000;
  assert.equal(served(await f.call({ ...PUSH })), false, 'no sign mid-turn: nothing scanned yet');
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
  const scans = state.scans;
  state.tokens = 1_200;
  assert.ok(served(await f.call({ ...PUSH })), 'served again after the turn end');
  assert.equal(state.scans, scans, 'the reset dropped the old baseline: the next turn\'s lower reading is no sign');
});

test('A. a boundary written 150 ms after the sign is found by the follow-up scans, before the next prompt', { timeout: 10_000 }, async (t) => {
  const state = world();
  const f = await fixture(t, state, { clock: realClock() });
  await servedOnce(f, state);
  state.tokens = undefined;
  setTimeout(() => { void compacted(f); }, 150);
  assert.equal(served(await f.call({ ...PUSH })), false, 'the row is not written yet');
  await until(() => resets(f)['compaction-detected'] === 1);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'a later scan found it, with no event in between');
  await prompt(f);
  assert.ok(served(await f.call({ ...PUSH })), 'served again');
});

test('A. a prompt is the first event after the compaction: the prompt itself serves its rule again', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await writeFile(join(f.config, 'rules-on-demand', 'audit.md'), bashRule.replace("kind: 'bash'\n      regex: 'git push'", "kind: 'prompt'\n      regex: 'audit'").replace('Check destination.', 'Audit carefully.'));
  let seen = [];
  const capture = async (e) => { seen = e.context ?? []; return {}; };
  state.tokens = 1_000;
  await prompt(f, 'audit this', capture);
  assert.ok(seen.some((text) => text.includes('<rule name="audit.md">')), 'the prompt serves its rule');
  state.tokens = 5_000;
  await prompt(f, 'audit again', capture);
  assert.equal(seen.some((text) => text.includes('<rule name="audit.md">')), false, 'once per context');
  await compacted(f);
  state.tokens = undefined;
  await prompt(f, 'audit after', capture);
  assert.ok(seen.some((text) => text.includes('<rule name="audit.md">')), 'the prompt saw the compaction itself');
});

test('A. parallel calls after the compaction: one reset, and the triggering call serves the rule', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  state.tokens = undefined;
  const [other, push] = await Promise.all([f.call({ command: 'ls' }), f.call({ ...PUSH })]);
  assert.equal(served(other), false);
  assert.ok(served(push), 'the triggering call, admitted while the reset ran, serves the rule');
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
});

test('A. a summary that keeps the rule\'s opening lines does not hide the compaction: the boundary decides', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  state.messages = async (args) => (args?.as === 'api'
    ? [{ role: 'user', content: [{ type: 'text', text: 'Previously served:\n<rule name="sample.md">\nCheck destination.\n[remaining instructions omitted]' }] }]
    : [{ role: 'assistant' }]);
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
  assert.ok(served(await f.call({ ...PUSH })));
});

// Three turns, each with a call that triggers the rule; the conversation holds whatever form `conversation` gives.
async function threeTurns(f, state, conversation) {
  let deliveries = 0;
  for (let turn = 0; turn < 3; turn++) {
    state.tokens = 1_000 * (turn + 1);
    const result = await f.call({ ...PUSH });
    if (served(result)) { deliveries++; const held = conversation(result.context); state.messages = async (args) => (args?.as === 'api' ? held : [{ role: 'assistant' }]); }
    await turnEnd(f);
  }
  return deliveries;
}
const holding = (...texts) => [{ role: 'user', content: [{ type: 'text', text: texts.join('\n') }] }];
// Assembled at run time so this file never carries a detectable literal.
const credential = () => ['xox', 'b-1234567890', '-abcdefABCDEF1234567890ab'].join('');
const scrubTest = externalTest('../../wt-secret-guard/hooks/scrub.js', import.meta.url);

scrubTest('A. a block another plugin rewrote, with no compaction, is never reset: one delivery across three turns', async (t, url) => {
  const { scrubSettled } = await import(url);
  const state = world();
  const f = await fixture(t, state);
  await writeFile(join(f.config, 'rules-on-demand', 'sample.md'), bashRule.replace('Check destination.', () => `Export TOKEN=${credential()} before a push.`));
  const scrub = (context) => {
    const scrubbed = scrubSettled({ context }, '', true, new Set(), { complete: true });
    assert.ok(scrubbed.changed, 'the scrubber rewrote the block');
    return holding(...scrubbed.value.context);
  };
  assert.equal(await threeTurns(f, state, scrub), 1);
  assert.deepEqual(resets(f), {});
});

test('A. a block the host split into two text parts, with no compaction, is never reset', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const split = ([text]) => [{ role: 'user', content: [{ type: 'text', text: text.slice(0, 10) }, { type: 'text', text: text.slice(10) }] }];
  assert.equal(await threeTurns(f, state, split), 1);
  assert.deepEqual(resets(f), {});
});

test('B. session.compact plus the boundary it writes: one reset, the dispatched one', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await dispatch(f);
  await compacted(f);
  state.tokens = undefined;
  await prompt(f);
  assert.ok(served(await f.call({ ...PUSH })), 'served again after session.compact');
  await turnEnd(f);
  assert.deepEqual(resets(f), { compaction: 1 }, 'its boundary does not reset a second time');
});

test('B. session.compact, a rule served, then its boundary found at the turn end: still one reset', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await dispatch(f);
  state.tokens = 6_000;
  assert.ok(served(await f.call({ ...PUSH })), 'served again after session.compact');
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { compaction: 1 }, 'the boundary was the dispatched compaction\'s own');
  assert.equal(served(await f.call({ ...PUSH })), false, 'not served a third time');
});

test('B. a boundary found first, then the dispatched session.compact of that compaction: one reset', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  await dispatch(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'nothing served since the detected reset: the dispatched one skips');
  assert.ok(served(await f.call({ ...PUSH })), 'served again once');
});

test('B. a rule served after a reset makes the next compaction reset again', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  assert.ok(served(await f.call({ ...PUSH })));
  await dispatch(f);
  assert.ok(served(await f.call({ ...PUSH })), 'the dispatched compaction forgot the new serve');
  assert.deepEqual(resets(f), { 'compaction-detected': 1, compaction: 1 });
});

test('B. two compactions with nothing served between: each boundary resets once', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 2 });
});

// A monotonic clock the test moves forward: performance.now() plus `shift`.
function shiftedNow(t) {
  const real = performance.now.bind(performance), moved = { shift: 0 };
  t.mock.method(performance, 'now', () => real() + moved.shift);
  return moved;
}

test('B. a dispatched session.compact whose boundary never comes stops being expected after the plan\'s lifetime, not at the turn end', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const clock = shiftedNow(t);
  await servedOnce(f, state);
  await dispatch(f);
  await turnEnd(f);
  assert.ok(served(await f.call({ ...PUSH })), 'served again after session.compact');
  clock.shift = 9_000;
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { compaction: 1 }, 'an empty turn end and 9 s did not clear the expectation: its boundary resets nothing');
  await dispatch(f);
  clock.shift = 19_001;
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { compaction: 2, 'compaction-detected': 1 }, 'past 10 s the boundary is a compaction of its own');
});

test('B. the same boundary read again, from a replaced or truncated transcript, resets once', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  assert.ok(served(await f.call({ ...PUSH })));
  await appendFile(f.transcript, `${JSON.stringify({ type: 'user', uuid: 'u-after' })}\n`);
  const text = await readFile(f.transcript, 'utf8');
  // Another file (a new inode: written beside, then renamed over), as long as the old one: read again from 0.
  await writeFile(`${f.transcript}.new`, text);
  await rename(`${f.transcript}.new`, f.transcript);
  await turnEnd(f);
  // Shorter than the last offset, the boundary row still whole: read again from 0.
  await writeFile(f.transcript, text.slice(0, text.length - 5));
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'a uuid counts once');
  assert.equal(served(await f.call({ ...PUSH })), false);
});

test('B. a boundary already in the transcript when the context is created is an earlier context\'s', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await compacted(f, { at: new Date(Date.now() - 60_000) });
  await servedOnce(f, state);
  await turnEnd(f);
  await writeFile(f.transcript, `${JSON.stringify({ type: 'user', uuid: 'u1' })}\n`);
  await compacted(f, { at: new Date(Date.now() - 60_000) });
  await turnEnd(f);
  assert.deepEqual(resets(f), {}, 'neither the boundary before the snapshot nor an old one in a rewritten file resets');
});

test('B. a boundary row without a timestamp counts when it was written after the context was created', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const bare = (uuid) => appendFile(f.transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid })}\n`);
  await bare('old-bare');
  await servedOnce(f, state);
  await turnEnd(f);
  assert.deepEqual(resets(f), {}, 'before the context: never read');
  await bare('new-bare');
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'written past the cursor: this context\'s, with no date needed');
});

test('B. a clock set back: a boundary dated before the context, written after it, still resets', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f, { at: new Date(Date.now() - 3_600_000) });
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'the cursor decides, never the row\'s date');
});

test('B. a row a re-read from the start rejected for its age is not remembered: written again past the cursor, it counts', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  const size = (await readFile(f.transcript)).length;
  const old = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'old-row', timestamp: new Date(Date.now() - 3_600_000).toISOString() });
  // The same file, rewritten in place: other bytes before the cursor, so the scan reads it again from 0.
  await writeFile(f.transcript, `${old}\n${'x'.repeat(size)}\n`);
  await turnEnd(f);
  assert.deepEqual(resets(f), {}, 'dated an hour before the last scan: an earlier conversation\'s');
  await appendFile(f.transcript, `${old}\n`);
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'past the cursor its uuid was never marked seen');
});

test('B. a transcript truncated, then written again past the cursor (1029 then 2143 bytes): the bytes before the cursor changed, so it is read again', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const line = (n) => `${JSON.stringify({ type: 'user', uuid: 'u-pad', pad: 'p'.repeat(n) })}\n`;
  const first = line(1029 - line(0).length);
  assert.equal(first.length, 1029);
  await writeFile(f.transcript, first);
  await servedOnce(f, state);
  assert.equal(request(state.runs[0]).snapshot, true);
  assert.equal(state.answers[0].offset, 1029, 'the cursor starts at 1029');
  const boundary = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'regrown', timestamp: new Date().toISOString() })}\n`;
  const rest = 2143 - boundary.length;
  await writeFile(f.transcript, `${boundary}${line(rest - line(0).length)}`);
  assert.equal((await readFile(f.transcript)).length, 2143);
  await turnEnd(f);
  assert.equal(state.answers.at(-1).restarted, true, 'the fingerprint before 1029 no longer matched');
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
});

const BACKOFF = [100, 200, 400, 800, 1_600, 3_200];
const isBackoff = (wait) => BACKOFF.includes(wait.ms);
// Ends every back-off wait of the plans in flight, one at a time, until none is asked for; a scan's own deadline wait
// is never passed, so each scan answers on its own.
async function drainPlans(gate) {
  for (let round = 0; round < 40; round++) {
    await until(() => gate.waits.some(isBackoff), 500);
    if (!gate.waits.some(isBackoff)) return;
    gate.passWhere(isBackoff);
  }
}

test('C. no compaction: each turn end scans, a turn scans once mid-turn at most, and a sign\'s plan scans six times then ends', async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  assert.equal(state.scans, 2, 'creating the context notes where the transcript ends; the next call, with a rule served, confirms it once');
  for (let n = 0; n < 20; n++) {
    state.tokens = 6_000 + n * 100;
    if (n % 5 === 0) await prompt(f);
    assert.equal(served(await f.call({ ...PUSH })), false, `call ${n}: not served again`);
    if (n % 5 === 4) await turnEnd(f);
  }
  assert.equal(state.scans, 9, 'then each turn end, and the first event of each later turn (a rule is served): one confirming scan');
  const before = state.scans;
  state.tokens = undefined;
  for (let n = 0; n < 6; n++) await f.call({ ...PUSH });
  for (const tokens of [4_000, 3_000, 2_000]) { state.tokens = tokens; await f.call({ ...PUSH }); }
  assert.equal(state.scans - before, 1, 'one absent sign (also the turn\'s confirming scan), then falling readings: one mid-turn scan');
  await turnEnd(f);
  assert.equal(state.scans - before, 2, 'and the turn end');
  await drainPlans(gate);
  assert.equal(state.scans - before, 8, 'the turn end left the sign\'s plan running: six back-off scans, then it ended');
  assert.deepEqual(gate.asked.filter((ms) => BACKOFF.includes(ms)), BACKOFF, 'after 0.1, 0.3, 0.7, 1.5, 3.1 and 6.3 s');
  state.tokens = undefined;
  await f.call({ ...PUSH });
  await turnEnd(f);
  assert.equal(state.scans - before, 10, 'absent after a reading: one sign scan, and the turn end');
  await f.call({ ...PUSH });
  assert.equal(state.scans - before, 11, 'still absent in the next turn: the same sign, no sign scan; only that turn\'s confirming scan');
  await f.call({ ...PUSH });
  assert.equal(state.scans - before, 11, 'and once per turn');
  await drainPlans(gate);
  assert.equal(state.scans - before, 17, 'the second sign\'s plan: six scans');
  assert.deepEqual(resets(f), {});
});

test('C. a plan ends at its lifetime, however many back-offs remain', async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  const clock = shiftedNow(t);
  await servedOnce(f, state);
  state.tokens = undefined;
  await f.call({ ...PUSH });
  const before = state.scans;
  await until(() => gate.waits.some(isBackoff));
  gate.passWhere(isBackoff);
  await until(() => state.scans > before);
  assert.equal(state.scans, before + 1, 'the first back-off scanned');
  await until(() => gate.waits.some(isBackoff));
  clock.shift = 10_001;
  await drainPlans(gate);
  assert.equal(state.scans, before + 1, 'past 10 s the plan scans no more');
});

test('D. agent contexts are unaffected, and a sub-agent\'s boundary row resets nothing', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  assert.ok(served(await f.call({ ...PUSH, agentId: 'x' })), 'the agent is served in its own context');
  await compacted(f, { sidechain: true });
  await turnEnd(f);
  assert.deepEqual(resets(f), {}, 'a sidechain boundary is not the main loop\'s');
  await compacted(f);
  const scans = state.scans;
  assert.equal(served(await f.call({ ...PUSH, agentId: 'x' })), false, 'an agent event does not run the main detection');
  assert.equal(state.scans, scans, 'an agent\'s call reads no transcript');
  await turnEnd(f);
  assert.ok(served(await f.call({ ...PUSH })), 'the main loop detects it at its turn end');
  assert.equal(served(await f.call({ ...PUSH, agentId: 'x' })), false, 'the main reset leaves the agent served');
  const afterMain = state.scans;
  await compacted(f);
  await f.handlers.get('turn.complete')(f.$, { cwd: f.project, agentId: 'x' }, idle);
  assert.equal(state.scans, afterMain, 'an agent\'s turn end reads no transcript');
});

test('E. a host without session.usage still detects at the turn end, and says nothing', async (t) => {
  const state = world();
  const f = await fixture(t, state, { usage: undefined });
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  assert.ok(served(await f.call({ ...PUSH })));
  assert.deepEqual(f.logs.filter((line) => /unavailable/.test(line)), []);
});

test('E. a host without child runs reads nothing and says nothing; session.compact resets as before', async (t) => {
  const state = world();
  const f = await fixture(t, state, { processRun: undefined });
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  assert.equal(served(await f.call({ ...PUSH })), false, 'nothing to read the transcript with');
  assert.deepEqual(f.logs.filter((line) => /unavailable/.test(line)), []);
  await dispatch(f);
  assert.ok(served(await f.call({ ...PUSH })), 'the dispatched compaction resets as before');
});

test('E. a scan that fails is told once and loses nothing: the next readable scan finds the boundary', async (t) => {
  const state = world();
  const run = realRun(state);
  let broken = false;
  const f = await fixture(t, state, { processRun: (argv, init) => (broken ? Promise.resolve({ exitCode: 2, stdout: '', stderr: 'disk said no' }) : run(argv, init)) });
  await servedOnce(f, state);
  broken = true;
  await compacted(f);
  await turnEnd(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), {}, 'unreadable: no reset');
  assert.equal(f.logs.filter((line) => /transcript cannot be read: scanner exit 2: disk said no/.test(line)).length, 1, f.logs.join('\n'));
  broken = false;
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'the cursor did not move past it');
});

test('E. a transcript unreadable when the context is created: the cursor opens at the first readable scan, and what came before it is not read', async (t) => {
  const state = world();
  const run = realRun(state);
  let broken = true;
  const f = await fixture(t, state, { processRun: (argv, init) => (broken ? Promise.resolve({ exitCode: 2, stdout: '', stderr: 'disk said no' }) : run(argv, init)) });
  await servedOnce(f, state);
  await compacted(f);
  broken = false;
  await turnEnd(f);
  assert.equal(request(state.runs[0]).snapshot, true, 'the first readable scan only notes where the transcript ends');
  assert.deepEqual(resets(f), {}, 'a boundary written while unreadable is missed (session.compact, where dispatched, still resets)');
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'from there on, every boundary counts');
  assert.equal(f.logs.filter((line) => /transcript cannot be read/.test(line)).length, 1);
});

test('E. a transcript that is not where the root says (a long path, /cd) is found by its session file name', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const moved = join(f.config, 'projects', 'elsewhere', 'sample-session.jsonl');
  await mkdir(dirname(moved), { recursive: true });
  await writeFile(moved, `${JSON.stringify({ type: 'user', uuid: 'u0' })}\n`);
  await rm(f.transcript);
  await servedOnce(f, state);
  await compacted({ transcript: moved });
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
});

test('F. reset counts from two segments of one context are summed when the journal is joined', () => {
  const joined = sumContexts({ resets: { compaction: 1 } }, { resets: { compaction: 2, 'compaction-detected': 1 } });
  assert.deepEqual(joined.resets, { compaction: 3, 'compaction-detected': 1 });
});

test('F. copies of one context take the maximum of their reset counts, never their sum', () => {
  const joined = joinContexts({ resets: { compaction: 1 } }, { resets: { compaction: 1, 'compaction-detected': 2 } });
  assert.deepEqual(joined.resets, { compaction: 1, 'compaction-detected': 2 });
});

// A host clock whose deadline waits end only when the test passes them; a zero wait (a yield) ends at once.
function gatedClock() {
  const waits = [], asked = [];
  const sleep = (ms, options = {}) => (!ms ? Promise.resolve() : new Promise((resolve, reject) => {
    const wait = { ms, resolve };
    waits.push(wait);
    asked.push(ms);
    options.signal?.addEventListener('abort', () => {
      const at = waits.indexOf(wait);
      if (at >= 0) waits.splice(at, 1);
      reject(new Error('aborted'));
    }, { once: true });
  }));
  const passWhere = (chosen) => {
    for (const wait of waits.filter(chosen)) { waits.splice(waits.indexOf(wait), 1); wait.resolve(); }
  };
  return { clock: { now: async () => Date.now(), sleep }, waits, asked, pass: () => passWhere(() => true), passWhere };
}
function realClock() {
  const sleep = (ms, options = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  return { now: async () => Date.now(), sleep };
}

test('R-B. a scan that never answers is unreadable past its deadline: the call, a later tool call and a prompt go on', { timeout: 10_000 }, async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  state.hangScans = true;
  state.tokens = undefined;
  const call = f.call({ ...PUSH });
  await spinUntil(() => state.hung.length > 0);
  gate.pass();
  assert.equal(served(await call), false, 'past the deadline the transcript counts as unreadable');
  assert.ok(gate.asked.includes(6_000), 'the scan waited for its deadline');
  await prompt(f);
  await turnEnd(f);
  assert.equal(state.hung.length, 1, 'the child still runs: the turn end reads nothing and starts no second one');
  assert.deepEqual(resets(f), {});
  for (const resolve of state.hung) resolve({ exitCode: 1, stdout: '', stderr: '' });
});

test('R-B. a history read at prompt.context that never answers: past the deadline the prompt goes on', { timeout: 10_000 }, async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  const answers = [];
  state.messages = () => new Promise((resolve) => answers.push(resolve));
  let reached = false;
  const done = f.handlers.get('prompt.context')(f.$, { cwd: f.project }, async () => { reached = true; return {}; });
  await spinUntil(() => answers.length > 0);
  gate.pass();
  await done;
  assert.ok(reached, 'the prompt went on');
  assert.equal(served(await f.call({ ...PUSH })), false, 'the context was kept: a later tool call goes on');
  for (const resolve of answers) resolve([]);
});

test('R-B. a usage() past its deadline pauses the mid-turn readings; the next answer resumes them', { timeout: 10_000 }, async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  const healthy = state.usage, answers = [];
  state.usage = () => new Promise((resolve) => answers.push(resolve));
  const call = f.call({ ...PUSH });
  await spinUntil(() => answers.length > 0);
  gate.pass();
  await call;
  state.usage = healthy;
  const calls = state.usageCalls;
  await f.call({ ...PUSH });
  assert.equal(state.usageCalls, calls, 'paused mid-turn');
  await turnEnd(f);
  assert.equal(state.usageCalls, calls + 1, 'the turn end reads it');
  await f.call({ ...PUSH });
  assert.equal(state.usageCalls, calls + 2, 'resumed after an answer');
  assert.equal(f.logs.filter((line) => /live window readings paused/.test(line)).length, 1, f.logs.join('\n'));
  for (const resolve of answers) resolve({});
});

test('P. a sign, an empty scan, then the turn end, and the boundary written 135 ms later: reset before the next prompt', { timeout: 10_000 }, async (t) => {
  const state = world();
  const f = await fixture(t, state, { clock: realClock() });
  await servedOnce(f, state);
  state.tokens = undefined;
  assert.equal(served(await f.call({ ...PUSH })), false, 'the row is not written yet');
  await turnEnd(f);
  assert.deepEqual(resets(f), {}, 'the turn end found nothing either');
  setTimeout(() => { void compacted(f); }, 135);
  await until(() => resets(f)['compaction-detected'] === 1);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'the sign\'s plan outlived the turn end and found it');
  await prompt(f);
  assert.ok(served(await f.call({ ...PUSH })), 'served again');
});

test('P. session.compact, an empty turn-end scan, then its boundary 135 ms later: one reset, and the next boundary is a compaction of its own', { timeout: 10_000 }, async (t) => {
  const state = world();
  const f = await fixture(t, state, { clock: realClock() });
  await servedOnce(f, state);
  await dispatch(f);
  await turnEnd(f);
  setTimeout(() => { void compacted(f); }, 135);
  await until(() => state.answers.some((answer) => answer.boundaries.length > 0));
  assert.ok(state.answers.some((answer) => answer.boundaries.length > 0), 'the plan read the boundary, with no event after the turn end');
  await until(() => false, 300);
  assert.deepEqual(resets(f), { compaction: 1 }, 'the plan found the dispatched compaction\'s own boundary');
  const scans = state.scans;
  await until(() => false, 1_000);
  assert.equal(state.scans, scans, 'served: the plan ended');
  await turnEnd(f);
  assert.deepEqual(resets(f), { compaction: 1 }, 'the next turn end has nothing new');
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { compaction: 1, 'compaction-detected': 1 }, 'the expectation was spent once');
});

test('P. a session that changes (/clear without a prompt.context): the next scan reads the new transcript, from where it ends, and resets', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const other = join(dirname(f.transcript), 'other-session.jsonl');
  await writeFile(other, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'other-old', timestamp: new Date().toISOString() })}\n`);
  let session = 'sample-session';
  f.$.session.id = async () => session;
  await servedOnce(f, state);
  session = 'other-session';
  await turnEnd(f);
  const opened = request(state.runs.at(-1));
  assert.deepEqual([opened.file, opened.snapshot], [other, true], 'the new transcript, noted where it ends');
  assert.deepEqual(resets(f, 'other-session'), { 'session-changed': 1 }, 'a new conversation holds no rule (journaled under its own session)');
  assert.ok(served(await f.call({ ...PUSH })), 'served again');
  await compacted({ transcript: other });
  await turnEnd(f);
  assert.equal(request(state.runs.at(-1)).file, other);
  assert.deepEqual(resets(f, 'other-session'), { 'session-changed': 1, 'compaction-detected': 1 }, 'its compactions are detected; its earlier row is not');
});

test('P. a sign that finds a new session starts no re-scan plan: no boundary follows a cleared conversation', async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await writeFile(join(dirname(f.transcript), 'other-session.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u-other' })}\n`);
  let session = 'sample-session';
  f.$.session.id = async () => session;
  await servedOnce(f, state);
  session = 'other-session';
  state.tokens = undefined;
  await f.call({ ...PUSH });
  assert.deepEqual(resets(f, 'other-session'), { 'session-changed': 1 });
  await spinUntil(() => false, 200);
  assert.deepEqual(gate.waits.filter(isBackoff), [], 'no back-off asked');
});

test('P. session.compact while a sign\'s plan runs joins it: the plan also finds a second, later boundary before the turn ends', { timeout: 15_000 }, async (t) => {
  const state = world();
  const f = await fixture(t, state, { clock: realClock() });
  await servedOnce(f, state);
  state.tokens = undefined;
  await f.call({ ...PUSH });
  await dispatch(f);
  setTimeout(() => { void compacted(f); }, 135);
  setTimeout(() => { void compacted(f); }, 1_000);
  await until(() => resets(f)['compaction-detected'] === 1, 8_000);
  assert.deepEqual(resets(f), { compaction: 1, 'compaction-detected': 1 }, 'the plan waited for both, with no turn end');
});

test('P. a large transcript already there when the context is created is never read', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const filler = `${JSON.stringify({ type: 'user', pad: 'p'.repeat(1_000) })}\n`;
  await writeFile(f.transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'earlier', timestamp: new Date().toISOString() })}\n${filler.repeat(4_000)}`);
  const size = (await readFile(f.transcript)).length;
  await servedOnce(f, state);
  await turnEnd(f);
  assert.equal(request(state.runs[0]).snapshot, true, 'creation only notes the end');
  assert.equal(request(state.runs[1]).from, size, 'the turn end starts there');
  assert.deepEqual(resets(f), {}, 'the earlier boundary, dated now, is never read');
});

// A host run whose next scan after `armed` is set (a snapshot excepted) reads in 1 KiB chunks under a 2 ms budget, so it
// stops part-way; every other run is the real one.
function budgetCut(state) {
  const run = realRun(state);
  const cut = { armed: false };
  cut.run = (argv, init) => {
    if (!cut.armed || argv.includes('--snapshot')) return run(argv, init);
    cut.armed = false;
    state.runs.push({ argv, init });
    let tick = 0;
    const scan = scanTranscript({ ...parseArgs(argv.slice(2)), budgetMs: 2 }, { chunkBytes: 1_024, now: () => tick++ });
    state.answers.push(scan);
    return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(scan), stderr: '' });
  };
  return cut;
}

test('P. a scan that stopped at its budget: the next scan resumes from the offset it reached', async (t) => {
  const state = world();
  const cut = budgetCut(state);
  const f = await fixture(t, state, { processRun: cut.run });
  await servedOnce(f, state);
  const start = state.answers[0].offset;
  await appendFile(f.transcript, `${JSON.stringify({ type: 'user', pad: 'p'.repeat(200) })}\n`.repeat(200));
  await compacted(f);
  cut.armed = true;
  await turnEnd(f);
  const reached = state.answers.at(-1);
  assert.ok(reached.partial && reached.offset > start, 'stopped part-way');
  assert.deepEqual(resets(f), {});
  await turnEnd(f);
  assert.equal(request(state.runs.at(-1)).from, reached.offset, 'resumed where the budget stopped it');
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
});

test('P. a scan that never answers plus a concurrent turn end: one child, one deadline, inside the hook budget', { timeout: 30_000 }, async (t) => {
  const state = world();
  const f = await fixture(t, state, { clock: realClock() });
  await servedOnce(f, state);
  state.hangScans = true;
  state.tokens = undefined;
  const began = Date.now();
  const call = f.call({ ...PUSH });
  await spinUntil(() => state.hung.length > 0);
  await Promise.all([call, turnEnd(f)]);
  const took = Date.now() - began;
  assert.equal(state.hung.length, 1, 'the turn end waited on that child, and started none');
  assert.ok(took < 8_000, `one 6 s deadline, not two: ${took} ms`);
  for (const resolve of state.hung) resolve({ exitCode: 1, stdout: '', stderr: '' });
});

test('P. session.compact while a detection scan runs waits for it: the boundary it finds is the reset, the dispatched one skips', async (t) => {
  const state = world();
  const run = realRun(state);
  let hold = null, release;
  const f = await fixture(t, state, { processRun: (argv, init) => (hold ? hold.then(() => run(argv, init)) : run(argv, init)) });
  await servedOnce(f, state);
  await compacted(f);
  hold = new Promise((resolve) => { release = resolve; });
  state.tokens = undefined;
  const call = f.call({ ...PUSH });
  await spinUntil(() => false, 50);
  const dispatched = dispatch(f);
  await spinUntil(() => false, 50);
  hold = null;
  release();
  await Promise.all([call, dispatched]);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
});

test('P. every scan runs `node` on the shipped scanner under a 5 s limit, with a reading budget, the file identity and its fingerprint', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  await turnEnd(f);
  assert.equal(state.runs.length, 4, 'the snapshot, the confirming scan of the served rule, two turn ends');
  for (const { argv, init } of state.runs) {
    assert.equal(argv[0], 'node');
    assert.equal(argv[1], fileURLToPath(new URL('../scripts/compact-boundary.mjs', import.meta.url)).replace(/\\/g, '/'));
    assert.equal(init.timeoutMs, 5_000);
  }
  for (const run of state.runs.slice(1)) {
    const asked = request(run);
    assert.deepEqual([asked.snapshot, asked.budgetMs], [false, 3_000]);
    assert.ok(asked.identity && asked.tail, 'identity and fingerprint passed');
  }
  for (let n = 2; n < state.runs.length; n++) assert.equal(request(state.runs[n]).from, state.answers[n - 1].offset, 'each scan starts where the last one stopped');
});

// Every context of a session, its resets summed: a prompt.context that starts a new main context journals under a new key.
const sessionResets = (f, session = 'sample-session') => Object.values(f.store.snapshot().sessions?.[session]?.contexts ?? {})
  .reduce((sum, ctx) => {
    for (const [reason, n] of Object.entries(ctx.resets ?? {})) { sum[reason] = (sum[reason] ?? 0) + n; }
    return sum;
  }, {});
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

test('H. a compaction between the cursor and the history read of a new context: the held block is dropped and the rule served again', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  state.tokens = 1_000;
  const first = await f.call({ ...PUSH });
  assert.ok(served(first), 'served in the first context');
  let armed = true;
  // A plain read with no assistant message makes prompt.context start a new main context; its history read (as: 'api')
  // still holds the served block, and the compaction's boundary is written while that read is in flight.
  state.messages = async (args) => {
    if (args?.as !== 'api') return [];
    if (armed) { armed = false; await compacted(f); }
    return holding(...first.context);
  };
  await f.handlers.get('prompt.context')(f.$, { cwd: f.project }, idle);
  assert.equal(armed, false, 'the history read ran');
  assert.ok(served(await f.call({ ...PUSH })), 'the boundary after the cursor reset the context: served again');
  assert.deepEqual(sessionResets(f), { 'compaction-detected': 1 });
});

test('H. a tool call that creates the context over a conversation holding the rule, a compaction during its history read: that call serves', async (t) => {
  const earlier = world();
  const first = await (await fixture(t, earlier)).call({ ...PUSH });
  assert.ok(served(first), 'the block the conversation will hold');
  const state = world();
  const f = await fixture(t, state);
  let armed = true;
  // Nothing is served in the new context yet: only the held conversation says a rule counts as served, so only it can
  // ask the confirming scan before the call's rules are loaded and the held block withholds the rule.
  state.messages = async (args) => {
    if (args?.as !== 'api') return [{ role: 'assistant' }];
    if (armed) { armed = false; await compacted(f); }
    return holding(...first.context);
  };
  state.tokens = 1_000;
  assert.ok(served(await f.call({ ...PUSH })), 'the call that created the context found the boundary first: served');
  assert.equal(armed, false, 'the history read ran');
  assert.deepEqual(sessionResets(f), { 'compaction-detected': 1 });
});

test('P. a boundary written 200 ms after an empty turn-end scan, with no token sign: the next triggering call confirms first, and serves', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  state.tokens = 6_000;
  await turnEnd(f);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await compacted(f);
  state.tokens = 7_000;
  assert.ok(served(await f.call({ ...PUSH })), 'served again');
  assert.deepEqual(resets(f), { 'compaction-detected': 1 });
});

test('P. a re-read from 0 stopped by its budget keeps its date filter on the scan that continues it', async (t) => {
  const state = world();
  const cut = budgetCut(state);
  const f = await fixture(t, state, { processRun: cut.run });
  await servedOnce(f, state);
  const old = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'old-far', timestamp: hourAgo() });
  // The same file rewritten in place: other bytes before the cursor, and the hour-old row far past what one budget reads.
  const filler = `${JSON.stringify({ type: 'user', pad: 'p'.repeat(300) })}\n`.repeat(100);
  await writeFile(f.transcript, `${filler}${old}\n`);
  cut.armed = true;
  await turnEnd(f);
  const first = state.answers.at(-1);
  assert.deepEqual([first.restarted, first.partial], [true, true], 'a re-read from 0, stopped part-way');
  await turnEnd(f);
  assert.equal(state.answers.at(-1).restarted, false, 'the continuation is not a re-read itself');
  assert.deepEqual(resets(f), {}, 'the hour-old row read by the continuation is still an earlier conversation\'s');
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'past the end of the re-read, a new row counts');
});

test('P. a session id that never answers while a scan prepares: the check returns at the scan deadline, and a later scan starts', { timeout: 10_000 }, async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  const healthy = f.$.session.id;
  const hung = [];
  let stuck = true;
  // Only the scanner's own read hangs (the journal reads the id too, outside this mechanism).
  f.$.session.id = () => (stuck && new Error().stack.includes('transcriptPlace') ? new Promise((resolve) => hung.push(resolve)) : healthy());
  state.tokens = undefined;
  const scans = state.scans;
  const call = f.call({ ...PUSH });
  await spinUntil(() => hung.length > 0);
  gate.passWhere((wait) => wait.ms === 6_000);
  const returned = await Promise.race([call.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 2_000))]);
  assert.equal(returned, true, 'the call went on at the scan deadline');
  assert.equal(state.scans, scans, 'no child started');
  stuck = false;
  await turnEnd(f);
  assert.equal(state.scans, scans + 1, 'the context was freed: the turn end started a scan');
  for (const resolve of hung) resolve('sample-session');
  await spinUntil(() => false, 50);
  assert.equal(state.scans, scans + 1, 'the abandoned preparation never starts its child');
  assert.equal(f.logs.filter((line) => /transcript cannot be read: no answer within 6000 ms/.test(line)).length, 1, f.logs.join('\n'));
});

test('P. a preparation past its deadline pauses the readings: a live plan\'s later back-offs prepare nothing until the turn end', { timeout: 10_000 }, async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  const healthy = f.$.session.id;
  const hung = [];
  let stuck = true;
  f.$.session.id = () => (stuck && new Error().stack.includes('transcriptPlace') ? new Promise((resolve) => hung.push(resolve)) : healthy());
  const scans = state.scans;
  await dispatch(f);
  await spinUntil(() => gate.waits.some((wait) => wait.ms === 100));
  gate.passWhere((wait) => wait.ms === 100);
  await spinUntil(() => hung.length > 0 && gate.waits.some((wait) => wait.ms === 6_000));
  gate.passWhere((wait) => wait.ms === 6_000);
  for (const ms of [200, 400, 800, 1_600, 3_200]) {
    await spinUntil(() => gate.waits.some((wait) => wait.ms === ms));
    gate.passWhere((wait) => wait.ms === ms);
  }
  await spinUntil(() => false, 200);
  assert.equal(hung.length, 1, 'one preparation, one deadline: the plan\'s later readings started none');
  stuck = false;
  await turnEnd(f);
  assert.equal(state.scans, scans + 1, 'the turn end lifted the pause: it scanned');
  for (const resolve of hung) resolve('sample-session');
});

test('P. the same transcript under another session id: the id is adopted, the cursor kept, nothing reset', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  await link(f.transcript, join(dirname(f.transcript), 'other-session.jsonl'));
  let session = 'sample-session';
  f.$.session.id = async () => session;
  session = 'other-session';
  await turnEnd(f);
  assert.deepEqual([sessionResets(f), sessionResets(f, 'other-session')], [{}, {}], 'one file (one inode): no session-changed reset');
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(sessionResets(f, 'other-session'), { 'compaction-detected': 1 }, 'the kept cursor reads the next boundary');
});

// A filesystem that reports device 0 and inode 0 for every file: every answer says `0:0`, and the scanner, asked to
// compare with `0:0`, would see the same `0:0` (so the comparison is left out of the real run).
function zeroIdentityRun(state) {
  const run = realRun(state);
  return async (argv, init) => {
    const at = argv.indexOf('--identity');
    const asked = at >= 0 && argv[at + 1] === '0:0' ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
    const result = await run(asked, init);
    if (result.exitCode !== 0) return result;
    return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), identity: '0:0' }) };
  };
}

test('P. two transcripts that both report identity 0:0, under a new session id: a real change, reset, and the new path read', async (t) => {
  const state = world();
  const f = await fixture(t, state, { processRun: zeroIdentityRun(state) });
  const other = join(dirname(f.transcript), 'other-session.jsonl');
  await writeFile(other, `${JSON.stringify({ type: 'user', uuid: 'o0', message: { role: 'user', content: 'go' } })}\n`);
  let session = 'sample-session';
  f.$.session.id = async () => session;
  await servedOnce(f, state);
  session = 'other-session';
  await turnEnd(f);
  assert.deepEqual(sessionResets(f, 'other-session'), { 'session-changed': 1 }, 'an unknown identity is never an alias: reset');
  assert.ok(served(await f.call({ ...PUSH })), 'served again in the new conversation');
  await compacted({ transcript: other });
  await turnEnd(f);
  assert.equal(request(state.runs.at(-1)).file, other, 'the new transcript is the one read');
  assert.deepEqual(sessionResets(f, 'other-session'), { 'session-changed': 1, 'compaction-detected': 1 }, 'its boundary is found');
});

test('P. a session change drops a dispatched expectation: the new conversation\'s first boundary resets', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  const other = join(dirname(f.transcript), 'other-session.jsonl');
  await writeFile(other, `${JSON.stringify({ type: 'user', uuid: 'u-other' })}\n`);
  let session = 'sample-session';
  f.$.session.id = async () => session;
  await servedOnce(f, state);
  await dispatch(f);
  session = 'other-session';
  await turnEnd(f);
  assert.ok(served(await f.call({ ...PUSH })), 'served in the new conversation');
  await compacted({ transcript: other });
  await turnEnd(f);
  assert.deepEqual(resets(f, 'other-session'), { 'session-changed': 1, 'compaction-detected': 1 }, 'the old expectation did not swallow it');
});

test('P. a session change ends a live plan: no back-off scan reads on for the old conversation', async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await writeFile(join(dirname(f.transcript), 'other-session.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'u-other' })}\n`);
  let session = 'sample-session';
  f.$.session.id = async () => session;
  await servedOnce(f, state);
  state.tokens = undefined;
  await f.call({ ...PUSH });
  await until(() => gate.waits.some(isBackoff));
  session = 'other-session';
  await turnEnd(f);
  assert.deepEqual(resets(f, 'other-session'), { 'session-changed': 1 });
  const scans = state.scans;
  await drainPlans(gate);
  assert.equal(state.scans, scans, 'the plan ended with the old conversation');
});

test('P. a re-read from 0 counts a boundary dated a few seconds before the previous scan began', async (t) => {
  const state = world();
  const f = await fixture(t, state);
  await servedOnce(f, state);
  const size = (await readFile(f.transcript)).length;
  const began = Date.now();
  await turnEnd(f);
  const near = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'near', timestamp: new Date(began - 2_000).toISOString() });
  await writeFile(f.transcript, `${near}\n${'x'.repeat(size)}\n`);
  await turnEnd(f);
  assert.equal(state.answers.at(-1).restarted, true);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'within the 5 s allowance for the host\'s own clock');
});

test('P. a plan started after earlier boundaries were found still scans: it waits for its own', async (t) => {
  const state = world();
  const gate = gatedClock();
  const f = await fixture(t, state, { clock: gate.clock });
  await servedOnce(f, state);
  await compacted(f);
  await turnEnd(f);
  assert.deepEqual(resets(f), { 'compaction-detected': 1 }, 'one boundary already found');
  state.tokens = 6_000;
  await f.call({ ...PUSH });
  state.tokens = undefined;
  await f.call({ ...PUSH });
  const scans = state.scans;
  await drainPlans(gate);
  assert.equal(state.scans, scans + 6, 'six back-off scans');
});

test('S. the scanner reads only complete lines past its offset, and restarts on another file', async (t) => {
  const root = await sandboxRoot(t, 'rod-scan-');
  const file = join(root, 't.jsonl');
  const row = (uuid) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: '2026-10-16T00:00:00.000Z' });
  await writeFile(file, `${row('a')}\n${row('b').slice(0, 20)}`);
  const first = scanTranscript({ file }, { chunkBytes: 7 });
  assert.deepEqual(first.boundaries.map((item) => item.uuid), ['a'], 'chunked reads of 7 bytes still find the row');
  await appendFile(file, `${row('b').slice(20)}\n`);
  const second = scanTranscript({ file, from: first.offset, identity: first.identity, tail: first.tail }, { chunkBytes: 7 });
  assert.deepEqual(second.boundaries.map((item) => item.uuid), ['b'], 'the unfinished line was left for the next scan');
  assert.deepEqual(scanTranscript({ file, from: second.offset + 10, identity: second.identity }).boundaries.map((item) => item.uuid), ['a', 'b'], 'past the end: read again from 0');
  assert.deepEqual(boundaryRows(`${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'c', isSidechain: true })}\n`), []);
  // Another file as long as the offset (written beside, renamed over): its earlier rows are read too.
  const third = scanTranscript({ file, from: second.offset, identity: second.identity });
  await writeFile(`${file}.new`, `${row('z')}\n${'x'.repeat(third.offset)}\n`);
  await rename(`${file}.new`, file);
  assert.deepEqual(scanTranscript({ file, from: third.offset, identity: third.identity }).boundaries.map((item) => item.uuid), ['z']);
});

test('S. a snapshot reads nothing and stops at the last complete line; a scan given the bytes before its offset restarts when they changed', async (t) => {
  const root = await sandboxRoot(t, 'rod-scan-');
  const file = join(root, 't.jsonl');
  const row = (uuid) => JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: '2026-10-16T00:00:00.000Z' });
  await writeFile(file, `${row('a')}\n${row('b').slice(0, 20)}`);
  const snap = scanTranscript({ file, snapshot: true }, { chunkBytes: 7 });
  assert.deepEqual([snap.boundaries, snap.offset], [[], row('a').length + 1], 'nothing read; the unfinished line is left for the next scan');
  assert.equal(Buffer.from(snap.tail, 'base64').toString(), `${row('a')}\n`.slice(-64));
  await appendFile(file, `${row('b').slice(20)}\n`);
  assert.deepEqual(scanTranscript({ file, from: snap.offset, identity: snap.identity, tail: snap.tail }).boundaries.map((item) => item.uuid), ['b']);
  // The same file and length, other bytes before the offset: read again from 0.
  await writeFile(file, `${row('c')}\n${row('b')}\n`);
  const again = scanTranscript({ file, from: snap.offset, identity: snap.identity, tail: snap.tail });
  assert.deepEqual([again.restarted, again.boundaries.map((item) => item.uuid)], [true, ['c', 'b']]);
  assert.equal(scanTranscript({ file, from: again.offset, identity: again.identity, tail: again.tail }).restarted, false);
});

test('S. a scan past its budget stops at the last complete line it read, and the next one resumes there', async (t) => {
  const root = await sandboxRoot(t, 'rod-scan-');
  const file = join(root, 't.jsonl');
  const filler = `${JSON.stringify({ type: 'user', pad: 'p'.repeat(90) })}\n`;
  await writeFile(file, `${filler.repeat(50)}${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'late' })}\n`);
  let tick = 0;
  const first = scanTranscript({ file, from: 0, budgetMs: 2 }, { chunkBytes: 256, now: () => tick++ });
  assert.equal(first.partial, true);
  assert.ok(first.offset > 0 && first.offset % filler.length === 0, `a line end: ${first.offset}`);
  assert.deepEqual(first.boundaries, []);
  const second = scanTranscript({ file, from: first.offset, identity: first.identity, tail: first.tail, budgetMs: 3_000 });
  assert.deepEqual([second.partial, second.restarted, second.boundaries.map((item) => item.uuid)], [false, false, ['late']]);
});

test('S. a line longer than the cap is skipped, never held: a boundary row grown past it is not read, the next one is', async (t) => {
  const root = await sandboxRoot(t, 'rod-scan-');
  const file = join(root, 't.jsonl');
  const huge = JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'huge', pad: 'x'.repeat(MAX_LINE_BYTES) });
  await writeFile(file, `${huge}\n${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'next' })}\n`);
  assert.deepEqual(scanTranscript({ file, from: 0 }, { chunkBytes: 4_096 }).boundaries.map((item) => item.uuid), ['next']);
  // A line that never ends is not held past the cap.
  const state = { skip: false, parts: [], partBytes: 0, offset: 0, boundaries: [] };
  for (let pos = 0; pos <= MAX_LINE_BYTES; pos += 4_096) consume(state, Buffer.alloc(4_096, 120), pos);
  assert.deepEqual([state.skip, state.parts.length], [true, 0], 'dropped once past the cap');
});

test('S. a budget that stops inside an oversized line: each scan moves past what it dropped, and the boundary after it is found', async (t) => {
  const root = await sandboxRoot(t, 'rod-scan-');
  const file = join(root, 't.jsonl');
  await writeFile(file, `${'x'.repeat(600_000)}
${JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'after-long' })}
`);
  let request = { file, from: 0, budgetMs: 2 }, found = [];
  const offsets = [];
  for (let scan = 0; scan < 4 && !found.length; scan++) {
    let tick = 0;
    const answer = scanTranscript(request, { chunkBytes: 200_000, now: () => tick++ });
    offsets.push(answer.offset);
    found = answer.boundaries.map((row) => row.uuid);
    request = { file, from: answer.offset, identity: answer.identity, tail: answer.tail, budgetMs: 2 };
  }
  assert.ok(offsets.every((offset, n) => offset > (offsets[n - 1] ?? 0)), `each scan moves on: ${offsets}`);
  assert.deepEqual(found, ['after-long']);
});

test('S. a file identity is known only with a non-zero inode: inode 0 reports none', () => {
  assert.equal(identityOf({ dev: 0, ino: 0 }), null, 'device 0, inode 0: unknown');
  assert.equal(identityOf({ dev: 2049, ino: 0 }), null, 'inode 0 on a real device: unknown');
  assert.equal(identityOf({ dev: 2049, ino: 77 }), '2049:77');
});

test('S. the scanner is found beside the hooks module, from the module URL on every OS', () => {
  assert.equal(shippedFile('file:///opt/p/hooks/hooks.js', 'scripts/s.mjs'), '/opt/p/scripts/s.mjs');
  assert.equal(shippedFile('file:///C:/Users/a%20b/p/hooks/hooks.js', 'scripts/s.mjs'), 'C:/Users/a b/p/scripts/s.mjs');
  assert.equal(shippedFile('file://server/share/p/hooks/hooks.js', 'scripts/s.mjs'), '//server/share/p/scripts/s.mjs');
  assert.equal(shippedFile('file://localhost/opt/p/hooks/hooks.js', 'scripts/s.mjs'), '/opt/p/scripts/s.mjs');
  for (const url of [undefined, 'https://x/p/hooks/hooks.js', 'file:///p%E0%A4%A/hooks/hooks.js']) assert.equal(shippedFile(url, 'scripts/s.mjs'), null, String(url));
  const hooks = pathToFileURL(fileURLToPath(new URL('../hooks/hooks.js', import.meta.url))).href;
  assert.equal(shippedFile(hooks, 'scripts/compact-boundary.mjs'), fileURLToPath(new URL('../scripts/compact-boundary.mjs', import.meta.url)).replace(/\\/g, '/'));
});
