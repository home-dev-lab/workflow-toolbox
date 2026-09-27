import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRule, rollbackDecision } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';
import { scanTranscripts } from '../scripts/transcript-verdicts.mjs';
import { dailyRollback } from '../scripts/daily-rollback.mjs';
import { safeRegex } from '../hooks/evidence.js';
import { performance } from 'node:perf_hooks';

const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'tool-input', tool: '^Agent$', 'require-input-regex': 'yes', window: 1, 'on-close': 'not applicable' } };
const scenarios = [
  { label: 'miss without static baseline', after: [], before: [], action: 'attention' },
  { label: 'miss with improved follow rate', after: Array(5).fill('followed'), before: ['followed', 'followed', 'not followed', 'not followed', 'not followed'], action: 'attention' },
  { label: 'miss with independently worse follow rate', after: ['followed', ...Array(4).fill('not followed')], before: Array(5).fill('followed'), action: 'would revert' },
];

for (const { label, after, before, action } of scenarios) test(`comparative rollback: ${label}`, async (t) => {
  const input = { triggerMissMatched: 1, followed: after.filter((v) => v === 'followed').length, applicable: after.length,
    beforeFollowed: before.filter((v) => v === 'followed').length, beforeApplicable: before.length };
  const decision = rollbackDecision(input);
  assert.equal(decision.attention, action === 'attention');
  assert.match(decision.reason, /trigger miss/);
  assert.match(decision.recommendation, /engine defect/);
  if (action === 'would revert') assert.match(decision.reason, /below static/);

  const root = await mkdtemp(join(tmpdir(), 'rod-converge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body\n');
  await migrateRule(root, 'sample.md', spec, {});
  const ledger = join(root, '.claude/rules-on-demand-ledger.jsonl');
  const row = JSON.parse((await readFile(ledger, 'utf8')).trim());
  await writeFile(ledger, JSON.stringify({ ...row, time: '2026-01-01T00:00:00Z' }) + '\n');
  const rulesDir = join(root, '.claude/rules-on-demand');
  const verdicts = join(root, 'verdicts.jsonl'), store = join(root, 'store.json');
  await writeFile(store, '{}');
  const dated = (verdict, phase, index) => ({ rule: 'sample.md', scope: 'project', rulesDir, verdict, phase,
    at: phase === 'before' ? '2025-12-01T00:00:00Z' : '2026-06-01T00:00:00Z', line: index + 1, file: 'fixture' });
  const rows = [...before.map((v, i) => ({ ...dated('static baseline', 'before', i), checkVerdict: v })),
    ...after.map((v, i) => dated(v, 'after', i)), { ...dated('trigger miss', 'after', 30), triggerMatched: true }];
  await writeFile(verdicts, rows.map((v) => JSON.stringify(v)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [rollback, '--project', root, '--store', store, '--verdicts', verdicts, '--mechanical-only', '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout)[0];
  assert.equal(result.action, action);
  assert.match(result.reason, /trigger miss/);
  if (action === 'would revert') assert.match(result.reason, /below static/);
  assert.equal(result.triggerMissEvidence.length, 1);
});

test('explicit temporary project counts as covered and daily rollback proceeds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), projects = join(config, 'projects');
  await mkdir(join(root, '.claude/rules'), { recursive: true }); await mkdir(projects, { recursive: true });
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body\n');
  await migrateRule(root, 'sample.md', spec, {});
  const ledger = join(root, '.claude/rules-on-demand-ledger.jsonl');
  const row = JSON.parse((await readFile(ledger, 'utf8')).trim());
  const migrated = new Date(Date.now() - 2 * 86400000).toISOString(), at = new Date(Date.now() - 86400000).toISOString();
  await writeFile(ledger, JSON.stringify({ ...row, time: migrated }) + '\n');
  const records = [
    { type: 'attachment', cwd: root, timestamp: at, attachment: { type: 'hook_additional_context', content: '<rule name="sample.md">Body</rule>', toolUseID: 'call-context' } },
    { type: 'assistant', cwd: root, timestamp: at, message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { prompt: 'yes' } }] } },
    { type: 'system', subtype: 'compact_boundary', cwd: root, timestamp: at },
    { type: 'user', cwd: root, timestamp: at, message: { content: 'next turn' } },
  ];
  await writeFile(join(projects, 'session.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const scope = { scope: 'project', projectRoot: root, rulesDir: join(root, '.claude/rules-on-demand'), ledgerRoots: [root] };
  const scan = await scanTranscripts({ projectsDirs: [projects], scopes: [scope], migrationDateOf: async () => null, lastChangeOf: async () => null });
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.complete, true, JSON.stringify(scan.coverage));
  const discovered = await scanTranscripts({ projectsDirs: [projects], scopes: [], discoverProjects: true, skipCwdPrefixes: [],
    migrationDateOf: async () => null, lastChangeOf: async () => null });
  assert.equal(discovered.rows.length, 1);
  assert.deepEqual(discovered.stats.projects, []);
  assert.equal(discovered.stats.tmpProjectsSkipped, 1);
  await mkdir(join(config, 'rules-on-demand'));
  await writeFile(join(config, 'rules-on-demand/followed-projects.json'), JSON.stringify([{ root, addedAt: migrated, by: 'test' }]));
  const daily = await dailyRollback({ configDirs: [config], projectsDirs: [projects], project: root, dataDir: join(root, 'quality') });
  assert.equal(daily.code, 0, daily.result.error);
});

test('regex boundary disjointness accepts deterministic repetitions and refuses ambiguous ones', () => {
  const accepted = ['^(?:[^/]+/)+file$', '^(?:ab+)+$', 'push\\s+(?:-[^\\s]+\\s+){0,8}[A-Za-z]',
    '^(?:ab){0,8}c', '^(?:-C\\s+\\S+\\s+)?push', '^(?:[^;]*?\\s)?run\\b', '^(?:\\S+\\s+){2,6}x'];
  const adversarial = [
    'segment/'.repeat(2048) + 'x', 'ab'.repeat(8192) + '!',
    'push ' + '-x '.repeat(8) + '1'.repeat(16384), 'ab'.repeat(8) + 'x'.repeat(16384),
    '-C ' + 'x'.repeat(16384) + ' miss', ' '.repeat(16384) + 'nope',
    'word '.repeat(6) + 'q'.repeat(16384),
  ];
  for (const [index, source] of accepted.entries()) {
    const regex = safeRegex('sample', source);
    const start = performance.now();
    regex.test(adversarial[index]);
    assert.ok(performance.now() - start < 50, `slow: ${source}`);
  }
  for (const source of ['^(?:a+|b+){0,8}$', '^(?:a+){3}$', '^(?:x?a+){0,4}$', '^(?:aa+)+$', '^(\\w+\\s?)*$', '(a+)+', '^((a+))+$', '^(?:\\u0061+)+$'])
    assert.throws(() => safeRegex('sample', source), /nested unbounded|repeated single unbounded/);
  assert.throws(() => safeRegex('sample', '^(?:\\p{L}+)+$', 'u'), /nested unbounded/);
  assert.throws(() => safeRegex('sample', '^(?:\\p{L}+a)+$', 'u'), /nested unbounded/);
});

test('an option list is accepted only in its deterministic flat form, never as a nested optional group', () => {
  // A bounded list whose iteration nests an optional unbounded group lets the group and the next iteration split one run
  // of input two ways per iteration; the engine refuses it without special cases. The flat form (an option or a value
  // per iteration) has a determined boundary and matches the same real commands.
  assert.throws(() => safeRegex('sample', '^(?:-{1,2}\\S+\\s+(?:\\S+\\s+)?){0,8}end$'), /nested unbounded/);
  const regex = safeRegex('sample', '^(?:-\\S+\\s+|[^-\\s]\\S*\\s+){0,8}end$');
  const start = performance.now();
  assert.equal(regex.test('-x '.repeat(8) + 'x'.repeat(16384)), false);
  assert.equal(regex.test('-b br --lock v end'), true);
  assert.ok(performance.now() - start < 50);
});

test('migration refuses literal backslash path segments before moving or ledgering', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-slash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rule = 'wt\\legacy/sample.md', source = join(root, '.claude/rules', rule);
  await mkdir(join(root, '.claude/rules/wt\\legacy'), { recursive: true });
  await writeFile(source, 'Body\n');
  await assert.rejects(() => migrateRule(root, rule, spec, {}), /wt\\legacy\/sample\.md/);
  assert.equal(await readFile(source, 'utf8'), 'Body\n');
  assert.equal(await readFile(join(root, '.claude/rules-on-demand/sample.md'), 'utf8').catch(() => null), null);
  assert.equal(await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'), 'utf8').catch(() => null), null);
});
