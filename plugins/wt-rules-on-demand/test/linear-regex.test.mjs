import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile, readdir } from 'node:fs/promises';
import { safeRegex } from '../hooks/evidence.js';
import { toolInputVerdict } from '../hooks/declarative-checks.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { generator } from './regex-generator.mjs';

const bash = String.raw`^(?:(?:(?:[^'";&|()\n]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*(?:;|&&|\|\||\||&(?!&)|\()\s*)|(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|()]+))\s+|(?:timeout(?:(?:\s+(?:-s|--signal|-k|--kill-after)\s+\S+|\s+--(?:signal|kill-after)=\S+|\s+--(?:foreground|preserve-status|verbose))*)\s+\S+|nice(?:\s+(?:-[^\s]+|\d+))*|time|nohup|setsid|sudo(?:\s+(?:-[ugChpRT]\s+\S+|--(?:user|group|close-from|host|prompt|role|type)(?:=\S+|\s+\S+)|-[^\s]+))*|npx|pnpm\s+exec|env(?:\s+(?:-[uC]\s+\S+|--(?:unset|chdir)(?:=\S+|\s+\S+)|-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|()]+)))*)\s+|(?:ba)?sh\s+-c\s+['"]\s*|(?:if|then|do|else|elif|while|until)\s+|\{\s*|!\s*)*(?:gh\s+(?:issue|project)\b|jira\b)`;
const cases = [
  ['nested plus', '^(a+a+)+$', '', 'a', 'aa'],
  ['overlapping alternatives', '^(?:[a]|a)*$', '', 'a', 'a'],
  ['five runs', '^a+a+a+a+a+$', '', 'a', 'aaaaa'],
  ['bash trigger', bash, 'm', 'A=1 x; ', 'gh issue'],
];

const semanticCases = [
  ['nested anchored lookahead', '(?=(?=^c))', '', 'c'],
  ['nested anchored quantified lookahead', '(?=(?=^[^a]+)c+?)', '', 'c a'],
  ['nested anchored boundary lookahead', '(?=(?=\\w{0,2}^\\S{2}))', '', 'c_'],
  ['nested end lookbehind multiline', '(?=$(?<=[^a]\\W+?))', 'm', '_cé1é\nb1'],
  ['nested end lookbehind', '(?=$(?<=\\s+\\S+?))', '', '\nxa'],
  ['nested negative lookbehind', '(?:(?=$(?<=[^a]+x+?)))', 's', 'cxcbA_'],
  ['lazy exact x repetition', '(?:x??){2}', '', 'xx'],
  ['lazy exact a repetition', '(?:a??){2}', '', 'aa'],
  ['lazy boundary repetition', '\\S+?(?:\\b ??){2}', '', 'a 1'],
];

const nativeCode = `const {parentPort} = require('node:worker_threads'); parentPort.on('message', ({source, flags, subject}) => {
  try { const regex = new RegExp(source, flags); const matched = regex.test(subject); const exec = regex.exec(subject);
    parentPort.postMessage({matched, index: exec?.index, text: exec?.[0], group: exec?.[1]}); }
  catch(error) { parentPort.postMessage({error: error.message}); }
});`;

// Native RegExp answers come from one worker, asked case by case. The timer starts once the
// worker is online and only detects a HANG: a case left unanswered for stallMs rejects, naming
// the case. It is never skipped, so machine load can slow a run but cannot shrink what it compares.
// A worker that throws or exits rejects at once with its own cause. `slowestMs` is reported so a
// run shows how far its slowest answer stayed from the stall threshold.
async function nativeOracle(stallMs, code = nativeCode) {
  const worker = new Worker(code, { eval: true });
  await new Promise((resolve, reject) => { worker.once('online', resolve); worker.once('error', reject); });
  const oracle = { slowestMs: 0, close: () => worker.terminate() };
  oracle.ask = (source, flags, subject) => new Promise((resolve, reject) => {
    const label = `/${source}/${flags} ${JSON.stringify(subject)}`;
    const started = performance.now();
    let timer;
    const settle = (finish, value) => {
      clearTimeout(timer);
      worker.off('message', onMessage).off('error', onError).off('exit', onExit);
      finish(value);
    };
    const onMessage = (answer) => { oracle.slowestMs = Math.max(oracle.slowestMs, performance.now() - started); settle(resolve, answer); };
    const onError = (error) => settle(reject, new Error(`native oracle worker failed on ${label}: ${error.message}`));
    const onExit = (exitCode) => settle(reject, new Error(`native oracle worker exited with code ${exitCode} on ${label}`));
    timer = setTimeout(() => {
      settle(reject, new Error(`native oracle stalled ${stallMs} ms on ${label}: a native hang, never a skipped case`));
      void worker.terminate();
    }, stallMs);
    worker.on('message', onMessage).on('error', onError).on('exit', onExit);
    worker.postMessage({ source, flags, subject });
  });
  return oracle;
}

