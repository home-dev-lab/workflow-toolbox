import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

const script = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
const sample = (body) => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'sample'\n---\n${body}\n`;

async function tree(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rod-ancestors-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  return { root, config, project };
}
// A different-body static twin in the user static dir makes every on-demand copy in the set print its own path.
const twins = async (config, names) => {
  await mkdir(join(config, 'rules'), { recursive: true });
  for (const name of names) await writeFile(join(config, 'rules', name), 'A different static text.\n');
};
const survivors = (stdout) => [...stdout.matchAll(/^same name, different rule: \S+ and (\S+)$/gm)].map((match) => basename(match[1])).sort();
const start = (config, cwd) => spawnSync(process.execPath, [script], {
  encoding: 'utf8', input: JSON.stringify({ source: 'startup', cwd }),
  env: cleanEnv({ CLAUDE_CONFIG_DIR: config, WT_ROD_QUALITY_SPAWN: '0', CLAUDE_PLUGIN_OPTION_ENABLED: 'false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }),
});

test('T10: startup from a nested directory counts the ancestor rules and their static duplicates', async (t) => {
  const s = await tree(t);
  const sub = join(s.project, 'sub');
  await mkdir(join(sub, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(s.project, '.claude/rules-on-demand/outer.md'), sample('Outer'));
  await writeFile(join(s.project, '.claude/rules/dup.md'), 'Dup\n');
  await writeFile(join(sub, '.claude/rules-on-demand/dup.md'), sample('Dup'));
  const run = start(s.config, sub);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /loaded twice: .*project[\\/]\.claude[\\/]rules[\\/]dup\.md and .*sub[\\/]\.claude[\\/]rules-on-demand[\\/]dup\.md/);
  assert.match(run.stdout, /engine disabled; 1 on-demand rules are neither static nor served/);
});

test('T10b: startup in a worktree nested in its main repository leaves the main repository rules out', async (t) => {
  const s = await tree(t);
  const wt = join(s.project, '.claude/worktrees/wt');
  const gitdir = join(s.project, '.git/worktrees/wt');
  await mkdir(join(wt, '.claude/rules-on-demand'), { recursive: true });
  await mkdir(gitdir, { recursive: true });
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  await writeFile(join(wt, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(join(s.project, '.claude/rules-on-demand/main.md'), sample('Main'));
  await writeFile(join(wt, '.claude/rules-on-demand/own.md'), sample('Own'));
  await twins(s.config, ['main.md', 'own.md']);
  const nested = start(s.config, wt);
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /engine disabled; 1 on-demand rules are neither static nor served/);
  assert.deepEqual(survivors(nested.stdout), ['own.md']);
  const plain = start(s.config, join(s.project, '.claude'));
  assert.match(plain.stdout, /engine disabled; 1 on-demand rules are neither static nor served/);
  assert.deepEqual(survivors(plain.stdout), ['main.md']);
});

test('T10c: a broken worktree link means no exclusion, never a failure', async (t) => {
  const s = await tree(t);
  const wt = join(s.project, '.claude/worktrees/wt');
  await mkdir(join(wt, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(wt, '.git'), 'gitdir: /sample-missing/worktrees/wt\n');
  await writeFile(join(s.project, '.claude/rules-on-demand/main.md'), sample('Main'));
  await writeFile(join(wt, '.claude/rules-on-demand/own.md'), sample('Own'));
  const run = start(s.config, wt);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /engine disabled; 2 on-demand rules are neither static nor served/);
  assert.match(run.stdout, /wt-rules-on-demand: nested-worktree check unknown: .*missing/);
});

test('T10d: the config directory reached as an ancestor through a symlinked spelling is counted once', async (t) => {
  const s = await tree(t);
  const home = join(s.root, 'home');
  await mkdir(join(home, '.claude/rules-on-demand'), { recursive: true });
  await mkdir(join(home, 'proj'), { recursive: true });
  await writeFile(join(home, '.claude/rules-on-demand/mine.md'), sample('Mine'));
  const alias = join(s.root, 'alias');
  await symlink(join(home, '.claude'), alias);
  await mkdir(join(home, '.claude/rules'), { recursive: true });
  await writeFile(join(home, '.claude/rules/mine.md'), 'Mine\n');
  const run = start(alias, join(home, 'proj'));
  assert.equal(run.status, 0, run.stderr);
  // Walked as a project ancestor too, the config directory would win under its home spelling and match twice.
  const twice = run.stdout.split('\n').filter((line) => line.startsWith('loaded twice:'));
  assert.equal(twice.length, 1, run.stdout);
  assert.match(twice[0], /alias[\\/]rules-on-demand[\\/]mine\.md/);
});

// The same worktree table as the hook's, through the startup command on a real filesystem. A self-referencing
// `.git` symlink stands in for an unreadable entry (stat fails with ELOOP, not with not-found).
async function layout(t, shape) {
  const s = await tree(t);
  const wt = join(s.project, '.claude/worktrees/wt');
  const mainRule = join(s.project, '.claude/rules-on-demand/main.md');
  await writeFile(mainRule, sample('Main'));
  const link = async (dir, main) => {
    const gitdir = join(main, '.git/worktrees/wt');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.git'), `gitdir: ${gitdir}\n`);
  };
  let cwd = wt;
  if (shape === 'outside') {
    cwd = join(s.root, 'suite/wt');
    await link(cwd, join(s.root, 'elsewhere'));
    await mkdir(join(s.root, 'suite/.claude/rules-on-demand'), { recursive: true });
    await writeFile(join(s.root, 'suite/.claude/rules-on-demand/main.md'), sample('Outer'));
  } else if (shape === 'submodule') {
    cwd = join(s.project, 'mod');
    await mkdir(join(s.project, '.git/modules/mod'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, '.git'), 'gitdir: ../.git/modules/mod\n');
  } else if (shape === 'git-dir') {
    cwd = join(s.project, 'mod');
    await mkdir(join(cwd, '.git'), { recursive: true });
  } else {
    await link(wt, s.project);
    if (shape === 'unreadable') { await rm(join(wt, '.git')); await symlink(join(wt, '.git'), join(wt, '.git')); }
    if (shape === 'malformed') await writeFile(join(wt, '.git'), 'not a pointer\n');
  }
  await mkdir(join(cwd, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(cwd, '.claude/rules-on-demand/own.md'), sample('Own'));
  await twins(s.config, ['main.md', 'own.md']);
  return start(s.config, cwd);
}
for (const [shape, expected, unknown] of [
  ['nested', ['own.md'], null],
  ['outside', ['main.md', 'own.md'], null],
  ['submodule', ['main.md', 'own.md'], null],
  ['git-dir', ['main.md', 'own.md'], null],
  ['unreadable', ['main.md', 'own.md'], /nested-worktree check unknown: .*ELOOP/],
  ['malformed', ['main.md', 'own.md'], /nested-worktree check unknown: malformed/],
]) {
  test(`F2 startup: ${shape}`, async (t) => {
    const run = await layout(t, shape);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(survivors(run.stdout), expected, run.stdout);
    if (unknown) assert.match(run.stdout, unknown);
    else assert.doesNotMatch(run.stdout, /nested-worktree check unknown/);
  });
}
