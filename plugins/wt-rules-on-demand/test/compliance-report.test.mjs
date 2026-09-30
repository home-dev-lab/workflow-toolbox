import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

test('compliance aggregation counts served separately from verdicts and flags missing checks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-compliance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const project = join(root, 'project');
  const directory = join(project, '.claude/rules-on-demand');
  await mkdir(directory, { recursive: true });
  const rule = (kind) => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n  compliance:\n    ${kind === 'none' ? "kind: 'none'\n    reason: 'fixture'" : "kind: 'check'\n    check: 'agent-model'"}\n---\nBody\n`;
  for (const [name, kind] of [['a.md', 'check'], ['silent.md', 'check'], ['none.md', 'none']]) await writeFile(join(directory, name), rule(kind));
  const store = join(root, 'store.json');
  const lines = [
    { rule: 'a.md', verdict: 'followed' }, { rule: 'a.md', verdict: 'not followed' },
    { rule: 'a.md', verdict: 'not applicable', reason: 'no governed act' },
    { rule: 'b.md', verdict: 'unknown', reason: 'classifier unavailable' },
  ].map(JSON.stringify).join('\n');
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': lines, served: { 'a.md': { count: 5 }, 'none.md': { count: 2 }, 'silent.md': { count: 1 }, 'missing.md': { count: 4 } } }));
  const cli = fileURLToPath(new URL('../scripts/compliance-report.mjs', import.meta.url));
  const run = (...extra) => spawnSync(process.execPath, [cli, '--store', store, '--project', project, '--config-dir', config, ...extra], { encoding: 'utf8', env: cleanEnv() });
  const json = run('--json');
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.deepEqual([rows['a.md'].served, rows['a.md'].injections, rows['a.md'].followRate], [5, 3, 0.5]);
  assert.deepEqual([rows['none.md'].served, rows['none.md'].check, rows['none.md'].injections], [2, 'no check declared', 0]);
  assert.equal(rows['missing.md'].check, 'no check declared');
  assert.match(rows['silent.md'].note, /no verdict recorded/);
  assert.equal(rows['b.md'].reasons['classifier unavailable'], 1);
  assert.equal(rows['a.md'].reasons['no governed act'], 1);
  const archive = join(config, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, 'compliance-verdicts-archive-1000-1.jsonl'), JSON.stringify({ rule: 'a.md', verdict: 'followed' }) + '\n');
  const withArchive = JSON.parse(run('--json').stdout);
  assert.equal(withArchive['a.md'].injections, 4);
  assert.match(run().stdout, /^none\.md\t2\tno check declared\t/m);
  const extra = join(root, 'extra');
  await mkdir(extra);
  await writeFile(join(extra, 'broken.md'), rule('check').replace("check: 'agent-model'", "check: 'unsupported'"));
  await writeFile(join(extra, 'custom.md'), rule('check'));
  await writeFile(store, JSON.stringify({ served: { 'broken.md': { count: 1 }, 'custom.md': { count: 1 } } }));
  const overridden = JSON.parse(run('--rules-dir', extra, '--json').stdout);
  assert.match(overridden['broken.md'].check, /^invalid: unknown compliance check/);
  assert.equal(overridden['custom.md'].check, 'declared');
});

test('delivery join removes repeated window verdicts and notes unjudged windows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-joined-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), store = join(root, 'store.json');
  const entry = (id) => ({ rule: 'r.md', ruleIdentity: 'user:r.md', at: '2026-01-01T00:00:00Z', deliveryId: id, deliverySeq: 10, servingSeq: 9 });
  const first = { ...entry('t-10'), verdictId: 't-12', actSeq: 12, sessionId: 's', verdict: 'followed', decidedAt: '2026-01-01T00:00:01Z' };
  const second = { ...first, verdictId: 't-13', verdict: 'not followed', actSeq: 13 };
  await writeFile(store, JSON.stringify({ served: { 'r.md': { count: 2 } }, sessions: { s: { contexts: { 0: { complianceInjected: [entry('t-10'), entry('t-11')] } } } }, 'compliance-verdicts-jsonl': [first, second].map(JSON.stringify).join('\n') }));
  const cli = fileURLToPath(new URL('../scripts/compliance-report.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, '--store', store, '--config-dir', config, '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout)['r.md'];
  assert.equal(report.injections, 1, 'duplicate window verdict must not increase the denominator');
  assert.equal(report.duplicateRows, 1);
  assert.equal(report.unjudged, 1);
  assert.match(report.note, /1 deliveries without a verdict/);
});