test('a native oracle worker that fails after start reports its cause, never a hang', async () => {
  for (const [code, cause] of [
    ["require('node:worker_threads').parentPort.on('message', () => { throw new Error('injected failure'); });", /injected failure/],
    ["require('node:worker_threads').parentPort.on('message', () => process.exit(3));", /exited with code 3/],
  ]) {
    const oracle = await nativeOracle(10000, code);
    const started = Date.now();
    try {
      await assert.rejects(oracle.ask('a', '', 'a'), (error) => cause.test(error.message) && !/stalled/.test(error.message));
      assert.ok(Date.now() - started < 10000, 'the failure is reported when it happens, not when the stall timer fires');
    } finally { await oracle.close(); }
  }
});

test('membership matchers expose test but refuse match extents', () => {
  const matcher = safeRegex('membership', '(a)', '');
  assert.equal(matcher.test('a'), true);
  assert.equal(matcher.source, '(a)');
  assert.equal(matcher.flags, '');
  matcher.lastIndex = 0;
  assert.equal(matcher.lastIndex, 0);
  assert.throws(() => matcher.exec('a'), /exec requires capture mode/i);
  assert.throws(() => matcher.matchAll('a'), /matchAll requires capture mode/i);
  assert.throws(() => matcher.run('a', true), /run requires capture mode/i);
});

test('capture mode refuses quantified nullable bodies except exact one', () => {
  for (const source of ['(?:x??){2}', '(?:[^a]*?)*', '(?:^)+', '(?:\\B[ab]{0,2}|x)?', '(?:\\s*?)*']) {
    assert.throws(() => safeRegex('capture', source, '', { capture: true }), /nullable.*quantif/i, source);
    assert.equal(safeRegex('membership', source).test('xx'), new RegExp(source).test('xx'), source);
  }
  const exact = safeRegex('capture', '(?:x??){1}', '', { capture: true });
  const match = exact.exec('xx');
  assert.deepEqual([match?.index, match?.[0]], [0, '']);
});

test('five capture-reading field regexes compile in capture mode', () => {
  for (const [source, subject] of [
    [String.raw`"id"\s*:\s*"?(\d{6,})`, '"id": "123456'],
    [String.raw`"labelId"\s*:\s*"?([^"\s,}]+)`, '"labelId": "abc'],
    [String.raw`mermaid\n([\s\S]*?)\n\x60\x60\x60`, 'mermaid\ngraph TD\n```'],
    [String.raw`agentId:\s*(\S+)`, 'agentId: xyz'],
    [String.raw`LIVENESS_AGENT_ID:\s*(\S+)`, 'LIVENESS_AGENT_ID: xyz'],
  ]) {
    const match = safeRegex('field', source, '', { capture: true }).exec(subject);
    assert.equal(match?.[1], new RegExp(source).exec(subject)?.[1], source);
    assert.ok(match?.[1], source);
  }
});

for (const [name, source, flags, subject] of semanticCases) test(`native semantics: ${name}`, () => {
  const native = new RegExp(source, flags);
  const linear = safeRegex(name, source, flags);
  assert.equal(linear.test(subject), native.test(subject), `${name}: test`);
  if (name.startsWith('lazy ')) assert.throws(() => safeRegex(name, source, flags, { capture: true }), /nullable quantified body/);
  else {
    const expected = native.exec(subject), actual = safeRegex(name, source, flags, { capture: true }).exec(subject);
    assert.deepEqual([actual?.index, actual?.[0]], [expected?.index, expected?.[0]], `${name}: exec index and text`);
  }
});

