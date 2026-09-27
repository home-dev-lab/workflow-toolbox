import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize, resolveContext, judge, scanTranscripts } from '../scripts/transcript-verdicts.mjs';
import { correlateTurn } from '../hooks/declarative-checks.js';
import { safeRegex } from '../hooks/evidence.js';
import { dailyRollback } from '../scripts/daily-rollback.mjs';
import { migrateRule, revertRule } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const scripts = (name) => fileURLToPath(new URL(`../scripts/${name}.mjs`, import.meta.url));
const spec = { 'on-demand': { triggers: [{ kind: 'bash', regex: '^runner run', 'command-head': true }] }, compliance: { kind: 'bash-command', 'act-regex': '^runner run', 'require-regex': 'safe', window: 1, 'on-close': 'not applicable' } };
async function sandbox(t) { const root = await mkdtemp(join(tmpdir(), 'rod-refute-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const ruleText = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: true\n  compliance:\n    kind: 'tool-input'\n    tool: '^Agent$'\n    require-input-regex: 'approved'\n    window: 1\n    on-close: not applicable\n---\nbody\n`;
const refusal = 'wt-rules-on-demand: read the rule below before this action';
function judged(resultText, delivered = true) {
  const now = Date.now(), at = new Date(now - 1000).toISOString();
  const rule = { name: 'sample.md', triggers: [], compliance: { kind: 'tool-input', tool: /^Agent$/, required: [/approved/], any: [], forbidden: null }, migrated: at, cutoff: now - 2000, lastChange: 0 };
  const scope = { scope: 'user', rulesDir: '/rules', rules: [rule] };
  const events = [normalize({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { prompt: 'approved' } }] } }, 1)[0],
    ...normalize({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: resultText }] } }, 3)];
  if (delivered) events.splice(1, 0, { kind: 'delivery', name: 'sample.md', line: 2, provenance: { toolUseId: 'call' } });
  const context = { cwd: '/project', start: now - 1000, events };
  const resolved = resolveContext(context, [scope]);
  const stats = { days: 7, coverage: { missingTimestamps: 0 }, skippedOutsideWindow: 0 };
  return { resolved, rows: judge(context, resolved, 'transcript', stats, new Set(), now) };
}
test('ordinary successful tool result retains the compliance verdict', () => assert.equal(judged('Done').rows.length, 1));
test('rule markup in a Read result is data; only genuine refusals prove delivery', () => {
  assert.equal(judged('<rule name="sample.md">body</rule>', false).resolved.runtimeProofs.length, 0);
  assert.equal(judged('<rule name="sample.md">body</rule>', false).resolved.deliveries.length, 0);
  assert.equal(judged(`${refusal}\n<rule name="sample.md">body</rule>`, false).resolved.runtimeProofs.length, 1);
});
test('follow-up-tool alone tolerates unrelated successful Bash calls', () => {
  const c = { tool: /^Agent$/, id: /(id)/, value: /(value)/, followUpTool: /^SendMessage$/, act: null, minDistinct: 1 };
  const events = [{ kind: 'use', id: 'a', name: 'Agent', input: {} }, { kind: 'result', id: 'a', text: 'id' }, { kind: 'use', id: 'b', name: 'Bash', input: { command: 'pwd' } }, { kind: 'result', id: 'b', text: 'ok' }, { kind: 'turn' }];
  assert.equal(correlateTurn(c, events)[0].verdict, 'not followed');
});
test('one broken correlation rule does not abort transcript evaluation of another', () => {
  const now = Date.now(), at = new Date(now - 1000).toISOString();
  const good = { name: 'good.md', triggers: [], migrated: at, cutoff: now - 2000, lastChange: 0, compliance: { kind: 'tool-input', tool: /^Agent$/, required: [/approved/], any: [] } };
  const broken = { name: 'broken.md', triggers: [], compliance: { kind: 'turn-correlation', tool: null } };
  const context = { cwd: '/project', start: now - 1000, events: [
    { kind: 'use', line: 1, id: 'a', name: 'Agent', input: { prompt: 'approved' }, at }, { kind: 'result', line: 2, id: 'a', text: 'Done' }, { kind: 'turn' }] };
  const scope = { scope: 'user', rulesDir: '/rules', rules: [broken, good] };
  const stats = { days: 7, coverage: { missingTimestamps: 0 }, skippedOutsideWindow: 0 };
  assert.equal(judge(context, resolveContext(context, [scope]), 'file', stats, new Set(), now).length, 1);
});
test('nested unbounded alternatives and optional atoms are refused', () => {
  for (const source of ['^(?:a+|b+)+$', '^(?:a+z?)+$']) assert.throws(() => safeRegex('sample', source), /nested unbounded/);
});
test('prove respects command-head and shares migration rendered-size preflight', async (t) => {
  const root = await sandbox(t), rules = join(root, '.claude/rules'), transcripts = join(root, 'transcripts');
  await mkdir(rules, { recursive: true }); await mkdir(transcripts);
  const source = join(rules, 'sample.md'), specFile = join(root, 'spec.json');
  await writeFile(source, 'Body\n'); await writeFile(specFile, JSON.stringify(spec));
  await writeFile(join(transcripts, 'session.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'timeout 30 runner run safe' } }] } }) + '\n');
  const run = () => spawnSync(process.execPath, [scripts('rules'), 'prove-triggers', 'sample.md', '--project', root, '--spec', specFile, '--transcripts', transcripts], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(JSON.parse(run().stdout).matches, 1);
  await writeFile(source, 'x'.repeat(262144));
  const large = run(); assert.notEqual(large.status, 0); assert.match(large.stderr, /exceeds|too large/);
});
test('check-rules audits prompt triggers and interrupts pathological matches', async (t) => {
  const root = await sandbox(t), corpus = join(root, 'corpus.json');
  await writeFile(join(root, 'slow.md'), `---\non-demand:\n  triggers:\n    - kind: prompt\n      regex: '^(a|aa){30}$'\n  compliance:\n    kind: none\n    reason: fixture\n---\nbody`);
  await writeFile(join(root, 'fast.md'), ruleText);
  await writeFile(corpus, JSON.stringify(['a'.repeat(60) + '!']));
  const result = spawnSync(process.execPath, [scripts('rules'), 'check-rules', '--dir', root, '--corpus', corpus, '--time-bound-ms', '20'], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /slow slow\.md trigger-0-regex/);
  assert.ok(result.stdout.split('\n').some((line) => line.startsWith('ok\t') && line.endsWith('fast.md')));
});
test('corrupt followed projects reports error but user quality still runs', async (t) => {
  const root = await sandbox(t); await mkdir(join(root, 'rules-on-demand'));
  await writeFile(join(root, 'rules-on-demand/followed-projects.json'), '{bad');
  let called = 0;
  const { result } = await dailyRollback({ configDirs: [root], projectsDirs: [], project: root, dataDir: join(root, 'quality'), checkQuality: async () => { called++; return { complete: true, scan: { badLines: 0, linesRead: 1 }, coverage: { missingTimestamps: 0 }, scopes: [] }; } });
  assert.equal(called, 1); assert.match(JSON.stringify(result.attention), /followed-projects/);
});
test('followed project roots are seeded into daily quality scan', async (t) => {
  const root = await sandbox(t), followed = join(root, 'followed');
  await mkdir(join(root, 'rules-on-demand')); await mkdir(join(followed, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(root, 'rules-on-demand/followed-projects.json'), JSON.stringify([{ root: followed, addedAt: '2026-01-01', by: 'test' }]));
  let seen;
  await dailyRollback({ configDirs: [root], projectsDirs: [], project: root, dataDir: join(root, 'quality'), checkQuality: async (options) => { seen = options.followedRoots; return { complete: false, scan: { filesFailed: 1 }, coverage: {}, scopes: [] }; } });
  assert.deepEqual(seen, [followed]);
});
test('a followed scope without transcript evidence is reported by name', async (t) => {
  const root = await sandbox(t), followed = join(root, 'followed'), rulesDir = join(followed, '.claude/rules-on-demand'), projects = join(root, 'projects');
  await mkdir(rulesDir, { recursive: true }); await mkdir(projects);
  await writeFile(join(rulesDir, 'sample.md'), ruleText);
  const result = await scanTranscripts({ projectsDirs: [projects], scopes: [{ scope: 'project', projectRoot: followed, rulesDir }],
    migrationDateOf: async () => '2026-01-01T00:00:00Z', lastChangeOf: async () => '2026-01-01T00:00:00Z' });
  assert.deepEqual(result.coverage.missingScopeEvidence, [`project ${followed}: no transcript evidence`]);
  assert.equal(result.complete, false);
});
test('rollback cutoff compares instants and refuses unknown migration', async (t) => {
  const root = await sandbox(t); await mkdir(join(root, '.claude/rules'), { recursive: true });
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body');
  await migrateRule(root, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'tool-input', tool: '^Agent$', 'require-input-regex': 'yes', window: 1, 'on-close': 'not applicable' } }, {});
  const ledger = join(root, '.claude/rules-on-demand-ledger.jsonl');
  const entry = JSON.parse((await readFile(ledger, 'utf8')).trim());
  await writeFile(ledger, JSON.stringify({ ...entry, time: '2026-09-26T10:00:00Z' }) + '\n');
  const store = join(root, 'store.json'), verdicts = join(root, 'verdicts.jsonl'); await writeFile(store, '{}');
  const rows = Array.from({ length: 5 }, () => JSON.stringify({ rule: 'sample.md', scope: 'project', rulesDir: join(root, '.claude/rules-on-demand'), at: '2026-09-26T11:00:00+02:00', verdict: 'trigger miss', triggerMatched: false }));
  await writeFile(verdicts, rows.join('\n') + '\n');
  const run = () => JSON.parse(spawnSync(process.execPath, [scripts('rollback-check'), '--project', root, '--store', store, '--verdicts', verdicts, '--mechanical-only', '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() }).stdout)[0];
  assert.equal(run().action, 'none');
  await writeFile(ledger, ''); assert.equal(run().action, 'attention');
});
test('failed notification falls back durably and retries on the next daily run', async (t) => {
  const root = await sandbox(t), dataDir = join(root, 'quality'), output = join(root, 'received.json');
  const options = { configDirs: [root], projectsDirs: [], project: root, dataDir,
    notifyCommand: ['nonexistent-rod-notifier'],
    checkQuality: async () => ({ complete: true, scan: { badLines: 0, linesRead: 1 }, coverage: { missingTimestamps: 0 }, scopes: [] }),
    afterQualityCheck: async () => writeFile(join(dataDir, 'rollback-journal.jsonl'), JSON.stringify({ action: 'reverted', at: new Date().toISOString(), scope: 'user', rule: 'sample.md', reason: 'test' }) + '\n') };
  const first = await dailyRollback(options);
  assert.equal(first.result.notificationsFailed.length, 1);
  assert.match(await readFile(join(dataDir, 'revert-notifications.jsonl'), 'utf8'), /sample\.md/);
  options.afterQualityCheck = undefined;
  options.notifyCommand = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],require("node:fs").readFileSync(0))', output];
  const second = await dailyRollback(options);
  assert.equal(second.result.notificationsFailed.length, 0);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).rule, 'sample.md');
});
test('pending journal survives crash after revert and is reconciled from lifecycle ledger', async (t) => {
  const root = await sandbox(t), dataDir = join(root, 'quality');
  await mkdir(join(root, '.claude/rules'), { recursive: true }); await mkdir(dataDir);
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body');
  await migrateRule(root, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } }, {});
  const at = new Date(Date.now() - 1000).toISOString();
  await writeFile(join(dataDir, 'rollback-journal.jsonl'), JSON.stringify({ action: 'reverted', state: 'pending', at, scope: 'project', root, rule: 'sample.md', reason: 'test' }) + '\n');
  await revertRule(root, 'sample.md', 'test');
  const { result } = await dailyRollback({ configDirs: [root], projectsDirs: [], project: root, dataDir,
    checkQuality: async () => ({ complete: false, scan: { filesFailed: 1 }, coverage: {}, scopes: [] }) });
  assert.equal(result.notificationsFailed.length, 0);
  assert.match(await readFile(join(dataDir, 'revert-notifications.jsonl'), 'utf8'), /sample\.md/);
});
test('a bounded repeat of a group holding an unbounded atom is refused, an anchored or single optional one is not', () => {
  // (?:a+|b+){0,8} took ~2 s on 40 characters: a bounded outer count still multiplies the inner partitions.
  for (const source of ['^(?:a+|b+){0,8}$', '^(?:a+){3}$', '^(?:x?a+){0,4}$']) assert.throws(() => safeRegex('sample', source), /nested unbounded/);
  for (const source of ['^(?:[^;]*?\\s)?run\\b', '^(?:ab){0,8}c', '^(?:-C\\s+\\S+\\s+)?push', 'push\\s+(?:-[^\\s]+\\s+){0,8}[A-Za-z]', '^(?:\\S+\\s+){2,6}x']) assert.doesNotThrow(() => safeRegex('sample', source));
});

test('the TRIGGERS.md example rule parses through the runtime parser with its documented flags', async () => {
  const { parseRuntimeRule } = await import('../hooks/runtime-rule.js');
  const doc = await readFile(fileURLToPath(new URL('../TRIGGERS.md', import.meta.url)), 'utf8');
  const example = /```yaml\n(---\n[\s\S]*?\n---)\n/.exec(doc);
  assert.ok(example, 'TRIGGERS.md carries a yaml frontmatter example');
  const rule = parseRuntimeRule('triggers-example', `${example[1]}\nbody\n`);
  const bash = rule.triggers.find((trigger) => trigger.kind === 'bash');
  assert.equal(bash.beforeFirstAct, true);
  assert.equal(bash.onMention, false);
});
