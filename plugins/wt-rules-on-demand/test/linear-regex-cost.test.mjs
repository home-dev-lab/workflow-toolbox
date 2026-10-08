import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const mod = await import(process.env.ROD_TEST_LINEAR ? pathToFileURL(process.env.ROD_TEST_LINEAR).href : '../hooks/linear-regex.js');
const { linearRegex } = mod;
// Synthetic patterns of the construct classes real trigger rules use; neutral words only.
const words = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}x`);
const real = [
  `(?:${words(20, 'branch').join('|')})\\d`, `(?:${words(70, 'Branch').join('|')})\\d`, `\\b(?:${words(30, 'cmd').join('|')})\\b`,
  '\\bdeploy\\s+--force\\b[^\\n]*--since', '(?:sudo\\s+)?(?:env\\s+)?run\\b(?:\\s+--fast)?',
  '^(?!(?=.*?\\x22kind\\x22:\\x22alpha\\x22)(?!.*?\\x22note\\x22:\\x22skip))(?:.*?\\x22kind\\x22:\\x22(?:alpha|beta|gamma)\\x22)',
  '(?:(?=.*?\\x22mode\\x22:\\x22fast\\x22)|(?!.*\\bstaging\\b))done',
  '(?:alpha\\d|[a-z]+\\d{2})', '[A-Za-z]+_[0-9]{2,4}', 'x{2,5}y', '\\x22items\\x22:\\[[^\\]]*\\]', '^(?:ship|build)\\s+(?:it|them)$',
  '(?:^|[;&|(]\\s*)(?:echo|printf)\\s+["\'][^"\']*Done', 'first\\s+second|third', '(?<=ship )it', 'Case(?:Mixed|Fold)',
];

const heredoc = `cat <<'EOF' > notes.txt\n${'Deploy the Kelvin build, then ship it to staging; echo "Done" # Case Mixed\n'.repeat(210)}EOF\n`.slice(0, 15 * 1024);
const subjects = [
  'git status', 'Kelvin', 'KELVIN', 'kelvin', 'Kelvin', 'ſhip it', 'SHIP IT', 'Ship it now',
  'Bash: deploy --force', '{"subagent_type":"Explore","prompt":"read only please"}', 'Mixed CASE input\nsecond line', '',
];
const targeted = [
  ['kelvin', 'i'], ['kelvin', 'iu'], ['kelvin', 'u'], ['kelvin', ''], ['ship', 'iu'], ['ship', 'i'], ['SHIP', 'i'], ['SHIP', 'iu'],
  ['(?:alpha|beta|gamma)delta', 'i'], ['deploy|staging|echo', 'i'], ['deploy|staging|echo', ''], ['^kelvin$', 'im'], ['(kelvin)\\s+build', 'iu'],
  [Array.from({ length: 40 }, (_, i) => `word${i}x`).join('|'), ''], [Array.from({ length: 40 }, (_, i) => `Word${i}X`).join('|'), 'i'],
  ['\\bkelvin\\b', 'iu'], ['st[a]ging', 'i'], ['done', 'i'], ['DONE', ''],
];
const cases = [...targeted, ...real.flatMap((p) => ['', 'i', 'm', 'u', 'iu'].map((f) => [p, f]))];

function compile(source, flags) {
  try { new RegExp(source, flags); } catch { return null; }
  try { return linearRegex(source, flags); } catch { return null; }
}

test('differential: prefilter and caches never change a verdict versus the native engine', () => {
  let pairs = 0;
  for (const [source, flags] of cases) {
    const matcher = compile(source, flags);
    if (!matcher) continue;
    for (const subject of [...subjects, ...(flags === '' || flags === 'i' ? [heredoc] : [])]) {
      const expected = new RegExp(source, flags).test(subject);
      assert.equal(matcher.test(subject), expected, `/${source.slice(0, 60)}/${flags} vs ${JSON.stringify(subject.slice(0, 30))}`);
      pairs++;
    }
  }
  assert.ok(pairs > 1000, `differential covered ${pairs} pairs`);
});

test('differential: long s and Kelvin sign fold to ASCII under iu, so the prefilter must not reject them', () => {
  assert.equal(linearRegex('kelvin', 'iu').test('Kelvin'), true);
  assert.equal(linearRegex('ship', 'iu').test('ſhip'), true);
  assert.equal(linearRegex('kelvin', 'i').test('Kelvin'), false);
});

const long = 'q'.repeat(16 * 1024);
test('cost: a case-insensitive pattern with a mandatory literal skips the VM when the literal is absent', () => {
  const matcher = linearRegex('deploy\\s+\\w+', 'i');
  assert.equal(matcher.test(long), false);
  assert.equal(matcher.steps, 0, 'no VM step on a subject lacking the literal');
  assert.equal(matcher.test(`${long} DEPLOY now`), true, 'mixed-case literal still found');
});

test('cost: a 20-branch literal alternation skips the VM when no branch occurs', () => {
  const matcher = linearRegex(`(?:${Array.from({ length: 20 }, (_, i) => `branch${String.fromCharCode(97 + i)}x`).join('|')})\\d`);
  assert.equal(matcher.test(long), false);
  assert.equal(matcher.steps, 0);
});

test('cost: atom rows are built once per atom and flags, across matchers and subjects', () => {
  assert.equal(typeof mod.costCounters?.atomRows, 'number', 'test seam exported');
  const first = linearRegex('[a-f]+\\d\\w', '');
  first.test('abc1 first subject here');
  const built = mod.costCounters.atomRows;
  const second = linearRegex('[a-f]+\\d\\w', '');
  second.test('a quite different subject 7z');
  second.test('and a third one: dead9x');
  assert.equal(mod.costCounters.atomRows, built, 'second matcher and subjects reuse rows');
});
