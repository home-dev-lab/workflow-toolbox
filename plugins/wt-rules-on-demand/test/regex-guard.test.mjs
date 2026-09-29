import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { safeRegex, SUBJECT_CAP } from '../hooks/evidence.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { toolInputVerdict, segmentVerdict } from '../hooks/declarative-checks.js';
import { generator } from './regex-generator.mjs';

const accepted = (source, flags = '') => { try { safeRegex('sample', source, flags); return true; } catch { return false; } };
const nativeTest = (source, subject) => new RegExp(source).test(subject);

test('empty and inverted-empty classes preserve their native answers', () => {
  for (const source of ['[](a+)+]', '[^](a+)+]']) {
    assert.equal(accepted(source), true, source);
    assert.equal(safeRegex('sample', source).test('aaaa]'), new RegExp(source).test('aaaa]'));
  }
});

test('Unicode brace escape is parsed using the actual flag semantics', () => {
  assert.equal(accepted('^(?:\\u{61}u+)+$'), false); // unsupported Annex B escape is loud
  assert.equal(accepted('^(?:\\u{61}b+)+$', 'u'), true);
  assert.equal(accepted('a', 'v'), false);
});

test('case-folded non-ASCII ranges use the exact one-character native predicate', () => {
  assert.equal(accepted('^(?:[Ѐ-Ԁ]+[ᰀ-᳿])+$', 'iu'), true);
  for (const flags of ['i', 'iu']) assert.equal(safeRegex('sample', '[Ѐ-Ԁ]', flags).test('Ѐ'), new RegExp('[Ѐ-Ԁ]', flags).test('Ѐ'));
});

test('checker refuses repetitions beyond its finite safe budget', () => {
  for (const source of ['(?:a{1000000})+', '(?:a{9007199254740992})+']) assert.equal(accepted(source), false);
});
test('checker refuses patterns beyond its source budget', () => {
  assert.equal(accepted('a'.repeat(9000)), false);
});
test('checker refuses nesting beyond its traversal budget', () => {
  assert.equal(accepted(`${'('.repeat(120)}a${')'.repeat(120)}`), false);
});
test('linear engine needs no group expansion to prove safety', () => {
  const source = `^(?:${Array(8).fill('(?:a|b)').join('')}${'a'.repeat(65)})+$`;
  assert.equal(accepted(source), true);
  assert.equal(safeRegex('sample', source).test('b'.repeat(8) + 'a'.repeat(65)), true);
});

test('backreferences outside repeated groups are refused', () => {
  for (const source of ['(a)\\1', '(?<x>a)\\k<x>']) assert.equal(accepted(source), false);
});

test('trigger and compliance regex subjects are capped at 16 KiB', () => {
  const lengths = [];
  const regex = { test: (text) => { lengths.push(text.length); return true; } };
  triggerMatches({ kind: 'bash', commandHead: true, regex }, { channel: 'tool', tool: 'Bash', command: `bash -c '${'x'.repeat(SUBJECT_CAP * 2)}'` });
  toolInputVerdict({ tool: regex, required: [], inputField: 'content', when: regex }, { tool: 'Edit', input: { content: 'x'.repeat(SUBJECT_CAP * 2) } });
  segmentVerdict({ exempt: regex, requireAll: [] }, { head: 'git', args: ['x'.repeat(SUBJECT_CAP * 2)], text: 'x' });
  assert.ok(lengths.length >= 3);
  assert.ok(lengths.every((length) => length <= SUBJECT_CAP), lengths.join(','));
});

// One test per regression row of the third review round, so each row's lock is proven red on its own.
test('row 1: ambiguous optional atom is accepted with native answers', () => {
  const source = '^(?:b+(?:a?b))+$';
  assert.equal(accepted(source), true);
  for (const subject of ['b', 'bb', 'ab', 'babb', 'bb!']) assert.equal(safeRegex('sample', source).test(subject), nativeTest(source, subject));
  assert.equal(safeRegex('sample', source).test('b'.repeat(16383) + '!'), false);
});

test('row 2: ambiguous alternatives are accepted with native answers', () => {
  const source = '^(?:b+(?:a|aa)a?)+$';
  assert.equal(accepted(source), true);
  for (const subject of ['ba', 'baa', 'baaa', 'baba', 'bbb!']) assert.equal(safeRegex('sample', source).test(subject), new RegExp(source).test(subject));
  assert.equal(safeRegex('sample', source).test('b'.repeat(16383) + '!'), false);
});

test('row 3: the regex guard accepts the fixed-width repetition ^(?:a{2})+$ it accepted before', () => {
  assert.equal(accepted('^(?:a{2})+$'), true);
  assert.equal(accepted('^(?:x(?:ab){2}y)+$'), true);
});

