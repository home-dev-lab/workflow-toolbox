import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestorsOf, projectRuleRoots } from '../paths.js';

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
