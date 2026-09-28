import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { safeRegex, SUBJECT_CAP } from '../hooks/evidence.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { toolInputVerdict, segmentVerdict } from '../hooks/declarative-checks.js';

const accepted = (source, flags = '') => {
  try {
    safeRegex('sample', source, flags);
    return true;
  } catch (error) {
    if (/nested unbounded|could not be analysed/.test(error.message)) return false;
    throw error;
  }
};

test('empty and inverted-empty classes do not hide repeated groups', () => {
  for (const source of ['[](a+)+]', '[^](a+)+]']) assert.equal(accepted(source), false, source);
});

test('Unicode brace escape is parsed using the actual flag semantics', () => {
  assert.equal(accepted('^(?:\\u{61}u+)+$'), false);
  assert.equal(accepted('^(?:\\u{61}b+)+$', 'u'), true);
  assert.equal(accepted('a', 'v'), false);
});

test('case-folded non-ASCII ranges are refused rather than sampled', () => {
  assert.equal(accepted('^(?:[Ѐ-Ԁ]+[ᰀ-᳿])+$', 'iu'), false);
  assert.throws(() => safeRegex('sample', '[Ѐ-Ԁ]', 'i'), /case folding/);
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
test('checker bounds total items produced by group expansion', () => {
  assert.equal(accepted(`^(?:${Array(8).fill('(?:a|b)').join('')}${'a'.repeat(65)})+$`), false);
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
test('row 1: the regex guard refuses ^(?:b+(?:a?b))+$ (an optional atom lets b+ and b share input)', () => {
  assert.equal(accepted('^(?:b+(?:a?b))+$'), false);
});

test('row 2: the regex guard refuses ^(?:b+(?:a|aa)a?)+$ (alternatives of different lengths before an optional atom)', () => {
  assert.equal(accepted('^(?:b+(?:a|aa)a?)+$'), false);
});

test('row 3: the regex guard accepts the fixed-width repetition ^(?:a{2})+$ it accepted before', () => {
  assert.equal(accepted('^(?:a{2})+$'), true);
  assert.equal(accepted('^(?:x(?:ab){2}y)+$'), true);
});

test('the regex guard accepts the option-list shapes the shipped rule proposals use', () => {
  for (const source of ['(?:-u\\s+\\S+\\s+|\\w+=\\S*\\s+){0,8}x',
    '\\b(?:pnpm|npm|yarn)\\s+(?:(?:-C|--dir|--filter|-F|--prefix|-w|--workspace)\\s+\\S+\\s+|-r\\s+|--recursive\\s+){0,8}(?:run\\s+)?test',
    '^(?:(?:a|ab)c)+$', '^(?:a(?:b|c)d|a(?:b|e)f)+$']) assert.equal(accepted(source), true, source);
  for (const source of ['^(?:(?:ab|a)b)+$', '^(?:x(?:a|b)*y)+$', '^(?:(?:a|b)+)+$']) assert.equal(accepted(source), false, source);
});

test('the regex guard accepts separator shapes and refuses ambiguous nesting', () => {
  for (const source of ['^(?:[^/]+/)+file$', '^(?:ab+)+$', 'push\\s+(?:-[^\\s]+\\s+){0,8}[A-Za-z]', '^(?:\\S+\\s+){2,6}x',
    '^(?:-\\S+\\s+|[^-\\s]\\S*\\s+){0,8}end$', '^(?:-C\\s+|--dir\\s+)+x$']) assert.equal(accepted(source), true, source);
  for (const source of ['(a+)+', '(a|a)+', '(a|ab)+', '^(?:aa+)+$', '^(\\w+\\s?)*$', '^(?:a+|b+){0,8}$', '^(?:x?a+){0,4}$',
    '^(?:(?:ab)+c)+$', '^(?:a(?=a)a*)+$', '^(?:(a)\\1+)+$']) assert.equal(accepted(source), false, source);
  assert.equal(accepted('^(?:\\p{L}+a)+$', 'u'), false);
});

// Method-diverse lock: the static checker is graded by execution. Every generated pattern it ACCEPTS is run against
// pumped inputs of growing length; the growth stops at the first slow run, so an exponential pattern that slipped
// through fails fast instead of hanging the suite.
function generator(seed) {
  let state = seed >>> 0;
  const next = (n) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const atoms = ['a', 'b', 'c', ' ', '[ab]', '[^a ]', '\\s', '\\S'];
  const quantifiers = ['', '', '?', '*', '+', '{2}', '{0,2}', '{1,3}'];
  const item = (depth) => {
    if (depth < 2 && next(4) === 0) return `(?:${body(depth + 1)})${quantifiers[next(quantifiers.length)]}`;
    return `${atoms[next(atoms.length)]}${quantifiers[next(quantifiers.length)]}`;
  };
  const sequence = (depth) => Array.from({ length: 1 + next(3) }, () => item(depth)).join('');
  const body = (depth) => next(3) === 0 ? `${sequence(depth)}|${sequence(depth)}` : sequence(depth);
  // Half the corpus is built near the accepted boundary (a run, then a terminator that may or may not be disjoint,
  // optional, or grouped), so the accepted set is large enough for the timing check to mean something.
  const runs = ['a', 'b', '\\S', '\\s', '[ab]', '[^ ]', 'c'];
  const terminators = ['b', 'c', ' ', '\\s', '\\S', 'a', '(?:ab)', '(?:a|b)', '(?:cc|ca)', 'c?'];
  const near = () => Array.from({ length: 1 + next(3) }, () => `${runs[next(runs.length)]}${['+', '*', '{1,3}', '?'][next(4)]}${terminators[next(terminators.length)]}`).join(next(4) === 0 ? '|' : '');
  const outer = ['+', '*', '{0,6}', '{2,5}'];
  return () => `^(?:${next(2) ? near() : body(0)})${outer[next(outer.length)]}$`;
}

// The timing runs in a worker so a catastrophic pattern cannot hang the suite: a single match that backtracks
// exponentially never returns to the growth loop, so the main thread terminates the worker once no progress arrives
// within STALL_MS and names the pattern it was on.
const TIMING_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const slow = [];
for (const source of workerData.patterns) {
  parentPort.postMessage({ current: source });
  const regex = new RegExp(source);
  for (const unit of workerData.units) {
    for (const length of [12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 96, 256, 1024, 4096]) {
      const input = unit.repeat(Math.ceil(length / unit.length)).slice(0, length) + '!';
      const start = performance.now();
      regex.test(input);
      const elapsed = performance.now() - start;
      if (elapsed > 100) { slow.push(source + ' on ' + JSON.stringify(unit) + 'x' + length + ': ' + elapsed.toFixed(0) + ' ms'); break; }
    }
  }
}
parentPort.postMessage({ slow });
`;
const STALL_MS = 5000;

function timeAccepted(patterns, units) {
  return new Promise((resolve) => {
    const worker = new Worker(TIMING_WORKER, { eval: true, workerData: { patterns, units } });
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
  const units = [];
  const alphabet = ['a', 'b', 'c', ' '];
  for (const length of [1, 2, 3]) for (let code = 0; code < alphabet.length ** length; code++) {
    units.push([...Array(length)].map((_, k) => alphabet[Math.floor(code / alphabet.length ** k) % alphabet.length]).join(''));
  }
  const patterns = new Set(['^(?:b+(?:a?b))+$', '^(?:b+(?:a|aa)a?)+$']);
  while (patterns.size < 4000) patterns.add(make());
  const acceptedPatterns = [...patterns].filter((source) => accepted(source));
  t.diagnostic(`${acceptedPatterns.length} of ${patterns.size} generated patterns accepted`);
  assert.deepEqual(await timeAccepted(acceptedPatterns, units), []);
  // A guard that refuses everything would pass the timing check vacuously.
  assert.ok(acceptedPatterns.length >= 200, `only ${acceptedPatterns.length} of ${patterns.size} generated patterns accepted`);
});
