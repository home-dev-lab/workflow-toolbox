import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanEnv } from './clean-env.mjs';
import { migrateRule } from '../scripts/rule-lifecycle-lib.mjs';
import { readVerdicts } from '../scripts/verdict-record.mjs';

const onboard = resolve('scripts/onboard-project.mjs');
const rollback = resolve('scripts/rollback-check.mjs');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const ok = (run) => assert.equal(run.status, 0, run.stderr || run.stdout);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-verdict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const out = join(root, 'out');
  const config = join(root, 'config');
  const transcripts = join(root, 'transcripts');
  const rules = join(project, '.claude', 'rules');
  const record = join(project, '.claude', 'rules-on-demand-verdicts.json');
  await mkdir(join(rules, 'nested'), { recursive: true });
  await mkdir(transcripts);
  await writeFile(join(rules, 'nested', 'alpha.md'), 'Original alpha\n');
  await writeFile(join(transcripts, 'session.jsonl'), JSON.stringify({ type: 'user', message: { content: 'deploy now' } }) + '\n');
  const env = cleanEnv({ HOME: root, CLAUDE_CONFIG_DIR: config });
  const run = (command, ...extra) => spawnSync(process.execPath, [onboard, command, '--project', project, '--out', out, '--config-dir', config, ...extra], { encoding: 'utf8', env });
  const decide = async (name, decision = 'whole') => {
    const dir = join(out, 'items', name.replace(/\.md$/, '').replaceAll('/', '__'));
    await writeFile(join(dir, 'decision.json'), JSON.stringify({ decision }));
    await writeFile(join(dir, 'spec.json'), JSON.stringify({ 'on-demand': { triggers: [{ kind: 'prompt', regex: 'deploy' }] }, compliance: { kind: 'none', reason: 'fixture' } }));
    if (decision === 'split') {
      await writeFile(join(dir, 'core.md'), 'Core only\n');
      await writeFile(join(dir, 'at-act.md'), 'Act on deploy\n');
    }
  };
  return { root, project, out, config, transcripts, rules, record, env, run, decide };
}

test('propose skips unchanged static and rolled-back rules and reports each reason', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.rules, 'rolled.md'), 'Rolled\n');
  await writeFile(f.record, JSON.stringify({ version: 1, rules: {
    'nested/alpha.md': { sha256: hash('Original alpha\n'), state: 'static', reason: 'no trigger' },
    'rolled.md': { sha256: hash('Rolled\n'), state: 'rolled-back', reason: 'low rate', date: '2026-09-01T00:00:00.000Z', rate: 0.2 },
  } }));
  ok(f.run('propose'));
  const manifest = await json(join(f.out, 'propose-manifest.json'));
  assert.deepEqual(manifest.rules, []);
  assert.deepEqual(manifest.skipped.map(({ rule, state, reason }) => [rule, state, reason]), [
    ['nested/alpha.md', 'static', 'no trigger'], ['rolled.md', 'rolled-back', 'low rate'],
  ]);
  ok(f.run('prove', '--transcripts', f.transcripts));
  const report = await readFile(join(f.out, 'onboard-report.md'), 'utf8');
  assert.match(report, /skipped 2/);
  assert.match(report, /nested\/alpha\.md.*no trigger/);
  assert.match(report, /rolled\.md.*low rate/);
});

test('changed recorded text is examined again with its previous verdict', async (t) => {
  const f = await fixture(t);
  await writeFile(f.record, JSON.stringify({ version: 1, rules: {
    'nested/alpha.md': { sha256: hash('Original alpha\n'), state: 'static', reason: 'no trigger', date: '2026-09-01T00:00:00.000Z' },
  } }));
  await writeFile(join(f.rules, 'nested', 'alpha.md'), 'Changed alpha\n');
  ok(f.run('propose'));
  const manifest = await json(join(f.out, 'propose-manifest.json'));
  assert.deepEqual(manifest.rules, ['nested/alpha.md']);
  assert.deepEqual(manifest.changedSince['nested/alpha.md'], { state: 'static', date: '2026-09-01T00:00:00.000Z' });
});

