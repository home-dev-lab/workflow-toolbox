import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const nested = start(s.config, wt);
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /engine disabled; 1 on-demand rules are neither static nor served/);
  const plain = start(s.config, join(s.project, '.claude'));
  assert.match(plain.stdout, /engine disabled; 1 on-demand rules are neither static nor served/);
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
