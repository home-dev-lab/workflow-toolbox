import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

test('prove-triggers counts every trigger, ignores mentions, follows transcript symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rod-proof-'));
  try {
    const rules = join(root, '.claude', 'rules');
    const transcripts = join(root, 'transcripts');
    await mkdir(rules, { recursive: true });
    await mkdir(transcripts);
    await writeFile(join(rules, 'sample.md'), 'Synthetic body.\n');
    const spec = join(root, 'sample.spec.json');
    await writeFile(spec, JSON.stringify({ 'on-demand': { triggers: [
      { kind: 'bash', regex: 'deploy' },
      { kind: 'tool', tool: '^Agent$', 'input-regex': 'sonnet' },
    ] }, compliance: { kind: 'none', reason: 'synthetic' } }));
    const row = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const real = join(root, 'source.jsonl');
    await writeFile(real, [row('mention', 'Bash', { command: 'grep deploy README.md' }), row('act', 'Bash', { command: 'deploy staging' }), row('agent', 'Agent', { model: 'sonnet' })].join('\n') + '\n');
    await symlink(real, join(transcripts, 'linked.jsonl'));
    const script = process.env.ROD_TEST_RULES ?? fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [script, 'prove-triggers', 'sample.md', '--project', root, '--spec', spec, '--transcripts', transcripts], { encoding: 'utf8', env: cleanEnv() });
    const report = JSON.parse(output);
    assert.deepEqual(report.byTrigger.map((entry) => entry.matches), [1, 1]);
    assert.equal(report.inspected, 3);
    assert.equal(report.matches, 2);
    assert.equal(report.skipped, 0);
    assert.equal(await readFile(join(rules, 'sample.md'), 'utf8'), 'Synthetic body.\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