test('confirmed apply records split core and whole source; prove records static but omits no proposal', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.rules, 'whole.md'), 'Whole\n');
  await writeFile(join(f.rules, 'static.md'), 'Static\n');
  await writeFile(join(f.rules, 'unexamined.md'), 'Unexamined\n');
  ok(f.run('propose'));
  await f.decide('nested/alpha.md', 'split');
  await f.decide('whole.md');
  await writeFile(join(f.out, 'items', 'static', 'decision.json'), JSON.stringify({ decision: 'static', reason: 'cannot trigger deterministically' }));
  assert.equal(f.run('prove', '--transcripts', f.transcripts).status, 1);
  assert.deepEqual(Object.keys((await json(f.record)).rules), ['static.md']);
  ok(f.run('apply'));
  assert.deepEqual(Object.keys((await json(f.record)).rules), ['static.md']);
  ok(f.run('apply', '--confirm'));
  const { rules, version } = await json(f.record);
  assert.equal(version, 1);
  assert.deepEqual(Object.keys(rules).sort(), ['nested/alpha.md', 'static.md', 'whole.md']);
  assert.deepEqual([rules['nested/alpha.md'].sha256, rules['nested/alpha.md'].subject, rules['nested/alpha.md'].state], [hash('Core only\n'), 'nested/alpha-at-act.md', 'migrated']);
  assert.deepEqual([rules['whole.md'].sha256, rules['whole.md'].subject, rules['whole.md'].state], [hash('Whole\n'), 'whole.md', 'migrated']);
  assert.equal(rules['static.md'].reason, 'cannot trigger deterministically');
  assert.equal(rules['static.md'].state, 'static');
  assert.match(rules['static.md'].date, /^\d{4}-\d\d-\d\dT/);
  assert.match(rules['whole.md'].date, /^\d{4}-\d\d-\d\dT/);
  assert.match(rules['nested/alpha.md'].date, /^\d{4}-\d\d-\d\dT/);
  ok(f.run('propose'));
  assert.deepEqual((await json(join(f.out, 'propose-manifest.json'))).rules, ['unexamined.md']);
});

test('failed apply leaves an existing record byte-identical', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.rules, 'static.md'), 'Static\n');
  await writeFile(join(f.rules, 'zeta.md'), 'Zeta\n');
  ok(f.run('propose'));
  await writeFile(join(f.out, 'items', 'static', 'decision.json'), JSON.stringify({ decision: 'static', reason: 'always relevant' }));
  assert.equal(f.run('prove', '--transcripts', f.transcripts).status, 1);
  ok(f.run('apply', '--confirm'));
  assert.equal((await json(f.record)).rules['static.md'].reason, 'always relevant');
  ok(f.run('propose'));
  await f.decide('nested/alpha.md', 'split');
  await f.decide('zeta.md');
  ok(f.run('prove', '--transcripts', f.transcripts));
  const before = await readFile(f.record, 'utf8');
  await writeFile(join(f.rules, 'zeta.md'), 'Changed after proof\n');
  assert.equal(f.run('apply', '--confirm').status, 1);
  assert.deepEqual((await json(join(f.out, 'applied.json'))).map(({ rule }) => rule), ['nested/alpha.md']);
  assert.equal(await readFile(f.record, 'utf8'), before);
});

