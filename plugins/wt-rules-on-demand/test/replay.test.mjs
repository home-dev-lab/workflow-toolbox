import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayTranscript } from '../scripts/replay-transcript.mjs';

test('replay finds rules using the same project/config directory contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const config = join(root, 'config');
  await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(join(project, '.claude/rules-on-demand/check.md'), `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'sample'\n---\nReview first.\n`);
  const row = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fixture-use', name: 'Agent', input: { prompt: 'work' } }] }, sessionId: 'fixture-session' };
  const result = await replayTranscript({ transcriptText: JSON.stringify(row), configDir: config, projectRoot: project });
  assert.equal(result.counts.refusals, 1);
  assert.equal(result.store.served['check.md'].count, 1);
});

test('replay of a session rooted in a worktree nested in its main checkout leaves the main checkout rules out', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-replay-wt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const wt = join(project, '.claude/worktrees/wt');
  const config = join(root, 'config');
  const rule = (body) => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'sample'\n---\n${body}\n`;
  await mkdir(join(project, '.git/worktrees/wt'), { recursive: true });
  await writeFile(join(project, '.git/worktrees/wt/commondir'), '../..\n');
  await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(project, '.claude/rules-on-demand/main.md'), rule('Main checkout.'));
  await mkdir(join(wt, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(wt, '.git'), `gitdir: ${join(project, '.git/worktrees/wt')}\n`);
  await writeFile(join(wt, '.claude/rules-on-demand/own.md'), rule('Worktree.'));
  await mkdir(config, { recursive: true });
  const row = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fixture-use', name: 'Agent', input: { prompt: 'work' } }] }, sessionId: 'fixture-session' };
  const result = await replayTranscript({ transcriptText: JSON.stringify(row), configDir: config, projectRoot: wt });
  assert.deepEqual(Object.keys(result.store.served).sort(), ['own.md']);
});

test('replay reports a .git that is neither a file nor a directory as such, never reads it', { skip: process.platform === 'win32' && 'unix sockets stand in for a special file' }, async (t) => {
  const { createServer } = await import('node:net');
  const root = await mkdtemp(join(tmpdir(), 'rod-rs-'));
  const server = createServer();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const project = join(root, 'p');
  const config = join(root, 'c');
  await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
  await mkdir(config, { recursive: true });
  await new Promise((resolve) => server.listen(join(project, '.git'), resolve));
  const row = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fixture-use', name: 'Agent', input: {} }] }, sessionId: 'fixture-session' };
  const result = await replayTranscript({ transcriptText: JSON.stringify(row), configDir: config, projectRoot: project });
  assert.ok(result.logs.some((line) => /nested-worktree check unknown: .*\.git is neither a file nor a directory/.test(line)), result.logs.join('\n'));
});
