import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worktreePlan } from '../paths.js';

// Fulfils the plan's stat/read requests from a file map; a directory exists when a file lies under it.
function run(sessionRoot, files, fail = {}) {
  const isDir = (path) => Object.keys(files).some((file) => file.startsWith(path.endsWith('/') ? path : `${path}/`));
  const missing = (path) => Object.assign(new Error(`${path} failed: ENOENT`), { code: 'ENOENT' });
  const plan = worktreePlan(sessionRoot);
  let step = plan.next();
  while (!step.done) {
    const { op, path } = step.value;
    let response;
    if (fail[path]) response = { error: fail[path] };
    else if (op === 'stat') response = path in files ? { value: { kind: 'file' } } : isDir(path) ? { value: { kind: 'dir' } } : { error: missing(path) };
    else if (op === 'read') response = path in files ? { value: files[path] } : { error: missing(path) };
    else throw new Error(`unexpected request ${op}`);
    step = plan.next(response);
  }
  return step.value;
}
const linked = { '/p/.git/HEAD': 'ref', '/p/.git/worktrees/w/commondir': '../..\n', '/p/c/w/.git': 'gitdir: /p/.git/worktrees/w\n' };

test('a linked worktree names its working tree and its main checkout', () => {
  assert.deepEqual(run('/p/c/w', linked), { worktreeRoot: '/p/c/w', mainRepoRoot: '/p' });
  assert.deepEqual(run('/p/c/w/sub', linked), { worktreeRoot: '/p/c/w', mainRepoRoot: '/p' });
  assert.deepEqual(run('/p/c/w', { ...linked, '/p/c/w/.git': 'gitdir: ../../.git/worktrees/w\n' }), { worktreeRoot: '/p/c/w', mainRepoRoot: '/p' });
});

test('a Windows-shaped linked worktree resolves to slash paths', () => {
  const files = { 'C:/p/.git/HEAD': 'ref', 'C:/p/.git/worktrees/w/commondir': '../..\r\n', 'C:/p/w/.git': 'gitdir: C:\\p\\.git\\worktrees\\w\r\n' };
  assert.deepEqual(run('C:\\p\\w', files), { worktreeRoot: 'C:/p/w', mainRepoRoot: 'C:/p' });
});

test('no linked worktree: a .git directory, no .git, a submodule gitdir, a common directory not named .git', () => {
  assert.equal(run('/p/sub', { '/p/.git/HEAD': 'ref' }), null);
  assert.equal(run('/p/sub', {}), null);
  assert.equal(run('/p/mod', { '/p/.git/modules/mod/HEAD': 'ref', '/p/mod/.git': 'gitdir: ../.git/modules/mod\n' }), null);
  assert.equal(run('/w', { '/store/repo.git/worktrees/w/commondir': '../..\n', '/store/repo.git/HEAD': 'ref', '/w/.git': 'gitdir: /store/repo.git/worktrees/w\n' }), null);
  assert.equal(run('rel/a', linked), null);
});

test('a failure other than not-found, or a malformed git file, is a named unknown', () => {
  const denied = Object.assign(new Error('stat /p/c/w/.git failed: EACCES'), { code: 'EACCES' });
  assert.match(run('/p/c/w', linked, { '/p/c/w/.git': denied }).unknown, /EACCES/);
  assert.match(run('/p/c/w', { ...linked, '/p/c/w/.git': 'not a pointer\n' }).unknown, /^malformed /);
  assert.match(run('/p/c/w', { ...linked, '/p/.git/worktrees/w/commondir': '\n' }).unknown, /^malformed /);
  assert.match(run('/p/c/w', { '/p/c/w/.git': 'gitdir: /gone/worktrees/w\n' }).unknown, /missing/);
  assert.match(run('/p/c/w', { '/p/.git/worktrees/w/commondir': '/gone/.git\n', '/p/c/w/.git': 'gitdir: /p/.git/worktrees/w\n' }).unknown, /common directory/);
});