test('seeded short-subject lookaround and repetition differential, both matcher contracts', async (t) => {
  const compile = process.env.ROD_ARCHIVED_MATCHER ? (await import(process.env.ROD_ARCHIVED_MATCHER)).linearRegex : (source, flags, options) => safeRegex('seeded', source, flags, options);
  // The same grammar, alphabet, seed and flags as the larger independent fuzz.
  let seed = 12345;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const atoms = ['a', 'b', 'c', ' ', '.', '[ab]', '[^a]', '\\s', '\\S', '\\w', '\\W', '\\d', '\\b', '\\B', '^', '$', 'x'];
  const quantifiers = ['', '', '', '?', '*', '+', '{2}', '{0,2}', '{1,3}', '*?', '+?', '??'];
  const item = (depth) => {
    const kind = random(10);
    if (depth < 3 && kind === 0) return `(?:${body(depth + 1)})${quantifiers[random(quantifiers.length)]}`;
    if (depth < 3 && kind === 1) return `(?${['=', '!', '<=', '<!'][random(4)]}${body(depth + 1)})`;
    if (depth < 3 && kind === 2) return `(${body(depth + 1)})${quantifiers[random(quantifiers.length)]}`;
    const atom = atoms[random(atoms.length)];
    return /^[\\^$]b|^\^|^\$|^\\[bB]$/.test(atom) ? atom : atom + quantifiers[random(quantifiers.length)];
  };
  const sequence = (depth) => Array.from({ length: 1 + random(3) }, () => item(depth)).join('');
  const body = (depth) => random(3) === 0 ? `${sequence(depth)}|${sequence(depth)}` : sequence(depth);
  const alphabet = ['a', 'b', 'c', ' ', '\n', 'x', 'A', '_', '1', 'é'];
  const patterns = semanticCases.map(([, source, flags, subject]) => [source, flags, [subject]]);
  for (const source of ['(?:x??){2}', '(?:[^a]*?)*', '(?:^)+', '(?:\\B[ab]{0,2}|x)?', '(?:\\s*?)*'])
    assert.throws(() => compile(source, '', { capture: true }), /nullable quantified body/, `capture refusal /${source}/`);
  for (let k = 0; k < 48; k++) {
    const source = body(0), flags = ['', 'i', 'm', 's', 'u', 'im', 'su'][random(7)];
    patterns.push([source, flags, Array.from({ length: 6 }, () => Array.from({ length: random(9) }, () => alphabet[random(alphabet.length)]).join(''))]);
  }
  // Subjects are at most eight code units, so a native answer takes microseconds; 10 s without
  // one is a hang, and it fails the test instead of silently shrinking the comparison.
  const oracle = await nativeOracle(10000);
  let cases = 0, nativeErrors = 0, compared = 0, captureCompared = 0, captureRefusals = 0;
  try {
    for (const [source, flags, subjects] of patterns) for (const subject of subjects) {
      cases++;
      const expected = await oracle.ask(source, flags, subject);
      if (expected.error) {
        // A pattern native RegExp rejects must be rejected by the linear engine too, never skipped.
        assert.throws(() => compile(source, flags), `native rejects /${source}/${flags}: ${expected.error}`);
        nativeErrors++;
        continue;
      }
      const regex = compile(source, flags);
      assert.equal(regex.test(subject), expected.matched, `test /${source}/${flags} ${JSON.stringify(subject)}`);
      try {
        const captureRegex = compile(source, flags, { capture: true });
        assert.equal(captureRegex.test(subject), expected.matched, `capture test /${source}/${flags} ${JSON.stringify(subject)}`);
        const match = captureRegex.exec(subject);
        assert.deepEqual([match?.index, match?.[0], match?.[1]], [expected.index, expected.text, expected.group], `capture exec /${source}/${flags} ${JSON.stringify(subject)}`);
        captureCompared++;
      } catch (error) {
        if (!/nullable quantified body|group 1 inside repetition/.test(error.message)) throw error;
        captureRefusals++;
      }
      compared++;
    }
  } finally { await oracle.close(); }
  t.diagnostic(`seeded patterns=${patterns.length} cases=${cases} compared=${compared} native errors=${nativeErrors} capture compared=${captureCompared} capture refusals=${captureRefusals} slowest native answer=${oracle.slowestMs.toFixed(1)} ms`);
  assert.ok(compared >= 280);
  assert.ok(captureCompared > 0);
  assert.ok(captureRefusals > 0);
});

