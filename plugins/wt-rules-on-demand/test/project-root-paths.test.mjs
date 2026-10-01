import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normal, absolute, parentOf, ancestorsOf, sameDirectory, projectRuleRoots } from '../paths.js';

test('slash-path helpers keep POSIX, drive and UNC roots', () => {
  assert.equal(normal('C:\\a\\b\\'), 'C:/a/b');
  assert.equal(normal('C:\\'), 'C:/');
  assert.equal(normal('/a/b//'), '/a/b');
  assert.equal(normal(''), '/');
  assert.equal(absolute('/a'), true);
  assert.equal(absolute('C:/a'), true);
  assert.equal(absolute('a/b'), false);
  assert.equal(parentOf('/a'), '/');
  assert.equal(parentOf('C:/a'), 'C:/');
  assert.equal(parentOf('//server/share'), '//server/share');
});

test('ancestors are listed root first and end at the directory itself', () => {
  assert.deepEqual(ancestorsOf('/a/b'), ['/', '/a', '/a/b']);
  assert.deepEqual(ancestorsOf('/a/b/'), ['/', '/a', '/a/b']);
  assert.deepEqual(ancestorsOf('/'), ['/']);
  assert.deepEqual(ancestorsOf('C:\\a\\b'), ['C:/', 'C:/a', 'C:/a/b']);
  assert.deepEqual(ancestorsOf('C:/a/b'), ['C:/', 'C:/a', 'C:/a/b']);
  assert.deepEqual(ancestorsOf('\\\\server\\share\\a'), ['//server/share', '//server/share/a']);
  assert.deepEqual(ancestorsOf('a/b'), []);
  assert.deepEqual(ancestorsOf(''), []);
  assert.deepEqual(ancestorsOf(undefined), []);
});

test('directory comparison folds case only for Windows-shaped paths', () => {
  assert.equal(sameDirectory('C:\\Users\\S\\.claude', 'c:/users/s/.claude/'), true);
  assert.equal(sameDirectory('//Server/Share/x', '\\\\server\\share\\X'), true);
  assert.equal(sameDirectory('/Sample-home/s/.claude', '/sample-home/s/.claude'), false);
  assert.equal(sameDirectory('/sample-home/s/.claude/', '/sample-home/s/.claude'), true);
});

test('project rule roots drop the active config directory ancestor', () => {
  assert.deepEqual(projectRuleRoots('/sample-home/p', { configDir: '/sample-home/.claude' }), ['/', '/sample-home/p']);
  assert.deepEqual(projectRuleRoots('/sample-home/p', { configDir: '/sample-config' }), ['/', '/sample-home', '/sample-home/p']);
  assert.deepEqual(projectRuleRoots('C:\\Users\\S\\p', { configDir: 'c:/users/s/.claude/' }), ['C:/', 'C:/Users', 'C:/Users/S/p']);
  assert.deepEqual(projectRuleRoots('/Sample-Home/p', { configDir: '/sample-home/.claude' }), ['/', '/Sample-Home', '/Sample-Home/p']);
});

test('a worktree nested inside its main repository drops the main repository ancestors', () => {
  const worktree = '/sample-project/.claude/worktrees/wt';
  assert.deepEqual(projectRuleRoots(worktree, { mainRepoRoot: '/sample-project', worktreeRoot: worktree }), ['/', worktree]);
  assert.deepEqual(projectRuleRoots(`${worktree}/sub`, { mainRepoRoot: '/sample-project', worktreeRoot: worktree }), ['/', worktree, `${worktree}/sub`]);
  // A plain subdirectory of the main checkout keeps every ancestor, the repository root included.
  assert.deepEqual(projectRuleRoots('/sample-project/a', { mainRepoRoot: '/sample-project', worktreeRoot: '/sample-project' }), ['/', '/sample-project', '/sample-project/a']);
  assert.deepEqual(projectRuleRoots('/sample-project/a', { mainRepoRoot: '/sample-project' }), ['/', '/sample-project', '/sample-project/a']);
  // A worktree outside its main repository keeps every ancestor.
  assert.deepEqual(projectRuleRoots('/sample-suite/wt', { mainRepoRoot: '/sample-elsewhere', worktreeRoot: '/sample-suite/wt' }), ['/', '/sample-suite', '/sample-suite/wt']);
  assert.deepEqual(projectRuleRoots('C:\\p\\.claude\\worktrees\\wt', { mainRepoRoot: 'c:/P', worktreeRoot: 'C:/p/.claude/worktrees/wt' }), ['C:/', 'C:/p/.claude/worktrees/wt']);
});

test('a relative session root yields no project roots', () => {
  assert.deepEqual(projectRuleRoots('.', { configDir: '/sample-config' }), []);
  assert.deepEqual(projectRuleRoots('sample/rel', {}), []);
});
