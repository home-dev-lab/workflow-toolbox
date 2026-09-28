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
