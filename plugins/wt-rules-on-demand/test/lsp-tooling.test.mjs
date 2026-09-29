import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from './clean-env.mjs';
import { readSpec, migrateRule } from '../scripts/rule-lifecycle-lib.mjs';
import { scanTranscripts } from '../scripts/transcript-verdicts.mjs';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
const spec = `on-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Grep$'\n      detector: 'lsp-symbol-grep'\n      before-first-act: true\ncompliance:\n  kind: 'next-call'\n  tool: '^(?:LSP|Grep)$'\n  require-tool: '^LSP$'\n  window: '3'\n  on-close: 'not applicable'\n`;

test('lifecycle spec accepts detector and proof reports it as environment-dependent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-lsp-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'spec.yaml'), transcripts = join(root, 'sessions');
  await mkdir(join(root, '.claude/rules'), { recursive: true }); await mkdir(transcripts);
  await writeFile(file, spec); await writeFile(join(root, '.claude/rules/lsp.md'), 'Use LSP.\n');
  await writeFile(join(transcripts, 'session.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'buildEnvelope', path: '/repo/a.ts' } }] } }) + '\n');
  assert.equal((await readSpec(file)).triggers[0].detector, 'lsp-symbol-grep');
  const run = spawnSync(process.execPath, [script('rules'), 'prove-triggers', 'lsp.md', '--project', root, '--spec', file, '--transcripts', transcripts], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /not provable from transcripts \(environment-dependent detector\)/);
});

test('transcript scan labels next-call unmeasured and never fabricates verdicts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-lsp-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '.claude/rules-on-demand'), transcripts = join(root, 'sessions');
  await mkdir(dir, { recursive: true }); await mkdir(transcripts);
  await writeFile(join(dir, 'lsp.md'), `---\n${spec.replace(/^compliance:/m, '  compliance:').replace(/^ {2}(kind|tool|require-tool|window|on-close):/gm, '    $1:')}---\nUse LSP.\n`);
  const at = new Date(Date.now() - 1000).toISOString();
  await writeFile(join(transcripts, 'session.jsonl'), [
    { type: 'assistant', cwd: root, timestamp: at, message: { content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'buildEnvelope', path: '/repo/a.ts' } }] } },
    { type: 'assistant', cwd: root, timestamp: at, message: { content: [{ type: 'tool_use', id: 'l', name: 'LSP', input: {} }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const scan = await scanTranscripts({ projectsDirs: [transcripts], scopes: [{ scope: 'project', projectRoot: root, rulesDir: dir }], migrationDateOf: async () => null, lastChangeOf: async () => null });
  assert.deepEqual(scan.rows, []);
  assert.match(scan.coverage.unmeasuredRules[0].reason, /next-call.*store verdicts/);
});

test('rollback computes next-call rate from live store verdicts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-lsp-rate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  await writeFile(join(root, '.claude/rules/lsp.md'), 'Use LSP.\n');
  const yaml = join(root, 'spec.yaml'); await writeFile(yaml, spec);
  await migrateRule(root, 'lsp.md', await readSpec(yaml), {});
  const ledger = join(root, '.claude/rules-on-demand-ledger.jsonl');
  const entry = JSON.parse((await readFile(ledger, 'utf8')).trim());
  await writeFile(ledger, `${JSON.stringify({ ...entry, time: '2025-01-01T00:00:00Z' })}\n`);
  const store = join(root, 'store.json'), identity = `project:${join(root, '.claude/rules-on-demand')}:lsp.md`;
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': ['followed', 'not followed'].map((verdict) => JSON.stringify({ rule: 'lsp.md', ruleIdentity: identity, verdict, decidedAt: '2026-09-28T00:00:00Z' })).join('\n') + '\n' }));
  const run = spawnSync(process.execPath, [script('rollback-check'), '--project', root, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout)[0].applicable, 2);
  assert.equal(JSON.parse(run.stdout)[0].followed, 1);
});