test('onboard revert removes only its migrated entries, retaining static and rolled-back knowledge', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.rules, 'static.md'), 'Static\n');
  ok(f.run('propose'));
  await f.decide('nested/alpha.md', 'split');
  await writeFile(join(f.out, 'items', 'static', 'decision.json'), JSON.stringify({ decision: 'static', reason: 'always relevant' }));
  assert.equal(f.run('prove', '--transcripts', f.transcripts).status, 1);
  ok(f.run('apply', '--confirm'));
  const record = await json(f.record);
  record.rules['other.md'] = { sha256: hash('Other\n'), state: 'rolled-back', reason: 'rate', date: '2026-09-01T00:00:00.000Z', rate: 0.1 };
  await writeFile(f.record, JSON.stringify(record));
  ok(f.run('revert'));
  const after = (await json(f.record)).rules;
  assert.deepEqual(Object.keys(after).sort(), ['other.md', 'static.md']);
  assert.deepEqual(after['static.md'], record.rules['static.md']);
  assert.deepEqual(after['other.md'], record.rules['other.md']);
});

test('malformed verdict file fails closed on propose and apply without overwriting it', async (t) => {
  const f = await fixture(t);
  await writeFile(f.record, '{malformed');
  const result = f.run('propose');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rules-on-demand-verdicts\.json/);
  assert.equal(await readFile(f.record, 'utf8'), '{malformed');
  assert.equal(f.run('apply', '--confirm').status, 1);
  assert.equal(await readFile(f.record, 'utf8'), '{malformed');
  const invalidDate = JSON.stringify({ version: 1, rules: { 'nested/alpha.md': {
    sha256: hash('Original alpha\n'), state: 'static', reason: 'old', date: '09/27/2026',
  } } });
  await writeFile(f.record, invalidDate);
  assert.equal(f.run('propose').status, 1);
  assert.equal(await readFile(f.record, 'utf8'), invalidDate);
});

test('project daily rollback records reverted nested source and rate, dry run does not, and reports pending rules', async (t) => {
  const f = await fixture(t);
  const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } };
  await migrateRule(f.project, 'nested/alpha.md', spec, {});
  await writeFile(join(f.rules, 'new.md'), 'New\n');
  await writeFile(f.record, JSON.stringify({ version: 1, rules: { 'changed.md': { sha256: hash('Before\n'), state: 'static', reason: 'old' } } }));
  await writeFile(join(f.rules, 'changed.md'), 'After\n');
  const store = join(f.root, 'store.json');
  await writeFile(store, '{"sessions":{}}');
  const verdicts = join(f.root, 'scan.jsonl');
  // Owner decision #4731: a revert needs the on-demand follow rate to be below the static one, so the fixture carries a
  // followed static baseline (before migration) beside the unfollowed on-demand rows (after). Rows use the
  // transcript-scan shape: `at` dates the act, `phase` places it against the migration, and a static-baseline row
  // carries its verdict in `checkVerdict`. The same fixture reverts under both the current and the #4731 contract.
  const rulesDir = join(f.project, '.claude', 'rules-on-demand');
  const before = new Date(Date.now() - 3600000).toISOString();
  const after = new Date(Date.now() + 1000).toISOString();
  await writeFile(verdicts, [
    ...Array.from({ length: 5 }, (_, i) => ({ rule: 'alpha.md', scope: 'project', rulesDir, verdict: 'static baseline', checkVerdict: 'followed', phase: 'before', at: before, file: 'fixture', line: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => ({ rule: 'alpha.md', scope: 'project', rulesDir, verdict: 'not followed', phase: 'after', at: after, decidedAt: after, window: '7d', file: 'fixture', line: i + 6 })),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const run = (...args) => spawnSync(process.execPath, [rollback, '--project', f.project, '--store', store, '--verdicts', verdicts, ...args], { encoding: 'utf8', env: f.env });
  const dry = run('--dry-run', '--json');
  ok(dry);
  assert.ok(Array.isArray(JSON.parse(dry.stdout)), 'dry-run JSON must remain the results array');
  assert.match(dry.stderr, /rollback-check: pending new\.md: new/);
  assert.equal((await json(f.record)).rules['nested/alpha.md'], undefined);
  const result = run('--json');
  ok(result);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report), 'JSON must remain the results array');
  assert.equal(report[0].action, 'reverted');
  assert.match(result.stderr, /rollback-check: pending changed\.md: changed since static/);
  assert.match(result.stderr, /rollback-check: pending new\.md: new/);
  const saved = (await json(f.record)).rules['nested/alpha.md'];
  assert.equal(saved.state, 'rolled-back');
  assert.equal(saved.sha256, hash('Original alpha\n'));
  assert.equal(saved.followed, 0);
  assert.equal(saved.applicable, 5);
  assert.equal(saved.rate, 0);
  assert.match(saved.date, /^\d{4}-\d\d-\d\dT/);
  const plain = run();
  ok(plain);
  assert.match(plain.stderr, /rollback-check: pending changed\.md/);
  assert.match(plain.stderr, /rollback-check: pending new\.md/);
});

