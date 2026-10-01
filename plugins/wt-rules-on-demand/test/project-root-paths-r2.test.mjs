import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, projectRuleRoots, joinSlash } from '../paths.js';

test('F4: dot segments collapse before the walk and never climb above the root', () => {
  assert.deepEqual(ancestorsOf('/a/../b'), ['/', '/b']);
  assert.deepEqual(ancestorsOf('/a/./b'), ['/', '/a', '/a/b']);
  assert.deepEqual(ancestorsOf('/..'), ['/']);
  assert.deepEqual(ancestorsOf('/a/../../b'), ['/', '/b']);
  assert.deepEqual(ancestorsOf('C:\\a\\..\\..\\b'), ['C:/', 'C:/b']);
  assert.deepEqual(ancestorsOf('\\\\server\\share\\..\\a'), ['//server/share', '//server/share/a']);
  assert.deepEqual(projectRuleRoots('/sample-a/../sample-b', {}), ['/', '/sample-b']);
});

test('F3: only a rooted raw spelling is absolute; drive-relative and root-relative spellings are not', () => {
  for (const raw of ['', 'C:', 'C:foo', '\\p\\x', 'rel/a', '.']) assert.deepEqual(ancestorsOf(raw), [], JSON.stringify(raw));
  assert.deepEqual(ancestorsOf('/'), ['/']);
  assert.deepEqual(ancestorsOf('X:/'), ['X:/']);
  assert.deepEqual(ancestorsOf('X:\\'), ['X:/']);
  assert.deepEqual(ancestorsOf('\\\\server\\share'), ['//server/share']);
});

test('G5: joining onto a root keeps that root and never climbs past it', () => {
  const table = [
    ['/', 'a/b', '/a/b'], ['/', '..', '/'], ['/', '../a', '/a'], ['/', '.', '/'],
    ['C:/', 'a', 'C:/a'], ['C:/', '..\\..', 'C:/'], ['C:\\', 'a\\b', 'C:/a/b'],
    ['//srv/share', 'a', '//srv/share/a'], ['//srv/share', '../..', '//srv/share'], ['\\\\srv\\share', 'a', '//srv/share/a'],
    ['/a', 'b', '/a/b'], ['/a/b', '../../..', '/'], ['C:/a', '../../x', 'C:/x'], ['/a', '/abs', '/abs'],
  ];
  for (const [base, part, expected] of table) assert.equal(joinSlash(base, part), expected, `${base} + ${part}`);
});
