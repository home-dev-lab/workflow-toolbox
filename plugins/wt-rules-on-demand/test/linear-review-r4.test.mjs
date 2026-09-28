import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { safeRegex } from '../hooks/evidence.js';
import { toolInputVerdict, correlateTurn } from '../hooks/declarative-checks.js';

const moduleURL = new URL('../hooks/evidence.js', import.meta.url).href;
function measured(source, flags, subject, operation, deadline = 10000) {
  return new Promise((resolve) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { safeRegex } = await import(workerData.moduleURL);
        const regex = safeRegex('review', workerData.source, workerData.flags, { capture: workerData.operation !== 'test' });
         const start = performance.now();
         const cpuStart = process.cpuUsage();
        try {
          const value = workerData.operation.startsWith('test') ? regex.test(workerData.subject)
            : workerData.operation === 'exec' ? regex.exec(workerData.subject)
              : [...regex.matchAll(workerData.subject)];
          parentPort.postMessage({ value, ms: performance.now() - start, cpuMs: (process.cpuUsage(cpuStart).user + process.cpuUsage(cpuStart).system) / 1000, steps: regex.steps });
        } catch (error) { parentPort.postMessage({ error: error.message, ms: performance.now() - start, cpuMs: (process.cpuUsage(cpuStart).user + process.cpuUsage(cpuStart).system) / 1000, steps: regex.steps }); }
      })().catch(error => parentPort.postMessage({ error: error.message }));
    `, { eval: true, workerData: { moduleURL, source, flags, subject, operation } });
    const timer = setTimeout(() => { void worker.terminate(); resolve({ error: 'worker deadline exceeded' }); }, deadline);
    worker.once('message', (value) => { clearTimeout(timer); void worker.terminate(); resolve(value); });
    worker.once('error', (error) => { clearTimeout(timer); void worker.terminate(); resolve({ error: error.message }); });
  });
}

test('all accepted modes finish or report a visible work budget within one CPU second', async () => {
  const subject = 'a'.repeat(16384);
  for (const [source, operation] of [
    ['(?:[a]{1024}){4}b', 'test'],
    ['(?:[a]{1024}){4}(b)', 'exec'],
    ['(?:[a]{1024}){4}(b)', 'test-capture'],
    ['(?=b(?:[a]{1024}){4})', 'test'],
    ['(?:[a]{1024}){4}(b)', 'matchAll'],
  ]) {
    const result = await measured(source, '', subject, operation);
    assert.notEqual(result.error, 'worker deadline exceeded', `${operation} /${source}/: exceeded deadline`);
    assert.ok(result.cpuMs < 1000, `${operation} /${source}/: ${result.cpuMs} CPU ms exceeds one second`);
    if (result.error) assert.match(result.error, /regex.*budget.*unresolved/i);
    else assert.equal(operation.startsWith('test') ? result.value : result.value?.length ?? 0, operation.startsWith('test') ? false : 0);
  }
});

test('worst admitted test and lookaround forms finish within one CPU second at 16,384 units', async (t) => {
  for (const source of ['(?:[a]{1024}){4}b', '(?=b(?:[a]{1024}){4})', '(?<=(?:[a]{1024}){4})b']) {
    const result = await measured(source, '', 'a'.repeat(16384), 'test');
    t.diagnostic(JSON.stringify({ source, units: 16384, ms: result.ms, cpuMs: result.cpuMs, steps: result.steps, outcome: result.error ?? result.value }));
    assert.notEqual(result.error, 'worker deadline exceeded', source);
    assert.ok(result.cpuMs < 1000, `${source}: ${result.cpuMs} CPU ms`);
    if (result.error) assert.match(result.error, /regex work budget exceeded; verdict unresolved/);
    else assert.equal(result.value, false);
  }
});

test('long literal-headed alternation on 16,384 shell units does not exhaust membership budget', async () => {
  const heads = Array.from({ length: 30 }, (_, i) => `\\bcommand${String(i).padStart(2, '0')}\\s+--option\\b[^\\n]*--since`);
  const source = `(?:\\bgit\\s+log\\b[^\\n]*--since|PIPESTATUS|\\bgrep\\s+-[a-zA-Z]*c\\b|${heads.join('|')})`;
  const subject = 'A=1 x; '.repeat(2341).slice(0, 16384);
  const result = await measured(source, '', subject, 'test');
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.value, false);
  assert.ok(result.steps > 1000000, `synthetic real-rule shape only consumed ${result.steps} steps`);
  assert.ok(result.cpuMs < 1000, `${result.cpuMs} CPU ms`);
});

test('eight thousand assertions do not overflow capture closure or escape a verdict', async () => {
  const source = '^'.repeat(8000) + '(b)';
  const result = await measured(source, '', 'b', 'exec');
  assert.equal(result.error, undefined, `capture exec: ${result.error}`);
  assert.deepEqual([result.value.index, result.value[0], result.value[1]], [0, 'b', 'b']);
  const compliance = { tool: safeRegex('test', '^Write$'), matchBlock: safeRegex('test', source, '', { capture: true }), required: [], inputField: 'content' };
  assert.equal(toolInputVerdict(compliance, { tool: 'Write', input: { content: 'b' } }).verdict, 'followed');
});

test('unicode non-boundary visits the position inside an astral character', () => {
  for (const source of [String.raw`\B`, String.raw`(\B)`, String.raw`(?=\B)`]) {
    const native = new RegExp(source, 'u').exec('a😀b');
    const linear = safeRegex('unicode', source, 'u', { capture: true });
    assert.equal(linear.test('a😀b'), true, `${source}: test`);
    assert.deepEqual([linear.exec('a😀b')?.index, linear.exec('a😀b')?.[0]], [native.index, native[0]], `${source}: exec`);
  }
});

test('timing worker executes capture mode and reports matcher errors', async () => {
  const workerResult = (source, corpus, operation) => new Promise((resolve) => {
    const worker = new Worker(new URL('../scripts/regex-timing-worker.mjs', import.meta.url), {
      workerData: { source, flags: '', corpus, boundMs: 50, operation },
    });
    worker.once('message', resolve);
    worker.once('error', (error) => resolve({ error: error.message }));
  });
  const value = await workerResult('^'.repeat(8000) + '(b)', ['b'], 'exec');
  assert.notEqual(value, null, 'capture-mode timing must execute the capture path');
  assert.equal(value?.error, undefined, `timing worker: ${value?.error}`);
  assert.equal(value.checked, 1);
  const failure = await workerResult('(?:[a]{1024}){4}(b)', ['a'.repeat(16384)], 'exec');
  assert.match(failure.error, /regex work budget exceeded; verdict unresolved/);
});

test('membership matcher refuses stateful g and y flags at compile', () => {
  for (const flags of ['g', 'y']) assert.throws(() => safeRegex('stateful', '(?=.)(?:(?:a|)(?:|b))*', flags), /stateful.*capture mode/i);
  assert.doesNotThrow(() => safeRegex('stateful', '(a)', 'g', { capture: true }));
});

test('unicode source surrogate escapes join into one code point, including quantified and class forms', () => {
  for (const [source, subject] of [
    [String.raw`^\uD83D\uDE00$`, '😀'],
    [String.raw`^\uD83D\uDE00+$`, '😀😀'],
    [String.raw`^[\uD83D\uDE00]+$`, '😀😀'],
  ]) {
    const expected = new RegExp(source, 'u');
    assert.equal(safeRegex('unicode', source, 'u').test(subject), expected.test(subject), source);
    const actual = safeRegex('unicode', source, 'u', { capture: true }).exec(subject);
    assert.deepEqual([actual?.index, actual?.[0]], [expected.exec(subject)?.index, expected.exec(subject)?.[0]], source);
  }
});

test('matcher failures in correlation remain unresolved with their reason', () => {
  const error = { test() { throw new RangeError('matcher failed'); }, lastIndex: 0 };
  const verdicts = correlateTurn({ tool: error }, [{ kind: 'use', id: 'one', name: 'Write' }, { kind: 'turn' }]);
  assert.deepEqual(verdicts, [{ id: 'one', verdict: 'unresolved', detail: 'matcher failed' }]);
});