test('prove records unfit rows without apply and skips unchanged text on the next propose', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.rules, 'front.md'), '---\nkind: old\n---\n');
  await writeFile(join(f.rules, 'invalid.md'), 'Invalid\n');
  await writeFile(join(f.rules, 'unproven.md'), 'No matching trigger\n');
  await writeFile(join(f.rules, 'missing.md'), 'No proposal\n');
  ok(f.run('propose'));
  await writeFile(join(f.out, 'items', 'nested__alpha', 'decision.json'), JSON.stringify({ decision: 'static', reason: 'unfit' }));
  await f.decide('unproven.md');
  await writeFile(join(f.out, 'items', 'unproven', 'spec.json'), JSON.stringify({ 'on-demand': { triggers: [{ kind: 'prompt', regex: 'never-seen' }] }, compliance: { kind: 'none', reason: 'fixture' } }));
  await f.decide('invalid.md');
  await writeFile(join(f.out, 'items', 'invalid', 'spec.json'), '{}');
  assert.equal(f.run('prove', '--transcripts', f.transcripts).status, 1);
  const rules = (await json(f.record)).rules;
  // Only a DECLARED unfitness is recorded: the author's static decision and a source with frontmatter.
  // An unproven trigger or an invalid spec is a failed attempt (wrong transcripts dir, authoring error),
  // not a verdict on the rule: recording it would silence the rule for good on a transient cause.
  assert.deepEqual(Object.keys(rules).sort(), ['front.md', 'nested/alpha.md']);
  assert.equal(rules['nested/alpha.md'].reason, 'unfit');
  assert.equal(rules['front.md'].reason, 'source has frontmatter');
  for (const entry of Object.values(rules)) assert.match(entry.date, /^\d{4}-\d\d-\d\dT/);
  ok(f.run('propose'));
  assert.deepEqual([...(await json(join(f.out, 'propose-manifest.json'))).rules].sort(), ['invalid.md', 'missing.md', 'unproven.md']);
});

test('prove skips a static verdict when the source changed since propose and says so', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  await writeFile(join(f.out, 'items', 'nested__alpha', 'decision.json'), JSON.stringify({ decision: 'static', reason: 'unfit' }));
  await writeFile(join(f.rules, 'nested', 'alpha.md'), 'Edited after propose\n');
  const result = f.run('prove', '--transcripts', f.transcripts);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /skipped static verdict nested\/alpha\.md: source changed since propose/);
  assert.equal((await json(f.record).catch(() => ({ rules: {} }))).rules['nested/alpha.md'], undefined);
});

test('per-part mechanise verdict is reported and recorded without creating a hook or plugin', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  const parts = [{ part: 'static-core', what: 'Always visible' }, { part: 'on-demand', what: 'Deploy gate' },
    { part: 'mechanise', what: 'Enforce deploy gate', how: 'hook' }];
  await f.decide('nested/alpha.md', 'split');
  await writeFile(join(f.out, 'items', 'nested__alpha', 'decision.json'), JSON.stringify({ decision: 'split', parts }));
  ok(f.run('prove', '--transcripts', f.transcripts));
  assert.deepEqual((await json(join(f.out, 'onboard-report.json'))).rows[0].parts, parts);
  assert.match(await readFile(join(f.out, 'onboard-report.md'), 'utf8'), /mechanise.*Enforce deploy gate.*hook/);
  assert.equal(await readFile(f.record).catch(() => null), null);
  ok(f.run('apply', '--confirm'));
  assert.deepEqual((await json(f.record)).rules['nested/alpha.md'].parts, parts);
  assert.deepEqual((await json(join(f.out, 'applied.json'))).map(({ rule }) => rule), ['nested/alpha.md']);
  assert.equal(await readFile(join(f.project, '.claude', 'hooks', 'deploy-gate.mjs')).catch(() => null), null);
});