test('the regex guard accepts the option-list shapes the shipped rule proposals use', () => {
  for (const source of ['(?:-u\\s+\\S+\\s+|\\w+=\\S*\\s+){0,8}x',
    '\\b(?:pnpm|npm|yarn)\\s+(?:(?:-C|--dir|--filter|-F|--prefix|-w|--workspace)\\s+\\S+\\s+|-r\\s+|--recursive\\s+){0,8}(?:run\\s+)?test',
    '^(?:(?:a|ab)c)+$', '^(?:a(?:b|c)d|a(?:b|e)f)+$']) assert.equal(accepted(source), true, source);
  for (const source of ['^(?:(?:ab|a)b)+$', '^(?:x(?:a|b)*y)+$', '^(?:(?:a|b)+)+$']) {
    assert.equal(accepted(source), true, source);
    assert.equal(safeRegex('sample', source).test('ab'), new RegExp(source).test('ab'));
  }
});

test('the regex guard accepts separator shapes and refuses ambiguous nesting', () => {
  for (const source of ['^(?:[^/]+/)+file$', '^(?:ab+)+$', 'push\\s+(?:-[^\\s]+\\s+){0,8}[A-Za-z]', '^(?:\\S+\\s+){2,6}x',
    '^(?:-\\S+\\s+|[^-\\s]\\S*\\s+){0,8}end$', '^(?:-C\\s+|--dir\\s+)+x$']) assert.equal(accepted(source), true, source);
  for (const source of ['(a+)+', '(a|a)+', '(a|ab)+', '^(?:aa+)+$', '^(\\w+\\s?)*$', '^(?:a+|b+){0,8}$', '^(?:x?a+){0,4}$',
    '^(?:(?:ab)+c)+$', '^(?:a(?=a)a*)+$']) {
    assert.equal(accepted(source), true, source);
    assert.equal(safeRegex('sample', source).test('ab'), new RegExp(source).test('ab'));
  }
  assert.equal(accepted('^(?:(a)\\1+)+$'), false);
  assert.equal(accepted('^(?:\\p{L}+a)+$', 'u'), true);
});

// Generated corpus, graded by executing the actual matcher in a bounded worker.
// The timing runs in a worker so a catastrophic pattern cannot hang the suite: a single match that backtracks
// exponentially never returns to the growth loop, so the main thread terminates the worker once no progress arrives
// within STALL_MS and names the pattern it was on.
const TIMING_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const {safeRegex} = await import(workerData.module);
  const slow = [];
  for (const source of workerData.patterns) {
    parentPort.postMessage({ current: source });
    const regex = safeRegex('generated', source);
    for (const unit of workerData.units) for (const length of [32, 256, 2048, 4096]) {
      const input = unit.repeat(Math.ceil((length - 1) / unit.length)).slice(0, length - 1) + '!';
      try {
        regex.test(input);
        if (regex.steps > 64 * input.length * source.length)
          slow.push(source + ' on ' + JSON.stringify(unit) + 'x' + length + ': ' + regex.steps + ' steps exceed linear bound');
      } catch (error) {
        slow.push(source + ' on ' + JSON.stringify(unit) + 'x' + length + ': ' + error.message + ' at ' + regex.steps + ' steps');
      }
    }
  }
  parentPort.postMessage({ slow });
})().catch(error => parentPort.postMessage({slow: [error.message]}));
`;
const STALL_MS = 5000;

function timeAccepted(patterns, units) {
  return new Promise((resolve) => {
    const worker = new Worker(TIMING_WORKER, { eval: true, workerData: { patterns, units, module: new URL('../hooks/evidence.js', import.meta.url).href } });
    let current = null;
    let timer = null;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { worker.terminate(); resolve([`${current} did not finish one pumped input within ${STALL_MS} ms`]); }, STALL_MS); };
    arm();
    worker.on('message', (message) => {
      if (message.slow) { clearTimeout(timer); worker.terminate(); resolve(message.slow); return; }
      current = message.current;
      arm();
    });
    worker.on('error', (error) => { clearTimeout(timer); resolve([`timing worker failed: ${error.message}`]); });
  });
}

test('every generated nested-quantifier pattern the guard accepts runs fast on pumped adversarial input', async (t) => {
  const make = generator(20260927);
  const units = ['a', 'b', ' ', 'ab'];
  const patterns = new Set(['^(?:b+(?:a?b))+$', '^(?:b+(?:a|aa)a?)+$']);
  while (patterns.size < 40) patterns.add(make());
  const acceptedPatterns = [...patterns].filter((source) => accepted(source));
  t.diagnostic(`${acceptedPatterns.length} of ${patterns.size} generated patterns accepted`);
  assert.deepEqual(await timeAccepted(acceptedPatterns, units), []);
  // A guard that refuses everything would pass the timing check vacuously.
  assert.ok(acceptedPatterns.length >= 38, `only ${acceptedPatterns.length} of ${patterns.size} generated patterns accepted`);
});