test('tool-input iteration error belongs to its verdict, not the shared compiled compliance', () => {
  const compliance = { tool: safeRegex('fixture', '^Write$'), matchBlock: safeRegex('fixture', 'a.*b|(a)', '', { capture: true }), required: [], inputField: 'content' };
  const first = toolInputVerdict(compliance, { tool: 'Write', input: { content: 'a'.repeat(16384) } });
  assert.equal(first.verdict, 'unknown');
  assert.match(first.matchError, /regex iteration work budget exceeded/);
  assert.equal(Object.hasOwn(compliance, 'matchError'), false);
  const second = toolInputVerdict(compliance, { tool: 'Write', input: { content: 'ab' } });
  assert.equal(second.matchError, null);
  assert.equal(Object.hasOwn(compliance, 'matchError'), false);
});

// The worker owns compilation AND execution; broken engines cannot stall the test runner.
function run(source, flags, subject, deadline = 30000) {
  return new Promise((resolve) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        try {
          const { safeRegex } = await import(workerData.module);
          const regex = safeRegex('pumped', workerData.source, workerData.flags);
           const start = performance.now();
           const cpuStart = process.cpuUsage();
           const matched = regex.test(workerData.subject);
           const cpu = process.cpuUsage(cpuStart);
           parentPort.postMessage({ matched, ms: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000, steps: regex.steps, native: regex instanceof RegExp });
        } catch (error) { parentPort.postMessage({ error: error.message }); }
      })();
    `, { eval: true, workerData: { source, flags, subject, module: new URL('../hooks/evidence.js', import.meta.url).href } });
    const timer = setTimeout(() => { void worker.terminate(); resolve({ error: 'worker deadline exceeded' }); }, deadline);
    worker.once('message', (result) => { clearTimeout(timer); void worker.terminate(); resolve(result); });
    worker.once('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
  });
}

for (const [name, source, flags, unit, positive] of cases) test(`${name}: accepted and bounded on 16,384 code units`, async () => {
  for (const length of [2048, 4096, 8192, 16384]) {
    const negative = unit.repeat(Math.ceil((length - 1) / unit.length)).slice(0, length - 1) + '!';
    const result = await run(source, flags, negative);
    assert.equal(result.error, undefined, `${name}: ${result.error}`);
    assert.equal(result.native, false, `${name}: safeRegex must not return native RegExp`);
    assert.equal(result.matched, false, `${name}: negative subject`);
    assert.ok(result.steps <= 64 * length * source.length, `${name}: ${result.steps} steps exceeds linear budget at ${length}`);
    // Backstop: ~5x the worst CI figure, 3,225 CPU ms on windows-latest (cross-OS run 36454983764, 2026-09-28).
    if (length === 16384) assert.ok(result.cpuMs < 16000, `${name}: ${result.cpuMs} CPU ms exceeds backstop`);
    const yes = await run(source, flags, unit === 'a' ? 'a'.repeat(length) : unit.repeat(Math.floor((length - positive.length) / unit.length)) + positive);
    assert.equal(yes.error, undefined, `${name}: positive: ${yes.error}`);
    assert.equal(yes.matched, true, `${name}: positive subject`);
    assert.ok(yes.steps <= 64 * length * source.length, `${name}: positive exceeds linear step budget at ${length}`);
  }
});

test('capture contract, ordered alternatives, flags, lookarounds and empty iterations agree with native', () => {
  const rows = [
    ['(a+?)a', '', 'aaa'], ['(a|aa)', '', 'aa'],
    ['\\b(K)\\b', 'iu', 'K'], ['\\b(K)\\b', 'i', 'K'], ['(k)', 'iu', 'K'], ['(k)', 'i', 'K'],
    ['^(.)(.)$', '', '😀'], ['^(.)$', 'u', '😀'], ['^😀+$', '', '😀😀'],
    ['^(b)$', 'm', 'a\r\nb\u2028c'], ['a$', '', 'a\n'], ['a$', 'm', 'a\n'],
    ['(.)', '', '\u2028'], ['(.)', 's', '\u2028'], ['^(.)$', 's', '😀'], ['^(.)$', 'su', '😀'],
    ['(?<=a+)(b)', '', 'aaab'], ['(?=(?=a+)a)(a)', '', 'abc'],
  ];
  for (const [source, flags, subject] of rows) {
    const linear = safeRegex('differential', source, flags, { capture: true });
    const native = new RegExp(source, flags);
    assert.equal(linear.test(subject), native.test(subject), `${source}/${flags}: test`);
    const got = linear.exec(subject), want = native.exec(subject);
    assert.deepEqual([got?.index, got?.[0], got?.[1]], [want?.index, want?.[0], want?.[1]], `${source}/${flags}: exec`);
  }
  assert.throws(() => safeRegex('capture', '(?:(?:a|)(?:|b))*', '', { capture: true }), /nullable quantified body/);
});

test('unbounded lookaround tables align on all 16,384 positions', async () => {
  for (const [source, yes, no] of [
    ['(?=[\\s\\S]*z)a', 'a'.repeat(16383) + 'z', 'a'.repeat(16383) + '!'],
    ['(?<=a+)z', 'a'.repeat(16383) + 'z', 'a'.repeat(16383) + '!'],
  ]) {
    for (const [subject, expected] of [[yes, true], [no, false]]) {
      const result = await run(source, '', subject);
      assert.equal(result.error, undefined, `${source}: ${result.error}`);
      assert.equal(result.matched, expected, `${source}: ${subject.length} units`);
      assert.ok(result.steps < 64 * subject.length * source.length, `${source}: ${result.steps} steps`);
    }
  }
});

test('iteration work exhaustion becomes an explicit unknown verdict, never a partial match list', async () => {
  const outcome = await new Promise((resolve) => {
    const worker = new Worker(`
      const {parentPort, workerData} = require('node:worker_threads');
      (async () => {
        const {safeRegex} = await import(workerData.evidence);
        const {toolInputVerdict} = await import(workerData.checks);
        const c = {tool: safeRegex('fixture', '^Write$'), matchBlock: safeRegex('fixture', 'a.*b|(a)', '', {capture: true}), required: [], inputField: 'content'};
        parentPort.postMessage(toolInputVerdict(c, {tool: 'Write', input: {content: 'a'.repeat(16384)}}));
      })().catch(error => parentPort.postMessage({error: error.message}));
    `, { eval: true, workerData: { evidence: new URL('../hooks/evidence.js', import.meta.url).href, checks: new URL('../hooks/declarative-checks.js', import.meta.url).href } });
    const timer = setTimeout(() => { void worker.terminate(); resolve({ error: 'worker deadline exceeded' }); }, 30000);
    worker.once('message', (value) => { clearTimeout(timer); void worker.terminate(); resolve(value); });
    worker.once('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
  });
  assert.equal(outcome.error, undefined, outcome.error);
  assert.equal(outcome.verdict, 'unknown');
  assert.match(outcome.matchError, /regex iteration work budget exceeded/);
});

test('whole iteration over 16,384 simple matches completes without rescanning the subject', async () => {
  const outcome = await new Promise((resolve) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const {safeRegex} = await import(workerData.module);
        const regex = safeRegex('iteration', '(a)', 'g', {capture: true});
        let count = 0;
        const start = performance.now();
        const cpuStart = process.cpuUsage();
        for (const match of regex.matchAll('a'.repeat(16384))) { if (match[1] !== 'a') throw new Error('wrong group'); count++; }
        const cpu = process.cpuUsage(cpuStart);
        parentPort.postMessage({count, steps: regex.steps, ms: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000});
      })().catch(error => parentPort.postMessage({error: error.message}));
    `, { eval: true, workerData: { module: new URL('../hooks/evidence.js', import.meta.url).href } });
    const timer = setTimeout(() => { void worker.terminate(); resolve({ error: 'worker deadline exceeded' }); }, 10000);
    worker.once('message', (value) => { clearTimeout(timer); void worker.terminate(); resolve(value); });
    worker.once('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
  });
  assert.equal(outcome.error, undefined, outcome.error);
  assert.equal(outcome.count, 16384);
  assert.ok(outcome.steps > 0 && outcome.steps <= 64 * 16384 * '(a)'.length, `${outcome.steps} iteration steps exceed linear bound`);
  assert.ok(outcome.cpuMs < 16000, `${outcome.cpuMs} CPU ms exceeds backstop`);
});