test('static mechanise parts are recorded at prove without changing other project files', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  const parts = [{ part: 'mechanise', what: 'Validate every deployment', how: 'function-plugin' }];
  await writeFile(join(f.out, 'items', 'nested__alpha', 'decision.json'), JSON.stringify({ decision: 'static', reason: 'needs code', parts }));
  const before = await readFile(join(f.rules, 'nested', 'alpha.md'));
  assert.equal(f.run('prove', '--transcripts', f.transcripts).status, 1);
  assert.deepEqual((await json(f.record)).rules['nested/alpha.md'].parts, parts);
  assert.deepEqual(await readFile(join(f.rules, 'nested', 'alpha.md')), before);
  assert.deepEqual((await readdir(join(f.project, '.claude'))).sort(), ['rules', 'rules-on-demand-verdicts.json']);
});

test('invalid decision parts become a named static reason and invalid stored parts fail closed', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  await writeFile(join(f.out, 'items', 'nested__alpha', 'decision.json'), JSON.stringify({ decision: 'whole', parts: [{ part: 'mechanise', what: 'Enforce' }] }));
  assert.equal(f.run('prove', '--transcripts', f.transcripts).status, 1);
  const row = (await json(join(f.out, 'onboard-report.json'))).rows.find((candidate) => candidate.rule === 'nested/alpha.md');
  assert.match(row.reason, /^invalid parts: .*how/);
  // An authoring error is not a declared verdict: it is re-examined next run, so nothing is recorded.
  assert.equal((await json(f.record).catch(() => ({ rules: {} }))).rules['nested/alpha.md'], undefined);
  const entry = { sha256: hash('Original alpha\n'), state: 'static', reason: 'unfit', date: '2026-09-27T00:00:00.000Z' };
  const broken = JSON.stringify({ version: 1, rules: { 'nested/alpha.md': { ...entry, parts: [{ part: 'mechanise', what: 'Enforce' }] } } });
  await writeFile(f.record, broken);
  await assert.rejects(readVerdicts(f.project), /invalid rule nested\/alpha\.md.*parts/);
  assert.equal(await readFile(f.record, 'utf8'), broken);
});

test('trigger-miss rollback with no applicable verdicts retains a readable null rate', async (t) => {
  const f = await fixture(t);
  const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } };
  await migrateRule(f.project, 'nested/alpha.md', spec, {});
  await writeFile(f.record, JSON.stringify({ version: 1, rules: {} }));
  const store = join(f.root, 'store.json');
  await writeFile(store, '{"sessions":{}}');
  const verdicts = join(f.root, 'scan.jsonl');
  await writeFile(verdicts, JSON.stringify({ rule: 'alpha.md', scope: 'project', rulesDir: join(f.project, '.claude', 'rules-on-demand'),
    verdict: 'trigger miss', triggerMatched: true, file: 'session.jsonl', line: 1 }) + '\n');
  ok(spawnSync(process.execPath, [rollback, '--project', f.project, '--store', store, '--verdicts', verdicts, '--json'], { encoding: 'utf8', env: f.env }));
  assert.equal((await json(f.record)).rules['nested/alpha.md'].rate, null);
  assert.equal((await readVerdicts(f.project)).rules['nested/alpha.md'].state, 'rolled-back');
});

