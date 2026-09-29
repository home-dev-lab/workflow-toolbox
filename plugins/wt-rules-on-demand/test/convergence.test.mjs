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

const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'tool-input', tool: '^Agent$', 'require-input-regex': 'yes', window: 1, 'on-close': 'not applicable' } };
const scenarios = [
  { label: 'miss without static baseline', after: [], before: [], action: 'attention' },
  { label: 'miss with improved follow rate', after: Array(5).fill('followed'), before: ['followed', 'followed', 'not followed', 'not followed', 'not followed'], action: 'attention' },
  { label: 'miss with independently worse follow rate', after: ['followed', ...Array(4).fill('not followed')], before: Array(5).fill('followed'), action: 'would revert' },
  { label: 'one-miss gap within noise', after: [...Array(4).fill('followed'), 'not followed'], before: Array(5).fill('followed'), action: 'none', miss: false },
];

for (const { label, after, before, action, miss = true } of scenarios) test(`comparative rollback: ${label}`, async (t) => {
  const input = { triggerMissMatched: Number(miss), followed: after.filter((v) => v === 'followed').length, applicable: after.length,
    beforeFollowed: before.filter((v) => v === 'followed').length, beforeApplicable: before.length };
  const decision = rollbackDecision(input);
  assert.equal(decision.attention, action === 'attention');
  if (miss) { assert.match(decision.reason, /trigger miss/); assert.match(decision.recommendation, /engine defect/); }
  else { assert.equal(decision.attention, false); assert.match(decision.reason, /not significant/); }
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
     ...after.map((v, i) => dated(v, 'after', i)), ...(miss ? [{ ...dated('trigger miss', 'after', 30), triggerMatched: true }] : [])];
  await writeFile(verdicts, rows.map((v) => JSON.stringify(v)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [rollback, '--project', root, '--store', store, '--verdicts', verdicts, '--mechanical-only', '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout)[0];
  assert.equal(result.action, action);
  if (miss) assert.match(result.reason, /trigger miss/);
  else { assert.match(result.reason, /not significant/); assert.ok(result.pValue > 0.05); }
  if (action === 'would revert') assert.match(result.reason, /below static/);
  assert.equal(result.triggerMissEvidence.length, Number(miss));
  if (!miss) {
    const config = join(root, 'config');
    await mkdir(join(config, 'rules-on-demand'), { recursive: true });
    await writeFile(join(config, 'rules-on-demand/followed-projects.json'), JSON.stringify([{ root, addedAt: '2026-01-01T00:00:00Z', by: 'test' }]));
    const daily = await dailyRollback({ configDirs: [config], projectsDirs: [], project: root, dataDir: join(root, 'quality'), apply: true,
      checkQuality: async () => ({ complete: true, verdictPath: verdicts, scan: { filesFailed: 0, badLines: 0, linesRead: rows.length },
        coverage: { missingTimestamps: 0 }, scopes: [{ scope: 'project', projectRoot: root, rulesDir }] }) });
    assert.equal(daily.code, 0, daily.result.error);
    assert.deepEqual(daily.result.reverted, []);
    assert.equal(daily.result.withinNoise.length, 1);
    assert.match(daily.result.withinNoise[0].reason, /not significant/);
    assert.ok(daily.result.withinNoise[0].pValue > 0.05);
    assert.match(await readFile(join(rulesDir, 'sample.md'), 'utf8'), /Body/);
  }
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

test('regex boundary disjointness and formerly ambiguous repetitions match native', () => {
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
    // Steps are the primary linearity check; CPU only catches pathological host stalls.
    // Worst CI median: 63 CPU ms for ^(?:ab+)+$ on windows-latest (cross-OS run 36454983764, 2026-09-28);
    // 320 ms is ~5x that figure, only a backstop under loaded CI.
    const timings = Array.from({ length: 3 }, () => {
      const start = process.cpuUsage();
      regex.test(adversarial[index]);
      assert.ok(regex.steps <= 64 * adversarial[index].length * source.length,
        `${source}: ${regex.steps} steps exceed linear bound`);
      const usage = process.cpuUsage(start);
      return (usage.user + usage.system) / 1000;
    }).sort((a, b) => a - b);
    assert.ok(timings[1] < 320, `slow: ${source} (median ${timings[1].toFixed(3)} CPU ms)`);
  }
  for (const [source, flags] of ['^(?:a+|b+){0,8}$', '^(?:a+){3}$', '^(?:x?a+){0,4}$', '^(?:aa+)+$', '^(\\w+\\s?)*$', '(a+)+', '^((a+))+$', '^(?:\\u0061+)+$', '^(?:\\p{L}+)+$', '^(?:\\p{L}+a)+$'].map((source) => [source, source.includes('\\p') ? 'u' : ''])) {
    const linear = safeRegex('sample', source, flags), native = new RegExp(source, flags);
    for (const subject of ['', 'a', 'ab', 'aab', 'baba', 'abc!']) assert.equal(linear.test(subject), native.test(subject), `${source}: ${subject}`);
  }
});

test('nested optional option list and flat form both match native', () => {
  // A bounded list whose iteration nests an optional unbounded group lets the group and the next iteration split one run
  // of input two ways per iteration; the engine refuses it without special cases. The flat form (an option or a value
  // per iteration) has a determined boundary and matches the same real commands.
  const nestedSource = '^(?:-{1,2}\\S+\\s+(?:\\S+\\s+)?){0,8}end$';
  for (const subject of ['-b br --lock v end', '-x end', 'end', 'x']) assert.equal(safeRegex('sample', nestedSource).test(subject), new RegExp(nestedSource).test(subject));
  const regex = safeRegex('sample', '^(?:-\\S+\\s+|[^-\\s]\\S*\\s+){0,8}end$');
  assert.equal(regex.test('-x '.repeat(8) + 'x'.repeat(16384)), false);
  assert.ok(regex.steps <= 64 * (16384 + 24) * regex.source.length, `${regex.steps} negative steps`);
  assert.equal(regex.test('-b br --lock v end'), true);
  assert.ok(regex.steps <= 64 * '-b br --lock v end'.length * regex.source.length, `${regex.steps} positive steps`);
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