test('global/sticky lastIndex and empty match advancement agree with native', () => {
  for (const [source, flags, subject] of [['(a)', 'g', 'aba'], ['(a)', 'y', 'aba'], ['(?:)', 'gu', '😀a'], ['(?:)', 'g', '😀a']]) {
    const linear = safeRegex('stateful', source, flags, { capture: true }), native = new RegExp(source, flags);
    for (const at of [0, 1, 2, 10]) {
      linear.lastIndex = at; native.lastIndex = at;
      for (let k = 0; k < 2; k++) {
        const a = linear.exec(subject), b = native.exec(subject);
        assert.deepEqual([a?.index, a?.[0], a?.[1], linear.lastIndex], [b?.index, b?.[0], b?.[1], native.lastIndex], `${source}/${flags}: index=${at}`);
      }
    }
    if (flags.includes('g')) assert.deepEqual([...linear.matchAll(subject)].map((m) => [m.index, m[0]]), [...subject.matchAll(native)].map((m) => [m.index, m[0]]));
  }
  assert.throws(() => safeRegex('budget', '^(?:a{1024}){1024}$'), /expanded program exceeds/);
  for (const source of ['(?=(a+))a', '(?:(a)|b)+', '((?:)|a)*', '(a*)*']) {
    assert.throws(() => safeRegex('capture', source, '', { capture: true }), /group 1 inside repetition|group 1 inside repetition or lookaround/);
    assert.equal(safeRegex('membership', source).test('a'), new RegExp(source).test('a'));
  }
});