test('propose refuses colliding item directories before writing a manifest or either item', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.rules, 'a'), { recursive: true });
  await writeFile(join(f.rules, 'a', 'b.md'), 'Nested\n');
  await writeFile(join(f.rules, 'a__b.md'), 'Flat\n');
  const result = f.run('propose');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /a\/b\.md/);
  assert.match(result.stderr, /a__b\.md/);
  assert.equal(await readFile(join(f.out, 'propose-manifest.json')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
  assert.equal(await readFile(join(f.out, 'items', 'a__b', 'item.json')).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
});

test('repeated apply does not replace a rolled-back verdict with a historical migration', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  await f.decide('nested/alpha.md');
  ok(f.run('prove', '--transcripts', f.transcripts));
  ok(f.run('apply', '--confirm'));
  const record = await json(f.record);
  record.rules['nested/alpha.md'] = { sha256: hash('Original alpha\n'), state: 'rolled-back', reason: 'low rate', date: '2026-09-01T00:00:00.000Z', rate: 0.2 };
  const before = JSON.stringify(record, null, 2) + '\n';
  await writeFile(f.record, before);
  ok(f.run('apply', '--confirm'));
  assert.equal(await readFile(f.record, 'utf8'), before);
});

test('apply report failure leaves verdict record byte-identical', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  await f.decide('nested/alpha.md');
  ok(f.run('prove', '--transcripts', f.transcripts));
  const before = JSON.stringify({ version: 1, rules: {} }) + '\n';
  await writeFile(f.record, before);
  await rm(join(f.out, 'propose-manifest.json'));
  const result = f.run('apply', '--confirm');
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(f.record, 'utf8'), before);
});

test('revert of one out directory preserves another out directory migration', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  await f.decide('nested/alpha.md');
  ok(f.run('prove', '--transcripts', f.transcripts));
  ok(f.run('apply', '--confirm'));
  const engine = resolve('scripts/rules.mjs');
  ok(spawnSync(process.execPath, [engine, 'revert', 'nested/alpha.md', '--project', f.project], { encoding: 'utf8', env: f.env }));
  // The first out directory still has applied.json, while a fresh onboarding run can
  // migrate the restored source from a second out directory.
  await rm(f.record);
  const other = join(f.root, 'other-out');
  const runOther = (command, ...extra) => spawnSync(process.execPath, [onboard, command, '--project', f.project, '--out', other, '--config-dir', f.config, ...extra], { encoding: 'utf8', env: f.env });
  ok(runOther('propose'));
  await writeFile(join(other, 'items', 'nested__alpha', 'decision.json'), JSON.stringify({ decision: 'whole' }));
  await writeFile(join(other, 'items', 'nested__alpha', 'spec.json'), JSON.stringify({ 'on-demand': { triggers: [{ kind: 'prompt', regex: 'deploy' }] }, compliance: { kind: 'none', reason: 'fixture' } }));
  ok(runOther('prove', '--transcripts', f.transcripts));
  ok(runOther('apply', '--confirm'));
  assert.equal((await json(f.record)).rules['nested/alpha.md'].out, other);
  ok(f.run('revert'));
  assert.equal((await json(f.record)).rules['nested/alpha.md'].out, other);
});

test('array-valued sha256 is rejected without modifying the verdict file', async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify({ version: 1, rules: { 'nested/alpha.md': { sha256: [hash('Original alpha\n')], state: 'static', reason: 'unfit' } } });
  await writeFile(f.record, before);
  await assert.rejects(readVerdicts(f.project), /invalid rule nested\/alpha\.md/);
  assert.equal(await readFile(f.record, 'utf8'), before);
});

test('prove validates malformed verdicts even with no declared statics', async (t) => {
  const f = await fixture(t);
  ok(f.run('propose'));
  const before = '{malformed';
  await writeFile(f.record, before);
  const result = f.run('prove', '--transcripts', f.transcripts);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rules-on-demand-verdicts\.json/);
  assert.equal(await readFile(f.record, 'utf8'), before);
});