test('shipped specs compile and each has a firing and non-firing trigger through the real consumer', async () => {
  const dir = new URL('../../../plugin/rules/', import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.spec.json'));
  assert.equal(files.length, 12);
  const tools = ['Agent', 'SendMessage', 'Workflow', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Read', 'Task', 'Skill', 'Monitor', 'TaskOutput'];
  for (const file of files) {
    const spec = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    let fires = false;
    for (const entry of spec['on-demand'].triggers) {
      const flags = entry.flags ?? '';
      const pattern = entry.regex ? safeRegex(file, entry.regex, flags) : null;
      const trigger = { kind: entry.kind, regex: pattern, tool: entry.tool ? safeRegex(file, entry.tool) : null,
        input: entry['input-regex'] ? safeRegex(file, entry['input-regex'], flags) : null,
        commandHead: entry['command-head'] === true, onMention: entry.mentions === true };
      const samples = ['Agent', 'Bash', 'Write', 'wt-lane.mjs', 'pnpm test', 'gh issue', 'jira', 'hello', 'agentId: 123456', 'LIVENESS_AGENT_ID: xyz'];
      for (const source of [entry.regex, entry.tool, entry['input-regex']].filter(Boolean)) {
        const actual = safeRegex(file, source, flags);
        const native = new RegExp(source, flags);
        for (const sample of samples) {
          assert.equal(actual.test(sample), native.test(sample), `${file}: ${source.slice(0, 50)} on ${sample}`);
        }
      }
      const nativeTrigger = { ...trigger, regex: entry.regex ? new RegExp(entry.regex, flags) : null,
        tool: entry.tool ? new RegExp(entry.tool) : null, input: entry['input-regex'] ? new RegExp(entry['input-regex'], flags) : null };
      const candidates = [
        ...tools.flatMap((tool) => ['.lane/brief.md', 'hooks/example.js', 'MEMORY.md', 'review.md'].map((path) => ({ channel: 'tool', tool, command: 'gh issue', path, input: { command: 'gh issue' } }))),
        ...['git worktree list', 'git merge main', 'pnpm test', 'wt-lane.mjs', 'vitest', 'jira', 'gh issue'].map((command) => ({ channel: 'tool', tool: 'Bash', command, input: { command } })),
        { channel: 'prompt', text: 'Please run tests and review the agent workflow' },
      ];
      for (const item of candidates) {
        const expected = triggerMatches(nativeTrigger, item);
        assert.equal(triggerMatches(trigger, item), expected, `${file}: ${entry.kind}`);
        fires ||= expected;
      }
      assert.equal(triggerMatches(trigger, { channel: 'prompt', text: 'completely unrelated' }), triggerMatches(nativeTrigger, { channel: 'prompt', text: 'completely unrelated' }));
    }
    assert.equal(fires, true, `${file}: no trigger fired in candidate corpus`);
  }
});

test('seeded generated patterns compare test in membership and exec in capture mode with a per-case native oracle deadline', async (t) => {
  const make = generator(20260927);
  const patterns = new Set([
    '(a+?)a', '(a|aa)', '(?:(?:a|)(?:|b))*', '\\b(K)\\b',
    '(?<=a+)b', '(?!.*?x)a', '(a)?b', 'a.*b|(a)',
  ]);
  while (patterns.size < 16) patterns.add(make());
  let compared = 0, captureCompared = 0, captureRefusals = 0;
  const subjects = ['', 'aab', 'ab ba', 'a'.repeat(20) + '!'];
  // Subjects are at most 21 code units and the corpus holds no catastrophic native case, so
  // 10 s without an answer is a hang; it fails the test rather than dropping the case.
  const oracle = await nativeOracle(10000);
  try {
    for (const source of patterns) for (const subject of subjects) {
      const flags = source.includes('(K)') ? 'iu' : '';
      const expected = await oracle.ask(source, flags, subject);
      assert.equal(expected.error, undefined, `${source}: ${expected.error}`);
      const linear = safeRegex('generated', source, flags);
      assert.equal(linear.test(subject), expected.matched, `${source}: ${JSON.stringify(subject)}`);
      try {
        const captured = safeRegex('generated', source, flags, { capture: true });
        assert.equal(captured.test(subject), expected.matched, `${source}: capture test ${JSON.stringify(subject)}`);
        const match = captured.exec(subject);
        assert.deepEqual([match?.index, match?.[0], match?.[1]], [expected.index, expected.text, expected.group], `${source}: ${JSON.stringify(subject)}`);
        captureCompared++;
      } catch (error) {
        if (!/nullable quantified body|group 1 inside repetition/.test(error.message)) throw error;
        captureRefusals++;
      }
      compared++;
    }
  } finally { await oracle.close(); }
  t.diagnostic(`native oracle compared=${compared} capture compared=${captureCompared} capture refusals=${captureRefusals} slowest native answer=${oracle.slowestMs.toFixed(1)} ms`);
  assert.equal(compared, patterns.size * subjects.length);
});

test('a native oracle case that never answers fails the comparison and is never counted as skipped', async () => {
  // A deliberately catastrophic native case: load can only make it slower, never faster,
  // so the stall is certain on any machine and the verdict does not depend on its speed.
  const oracle = await nativeOracle(500);
  try {
    await assert.rejects(oracle.ask('^(?:a*){24}b$', '', 'a'.repeat(24)), /native oracle stalled 500 ms on \/\^\(\?:a\*\)\{24\}b\$\/ "a{24}"/);
  } finally { await oracle.close(); }
});

test('capture-mode refusals tell the rule author what to write instead', () => {
  const refusal = (source) => { try { safeRegex('rule', source, '', { capture: true }); } catch (error) { return error.message; } return null; };
  assert.match(refusal('x(\\S+)(?:\\s*?)*'), /nullable quantified body[\s\S]*instead[\s\S]*at least one character[\s\S]*\(\\S\+\)/);
  assert.match(refusal('(?:(a)b)+'), /group 1 inside repetition[\s\S]*instead[\s\S]*outside/);
  assert.match(refusal('(?=(a))a'), /group 1 inside repetition or lookaround[\s\S]*instead[\s\S]*outside/);
});
