import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { measureDependencies, measureRules, ruleId } from '../scripts/quality-measures.mjs';
import { scanTranscripts } from '../scripts/transcript-verdicts.mjs';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { migrateRule, triggersHash } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const time = Date.parse('2026-09-20T12:00:00Z');
const at = (n) => new Date(time + n * 1000).toISOString();
const text = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n  compliance:\n    kind: 'check'\n    check: 'gate-background'\n---\nFollow.\n`;
const base = { name: 'a.md', scope: 'project', rulesDir: '/fixture/rules', text, complianceKind: 'check', migrated: at(-100), lastChange: time - 100000 };
const id = ruleId(base);
const row = (overrides = {}) => ({ rule: base.name, scope: base.scope, rulesDir: base.rulesDir, contextId: 'file:0', at: at(1), line: 4,
  checkVerdict: 'followed', verdict: 'followed', served: true, triggerMatched: true, ...overrides });
const delivery = (overrides = {}) => ({ rule: base.name, scope: base.scope, rulesDir: base.rulesDir, contextId: 'file:0', line: 1, bytes: 100, ...overrides });
function report(options = {}) {
  const result = measureRules({ rows: Array.from({ length: 6 }, (_, i) => row({ line: i + 4, at: at(i + 1) })),
    deliveries: [delivery()], effective: [{ contextId: 'file:0', rules: [id], at: [at(1)] }], rules: [base],
    ledger: { [id]: { bodyHash: createHash('sha256').update('Follow.\n').digest('hex') } },
    store: { health: { days: { '2026-09-20': { calls: 10, errors: 0, slow: 0, totalMs: 30, maxMs: 5 } } } },
    now: time + 20000, days: 1, storeBytes: 500, ...options });
  return result;
}

test('trigger misses count only active governed undelivered rows, with prompt attribution withheld', () => {
  const rows = [row({ verdict: 'trigger miss', served: false, triggerMatched: false }), row({ verdict: 'trigger miss', served: false, triggerMatched: true }),
    ...Array.from({ length: 3 }, () => row()), row({ verdict: 'trigger miss (superseded)', served: false })];
  const measured = report({ rows }).rules[id].measures.misses;
  assert.equal(measured.count, 2);
  assert.equal(measured.triggerUnmatched, 1);
  assert.equal(measured.engineMiss, 1);
  assert.equal(measured.unobservable, 1);
  assert.equal(report({ rows, rules: [{ ...base, promptTrigger: true }] }).rules[id].measures.misses.unattributable, 2);
});

test('noise joins delivery to same rule and compaction context after delivery line', () => {
  const received = Array.from({ length: 5 }, (_, n) => delivery({ contextId: `file:${n}`, line: 5 }));
  const rows = [row({ contextId: 'file:0', line: 6 }), row({ contextId: 'file:1', line: 4 })];
  assert.equal(report({ rows, deliveries: received }).rules[id].measures.noise.count, 4);
  assert.equal(report({ rows, deliveries: received, rules: [{ ...base, complianceKind: 'model' }] }).rules[id].measures.noise.status, 'unmeasurable');
});

test('cost uses delivered bytes and effective contexts, not store served counters', () => {
  const measured = report({ deliveries: Array.from({ length: 5 }, () => delivery({ bytes: 100 })), store: { served: { 'a.md': { count: 900 } } } }).rules[id].measures.cost;
  assert.equal(measured.servedBytes, 500);
  assert.equal(measured.status, 'watch'); // one effective context: never a confident ratio
  assert.equal(measured.ratio, undefined);
   assert.equal(report({ deliveries: Array.from({ length: 5 }, () => delivery({ bytes: 1 })), effective: Array.from({ length: 5 }, (_, n) => ({ contextId: `file:${n}`, rules: [id], at: [at(1)] })) }).rules[id].measures.cost.status, 'OK');
});

test('coverage separates scanner checks, hook-only checks, and unmatched candidates', () => {
  const rules = [base, { ...base, name: 'b.md', complianceKind: 'test-before-edit' }, { ...base, name: 'c.md', complianceKind: 'none' }];
  const coverage = report({ rules, acts: { Agent: { count: 8, matchedAnyRule: true, scannerCheck: false }, Read: { count: 9, matchedAnyRule: false, scannerCheck: false } } }).coverage;
  assert.deepEqual(coverage.governedWithoutScannerCheck.map((act) => act.key), ['Agent']);
  assert.deepEqual(coverage.uncoveredCandidates.map((act) => act.key), ['Read']);
  assert.deepEqual(coverage.scannerLacksCheck, [ruleId(rules[1])]);
  assert.deepEqual(coverage.noPossibleCheck, [ruleId(rules[2])]);
});

test('migration drift hashes body; legacy no git evidence remains unknown', () => {
  assert.equal(report().rules[id].measures.driftMigration.value, 'unchanged');
  assert.equal(report({ rules: [{ ...base, text: text.replace('Follow.', 'Changed.') }] }).rules[id].measures.driftMigration.value, 'changed');
  assert.equal(report({ ledger: {} }).rules[id].measures.driftMigration.value, 'unknown');
  assert.equal(report({ ledger: {}, rules: [{ ...base, lastChange: time }] }).rules[id].measures.driftMigration.value, 'unknown');
});

test('migration drift uses exact legacy triggers despite later git history, and detects trigger or body changes', () => {
  const originalTriggers = [{ kind: 'tool', tool: '^Agent$', unconditional: 'true' }];
  const legacy = { triggersHash: triggersHash(originalTriggers) };
  const newer = { ...base, lastChange: time + 1000 };
  const value = (rule, entry) => report({ rules: [rule], ledger: { [id]: entry } }).rules[id].measures.driftMigration;
  assert.deepEqual(value(newer, legacy), { cases: null, status: 'OK', value: 'unchanged', basis: ['triggers'] });
  assert.deepEqual(value({ ...newer, text: text.replace("tool: '^Agent$'", "tool: '^Bash$'") }, legacy),
    { cases: null, status: 'problem', value: 'changed', basis: ['triggers'] });
  const both = { ...legacy, bodyHash: createHash('sha256').update('Follow.\n').digest('hex') };
  assert.deepEqual(value({ ...newer, text: text.replace('Follow.', 'Changed.') }, both),
    { cases: null, status: 'problem', value: 'changed', basis: ['body', 'triggers'] });
});

test('absent evidence cannot make any member of the measure family confidently negative', () => {
  const fp = createHash('sha256').update('Follow.\n').digest('hex').slice(0, 12);
  const adopted = text.replace('Follow.\n', () => `<!-- installed from workflow-toolbox v1 · content sha256:${fp} by the adopt skill -->\n\nFollow.\n`);
  const inputs = ['rows', 'deliveries', 'effective', 'acts', 'ledger', 'store', 'pluginRulesDir', 'storeBytes', 'previousState'];
  for (const kind of ['check', 'none', 'test-before-edit']) for (const isAdopted of [false, true]) {
    const rule = { ...base, text: isAdopted ? adopted : text, complianceKind: kind, lastChange: time + 1000 };
    const rows = Array.from({ length: 6 }, (_, n) => row({ line: n + 4 }));
    const input = { rules: [rule], rows, deliveries: Array.from({ length: 6 }, () => delivery()),
      effective: Array.from({ length: 6 }, (_, n) => ({ rules: [id], at: [at(n + 1)] })),
      acts: { Agent: { count: 6 } }, ledger: { [id]: { triggersHash: triggersHash([{ kind: 'tool', tool: '^Agent$', unconditional: 'true' }]) } },
      store: { health: { days: { '2026-09-20': { calls: 10 } } } }, pluginRulesDir: { [id]: 'Follow.\n' }, storeBytes: 100,
      previousState: { store: { at: time - 86400000, bytes: 50 } }, now: time + 20000, days: 1 };
    for (const missing of [...inputs, 'all']) {
      const absent = missing === 'all' ? inputs : [missing];
      const partial = { ...input };
      for (const key of absent) delete partial[key];
      const result = measureRules(partial);
      const measures = result.rules[id].measures;
      for (const name of Object.keys(measures)) {
        assert.ok(Object.hasOwn(measureDependencies, name), `undeclared measure ${name}`);
        const dependencies = name === 'driftAdopted' && !isAdopted ? [] : measureDependencies[name];
        if (!dependencies.some((key) => absent.includes(key))) continue;
        const measured = measures[name];
        assert.notEqual(measured.status, 'problem', `${kind}/${isAdopted}/${missing}/${name}: status`);
        assert.notEqual(typeof measured.rate, 'number', `${kind}/${isAdopted}/${missing}/${name}: rate`);
        assert.notEqual(typeof measured.ratio, 'number', `${kind}/${isAdopted}/${missing}/${name}: ratio`);
        assert.ok(!['changed', 'no shipped source', 'behind', 'behind and locally edited', 'locally edited'].includes(measured.value),
          `${kind}/${isAdopted}/${missing}/${name}: value ${measured.value}`);
        if (measured.status === 'OK') assert.deepEqual(dependencies, [], `${kind}/${isAdopted}/${missing}/${name}: OK needs text-only evidence`);
      }
      for (const [name, value] of Object.entries(result.health)) {
        if (name === 'status' && absent.includes('store')) assert.notEqual(value, 'problem', `${kind}/${isAdopted}/${missing}/health`);
        if (name === 'growthPerDay' && (absent.includes('storeBytes') || absent.includes('previousState')))
          assert.notEqual(typeof value, 'number', `${kind}/${isAdopted}/${missing}/healthGrowth`);
        if (name === 'profiles' && absent.includes('store')) for (const profile of value)
          assert.notEqual(profile.status, 'problem', `${kind}/${isAdopted}/${missing}/health profile`);
      }
      if (absent.includes('acts')) for (const name of ['governedWithoutScannerCheck', 'uncoveredCandidates'])
        assert.deepEqual(result.coverage[name], [], `${kind}/${isAdopted}/${missing}/${name}`);
    }
  }
});

test('adopt fingerprints the body after stripping banner and on-demand head', () => {
  const shipped = 'Follow.\n';
  const fp = createHash('sha256').update(shipped).digest('hex').slice(0, 12);
  const adopted = { ...base, text: text.replace('Follow.\n', () => `<!-- installed from workflow-toolbox v1.0.0 · content sha256:${fp} by the adopt skill -->\n\nFollow.\n`) };
  const value = (rule, source) => report({ rules: [rule], pluginRulesDir: source }).rules[id].measures.driftAdopted.value;
  assert.equal(value(adopted, { 'a.md': shipped }), 'current');
  assert.equal(value(adopted, { 'a.md': 'Next.\n' }), 'behind');
  assert.equal(value({ ...adopted, text: adopted.text.replace('Follow.\n', 'Edited.\n') }, { 'a.md': 'Next.\n' }), 'behind and locally edited');
  assert.equal(value(adopted, undefined), 'unknown');
});

test('stale adopted banner with shipped-identical local text stays unknown without a proposal', () => {
  const shipped = 'Follow.\n';
  const stale = createHash('sha256').update('Older.\n').digest('hex').slice(0, 12);
  const bannerText = `<!-- installed from workflow-toolbox v0.188.0 · content sha256:${stale} by the adopt skill -->\n\n`;
  const adopted = { ...base, text: text.replace('Follow.\n', () => `${bannerText}${shipped}`) };
  const measured = (rule, source) => report({ rules: [rule], pluginRulesDir: { 'a.md': source } }).rules[id];
  const identical = measured(adopted, shipped);
  assert.equal(identical.measures.driftAdopted.value, 'behind and locally edited');
  assert.equal(identical.measures.driftAdopted.status, 'unknown');
  assert.match(identical.measures.driftAdopted.reason, /local text disagrees with the banner fingerprint.*shipped-text comparison is not implemented yet/i);
  assert.ok(!identical.proposals.some((item) => /adopted|local edit/i.test(item)));
  const edited = measured({ ...adopted, text: adopted.text.replace('Follow.\n', 'Edited.\n') }, shipped);
  assert.equal(edited.measures.driftAdopted.value, 'behind and locally edited');
  assert.equal(edited.measures.driftAdopted.status, 'unknown');
  const localOnly = measured({ ...adopted, text: adopted.text.replace('Follow.\n', 'Edited.\n') }, 'Older.\n');
  assert.equal(localOnly.measures.driftAdopted.value, 'locally edited');
  assert.equal(localOnly.measures.driftAdopted.status, 'unknown');
  const currentRule = { ...adopted, text: adopted.text.replace(stale, () => createHash('sha256').update(shipped).digest('hex').slice(0, 12)) };
  const current = measured(currentRule, shipped);
  assert.equal(current.measures.driftAdopted.status, 'OK');
  const behind = measured(currentRule, 'Updated.\n');
  assert.equal(behind.measures.driftAdopted.value, 'behind');
  assert.equal(behind.measures.driftAdopted.status, 'problem');
});

test('adopted source distinguishes an unknown rule-id entry from a missing shipped file', () => {
  const shipped = 'Follow.\n';
  const fp = createHash('sha256').update(shipped).digest('hex').slice(0, 12);
  const adopted = { ...base, text: text.replace('Follow.\n', () => `<!-- installed from workflow-toolbox v1 · content sha256:${fp} by the adopt skill -->\n\nFollow.\n`) };
  const value = (source) => report({ rules: [adopted], pluginRulesDir: source }).rules[id].measures.driftAdopted.value;
  assert.equal(value({ [id]: undefined, 'a.md': shipped }), 'unknown');
  assert.equal(value({ [id]: null, 'a.md': shipped }), 'no shipped source');
  assert.equal(value({ 'a.md': shipped }), 'current');
});

test('engine health aggregates bounded daily counters and growth, missing key stays unknown', () => {
  const health = report().health;
  assert.equal(health.calls, 10);
  assert.equal(report({ store: {} }).health.status, 'unknown');
  assert.equal(report({ store: { health: { days: { '2026-09-20': { calls: 10, errors: 1 } } } } }).health.status, 'problem');
  assert.equal(report({ store: { sessions: { one: { contexts: { main: { triggerErrors: [{ at: at(1) }] } } } } } }).health.status, 'problem');
  const repeated = { one: { contexts: { main: { triggerErrors: [{ at: at(1) }] } } } };
  assert.equal(report({ store: { health: { days: {} }, profiles: [
    { configDir: '/a', recorded: true, sessions: repeated }, { configDir: '/b', recorded: true, sessions: repeated }] } }).health.triggerErrors, 2);
  assert.equal(report({ previousState: { store: { at: time - 86400000, bytes: 0 } }, storeBytes: 2_000_000 }).health.status, 'problem');
});

test('delete proposal requires five post-migration undelivered followed acts, excluding static baseline', () => {
  const rows = Array.from({ length: 5 }, () => row({ verdict: 'trigger miss', served: false })).concat(Array.from({ length: 5 }, () => row()));
  assert.equal(report({ rows }).rules[id].measures.delete.status, 'problem');
  assert.equal(report({ rows: rows.map((item) => item.served ? item : { ...item, verdict: 'static baseline' }) }).rules[id].measures.delete.status, 'unknown');
});

test('guard proposal requires code-checkable served violations and five cases', () => {
  const rows = Array.from({ length: 5 }, () => row({ checkVerdict: 'not followed' }));
  assert.equal(report({ rows }).rules[id].measures.guard.status, 'problem');
  assert.equal(report({ rows, rules: [{ ...base, complianceKind: 'model' }] }).rules[id].measures.guard.status, 'unmeasurable');
  assert.equal(report({ rows: rows.slice(0, 4) }).rules[id].measures.guard.status, 'watch');
});

test('volume uses ingestion watermark and retains verdict until new acts reach N; expired watermark is a gap', () => {
  const first = report({ volume: 8 });
  assert.equal(first.rules[id].measures.volume.due, true);
  const second = report({ volume: 8, previousState: first.state });
  assert.equal(second.rules[id].measures.volume.label, 'waiting 0/8');
  assert.equal(second.state.rules[id].watermark, first.state.rules[id].watermark);
   const gap = report({ volume: 8, previousState: { rules: { [id]: { lastRunAt: time - 90000000, seen: [], pending: 0, verdict: 'OK' } } } });
   assert.equal(gap.rules[id].measures.volume.label, 'gap');
   assert.equal(gap.rules[id].measures.volume.gap, true);
});

test('verdict keeps watch under five, unknown on zero or missing evidence, problem wins', () => {
  assert.equal(report({ rows: [row()], ledger: {} }).rules[id].verdict, 'watch');
  assert.equal(report({ rows: [], deliveries: [], ledger: {} }).rules[id].measures.misses.status, 'unknown');
  assert.equal(report({ rows: Array.from({ length: 5 }, () => row({ verdict: 'trigger miss', served: false })) }).rules[id].verdict, 'problem');
  assert.equal(report({ rows: [row()] }).rules[id].measures.misses.rate, undefined);
});

test('collect scan retains identity, delivery bytes, and distinct compacted contexts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rulesDir = join(root, '.claude', 'rules-on-demand'), projects = join(root, 'projects');
  await mkdir(rulesDir, { recursive: true }); await mkdir(projects);
  await writeFile(join(rulesDir, 'a.md'), text);
  const block = '<rule name="a.md">\nFollow.\n</rule>';
  const transcript = [
    { type: 'attachment', timestamp: at(1), cwd: root, attachment: { type: 'hook_additional_context', content: block } },
    { type: 'assistant', timestamp: at(2), cwd: root, message: { content: [{ type: 'tool_use', id: 'one', name: 'Agent', input: {} }] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: at(3), cwd: root },
    { type: 'attachment', timestamp: at(4), cwd: root, attachment: { type: 'hook_additional_context', content: block } },
    { type: 'assistant', timestamp: at(5), cwd: root, message: { content: [{ type: 'tool_use', id: 'two', name: 'Agent', input: {} }] } },
  ];
  await writeFile(join(projects, 's.jsonl'), transcript.map(JSON.stringify).join('\n') + '\n');
  const result = await scanTranscripts({ projectsDirs: [projects], scopes: [{ scope: 'project', projectRoot: root, rulesDir, ledgerRoots: [root] }],
    collect: true, now: time + 20000, days: 1, migrationDateOf: async () => at(-100), lastChangeOf: async () => at(-100) });
  assert.equal(result.contexts, 2);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries[0].bytes, Buffer.byteLength(block));
  assert.notEqual(result.deliveries[0].contextId, result.deliveries[1].contextId);
  assert.equal(result.acts.Agent.count, 2);
  assert.equal(result.acts.Agent.checked, 2);
  assert.equal(result.scopes[0].rules[0].name, 'a.md');
  assert.equal((await readFile(join(rulesDir, 'a.md'), 'utf8')), text);
});

test('collected scanner judges a delivered act as served and an active undelivered act as a trigger miss', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-quality-judge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rulesDir = join(root, '.claude', 'rules-on-demand'), projects = join(root, 'projects');
  await mkdir(rulesDir, { recursive: true }); await mkdir(projects);
  const spec = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n  compliance:\n    kind: 'tool-input'\n    tool: '^Agent$'\n    require-input-regex: 'yes'\n    window: '1'\n    on-close: 'not applicable'\n---\nFollow.\n`;
  await writeFile(join(rulesDir, 'a.md'), spec);
  const records = [
    { type: 'attachment', timestamp: at(1), cwd: root, attachment: { type: 'hook_additional_context', content: '<rule name="a.md">Follow.</rule>' } },
    { type: 'assistant', timestamp: at(2), cwd: root, message: { content: [{ type: 'tool_use', id: 'first', name: 'Agent', input: { prompt: 'yes' } }] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: at(3), cwd: root },
    { type: 'attachment', timestamp: at(4), cwd: root, attachment: { type: 'hook_additional_context', content: '<rule name="other.md">Other.</rule>' } },
    { type: 'assistant', timestamp: at(5), cwd: root, message: { content: [{ type: 'tool_use', id: 'second', name: 'Agent', input: { prompt: 'yes' } }] } },
  ];
  await writeFile(join(rulesDir, 'other.md'), spec.replace('Follow.', 'Other.'));
  await writeFile(join(projects, 's.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const scan = await scanTranscripts({ projectsDirs: [projects], scopes: [{ scope: 'project', projectRoot: root, rulesDir, ledgerRoots: [root] }], collect: true,
    now: time + 20000, days: 1, migrationDateOf: async () => at(-100), lastChangeOf: async () => at(-100) });
  const own = scan.rows.filter((item) => item.rule === 'a.md');
  assert.deepEqual(own.map((item) => item.verdict), ['followed', 'trigger miss']);
  assert.notEqual(own[0].contextId, own[1].contextId);
});

test('scanner coverage classifies each call before combining keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-coverage-act-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rulesDir = join(root, '.claude', 'rules-on-demand'), projects = join(root, 'projects');
  await mkdir(rulesDir, { recursive: true }); await mkdir(projects);
  await writeFile(join(rulesDir, 'a.md'), text.replace("unconditional: 'true'", "input-regex: 'checked'"));
  await writeFile(join(rulesDir, 'b.md'), text.replace("kind: 'check'\n    check: 'gate-background'", "kind: 'none'\n    reason: 'judged by a human'"));
  const transcript = [{ type: 'assistant', cwd: root, timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'checked', name: 'Agent', input: { prompt: 'checked' } }] } },
    ...Array.from({ length: 5 }, (_, n) => ({ type: 'assistant', cwd: root, timestamp: at(2 + n), message: { content: [{ type: 'tool_use', id: `unchecked${n}`, name: 'Agent', input: { prompt: 'other' } }] } })),
    ...Array.from({ length: 5 }, (_, n) => ({ type: 'assistant', cwd: root, timestamp: at(10 + n), message: { content: [{ type: 'tool_use', id: `unmatched${n}`, name: 'Read', input: {} }] } }))];
  await writeFile(join(projects, 's.jsonl'), transcript.map(JSON.stringify).join('\n') + '\n');
  const scan = await scanTranscripts({ projectsDirs: [projects], scopes: [{ scope: 'project', projectRoot: root, rulesDir, ledgerRoots: [root] }], collect: true,
    now: time + 20000, days: 1, migrationDateOf: async () => at(-100), lastChangeOf: async () => at(-100) });
  assert.equal(scan.acts.Agent.checked, 1);
  assert.equal(scan.acts.Agent.governedWithoutScannerCheck, 5);
  assert.equal(scan.acts.Read.unmatched, 5);
  const mixed = report({ acts: { Agent: { count: 6, checked: 1, governedWithoutScannerCheck: 5, unmatched: 0 } } }).coverage;
  assert.deepEqual(mixed.governedWithoutScannerCheck, [{ key: 'Agent', count: 5 }]);
});

test('host hook records daily calls, bounded errors and slow calls on the store', async () => {
  resetForSelftest();
  const handlers = new Map(), stored = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = { env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : null },
    fs: { list: async () => [], stat: async () => ({ kind: 'dir' }) }, ui: { log: async () => {} },
    store: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value) }, session: { id: async () => 'one', messages: async () => [] } };
  await handlers.get('tool.call')($, { tool: 'Agent' }, async () => ({}));
  await assert.rejects(handlers.get('tool.call')($, { tool: 'Agent' }, async () => { throw new Error('host error'); }), /host error/);
  await handlers.get('turn.complete')($, {}, async () => ({}));
  const day = Object.values(stored.get('health').days)[0];
  assert.equal(day.calls, 3);
   assert.equal(day.errors, 0);
   assert.equal(stored.get('health').lastErrors.length, 0);
});

test('quality-check archives measure rows and enforces strict incomplete/problem exit codes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-quality-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Reproduce a temp path spelled differently from its real path (e.g. /var vs /private/var).
  const alias = process.platform === 'win32' ? root : join(root, 'alias');
  if (alias !== root) await symlink(root, alias, 'dir');
  const project = join(alias, 'project'), config = join(alias, 'config'), projects = join(config, 'projects'), data = join(alias, 'quality');
  await mkdir(join(project, '.claude', 'rules'), { recursive: true }); await mkdir(projects, { recursive: true });
  await writeFile(join(project, '.claude', 'rules', 'a.md'), 'Follow.\n');
  const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'tool-input', tool: '^Agent$', 'require-input-regex': 'yes', window: 1, 'on-close': 'not applicable' } };
  await migrateRule(project, 'a.md', spec, {});
  const migrateEntry = JSON.parse((await readFile(join(project, '.claude', 'rules-on-demand-ledger.jsonl'), 'utf8')).trim());
  assert.equal(migrateEntry.bodyHash, createHash('sha256').update('Follow.\n').digest('hex'));
  const now = new Date().toISOString();
  const records = [{ type: 'attachment', cwd: project, timestamp: now, attachment: { type: 'hook_additional_context', content: '<rule name="a.md">Follow.</rule>', toolUseID: 'call-context' } },
    { type: 'assistant', cwd: project, timestamp: now, message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { prompt: 'yes' } }] } }];
  await writeFile(join(projects, 'session.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const args = [fileURLToPath(new URL('../scripts/quality-check.mjs', import.meta.url)), '--config-dir', config, '--projects-dir', projects, '--project', project, '--data-dir', data, '--strict-measures'];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', env: cleanEnv({ HOME: root, CLAUDE_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  const incomplete = run();
  assert.equal(incomplete.status, 3, incomplete.stderr);
  assert.ok(JSON.parse(incomplete.stdout).measures.rules);
  const archived = await readFile(join(data, `measure-rows-${now.slice(0, 10)}.jsonl`), 'utf8');
  assert.match(archived, /"type":"delivery"/);
  const store = join(config, 'plugins', 'store'); await mkdir(store, { recursive: true });
  await writeFile(join(store, 'wt-rules-on-demand_test.json'), JSON.stringify({ health: { days: { [now.slice(0, 10)]: { calls: 1, errors: 1, slow: 0, totalMs: 1, maxMs: 1 } } } }));
  const problem = run();
  assert.equal(problem.status, 4, problem.stderr);
  assert.equal(JSON.parse(problem.stdout).measures.health.status, 'problem');
  assert.ok((await readFile(join(data, 'measures-state.json'), 'utf8')).includes('lastRunAt'));
  const second = join(root, 'second-config');
  const firstInstall = join(root, 'first-install'), secondInstall = join(root, 'second-install');
  await mkdir(join(firstInstall, 'rules'), { recursive: true });
  await mkdir(join(secondInstall, 'rules'), { recursive: true });
  await mkdir(join(second, 'plugins'), { recursive: true });
  await mkdir(join(config, 'plugins'), { recursive: true });
  await writeFile(join(firstInstall, 'rules', 'a.md'), 'Follow.\n');
  await writeFile(join(secondInstall, 'rules', 'a.md'), 'Other.\n');
  await writeFile(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'workflow-toolbox@test': [{ installPath: firstInstall, version: 'v1' }] } }));
  await writeFile(join(second, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'workflow-toolbox@test': [{ installPath: secondInstall, version: 'v2' }] } }));
  const fp = createHash('sha256').update('Follow.\n').digest('hex').slice(0, 12);
  const rulePath = join(project, '.claude', 'rules-on-demand', 'a.md');
  await writeFile(rulePath, (await readFile(rulePath, 'utf8')).replace('Follow.\n', () => `<!-- installed from workflow-toolbox v1 · content sha256:${fp} by the adopt skill -->\n\nFollow.\n`));
  await writeFile(join(store, 'wt-rules-on-demand_test.json'), JSON.stringify({ health: { days: { [now.slice(0, 10)]: { calls: 1, errors: 0 } } } }));
  const cross = spawnSync(process.execPath, [args[0], '--config-dir', config, '--config-dir', second, ...args.slice(3).filter((arg) => arg !== '--strict-measures')],
    { encoding: 'utf8', env: cleanEnv({ HOME: root, CLAUDE_CONFIG_DIR: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  assert.equal(cross.status, 0, cross.stderr);
  const result = JSON.parse(cross.stdout);
  // Scope identity is the physical rules directory, even when the CLI was passed an alias.
  const ruleKey = `project:${await realpath(join(project, '.claude', 'rules-on-demand'))}:a.md`;
  assert.deepEqual(result.scopes.map((scope) => scope.scope), ['project']);
  assert.equal(result.measures.rules[ruleKey].measures.driftAdopted.value, 'ambiguous shipped source');
  assert.equal(result.measures.rules[ruleKey].measures.driftAdopted.versions.length, 2);
  assert.deepEqual(result.measures.health.unrecorded, [second]);
  assert.equal(result.measures.health.status, 'unknown');
  assert.deepEqual(result.measures.health.profiles.map((profile) => profile.status), ['OK', 'unknown']);
});

test('quality-check CLI resolves adopted user source across symlinked config profiles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-quality-user-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'first'), second = join(root, 'second'), project = join(root, 'project');
  const rulesDir = join(first, 'rules-on-demand'), projects = join(second, 'projects'), install = join(root, 'install');
  const data = join(root, 'quality'), shipped = 'Follow.\n';
  await mkdir(rulesDir, { recursive: true });
  await mkdir(join(first, 'rules'));
  await mkdir(join(first, 'plugins'), { recursive: true });
  await mkdir(join(second, 'plugins'), { recursive: true });
  await mkdir(projects);
  await mkdir(join(install, 'rules'), { recursive: true });
  await mkdir(project);
  await symlink(join(first, 'rules'), join(second, 'rules'), 'dir');
  await symlink(rulesDir, join(second, 'rules-on-demand'), 'dir');
  const fp = createHash('sha256').update(shipped).digest('hex').slice(0, 12);
  await writeFile(join(rulesDir, 'a.md'), text.replace('Follow.\n', () => `<!-- installed from workflow-toolbox v1 · content sha256:${fp} by the adopt skill -->\n\nFollow.\n`));
  await writeFile(join(install, 'rules', 'a.md'), shipped);
  for (const config of [first, second]) await writeFile(join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'workflow-toolbox@test': [{ installPath: install, version: 'v1' }] } }));
  const now = new Date().toISOString();
  await writeFile(join(projects, 'session.jsonl'), [
    { type: 'attachment', cwd: project, timestamp: now, attachment: { type: 'hook_additional_context', content: '<rule name="a.md">Follow.</rule>' } },
    { type: 'assistant', cwd: project, timestamp: now, message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: {} }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const args = [fileURLToPath(new URL('../scripts/quality-check.mjs', import.meta.url)), '--config-dir', first, '--config-dir', second,
    '--projects-dir', projects, '--project', project, '--data-dir', data];
  const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', env: cleanEnv({ HOME: root, CLAUDE_CONFIG_DIR: first, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  const value = () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const rules = Object.values(JSON.parse(result.stdout).measures.rules);
    assert.equal(rules.length, 1);
    return rules[0].measures.driftAdopted.value;
  };
  assert.equal(value(), 'current');
  await writeFile(join(install, 'rules', 'a.md'), 'Updated.\n');
  assert.equal(value(), 'behind');
});

test('cost crosses its ratio ceiling with five timestamped contexts, excluding old and undated contexts', () => {
  const effective = Array.from({ length: 5 }, (_, n) => ({ contextId: `f:${n}`, rules: [id], at: [at(1)] }));
  const high = report({ effective, deliveries: [delivery({ bytes: Buffer.byteLength('Follow.\n') * 5 * 6 })] }).rules[id].measures.cost;
  assert.equal(high.status, 'problem');
  assert.equal(high.ratio, 6);
  const excluded = report({ effective: [...effective, { contextId: 'old', rules: [id], at: [at(-100000)] }, { contextId: 'undated', rules: [id], at: [] }] }).rules[id].measures.cost;
  assert.equal(excluded.staticBytes, Buffer.byteLength('Follow.\n') * 5);
  assert.equal(excluded.contextsUnknownTiming, 1);
});

test('noise separates causal deliveries, rule identity and unresolved outcomes', () => {
  const other = { ...base, rulesDir: '/other/rules' };
  const received = Array.from({ length: 5 }, (_, n) => delivery({ contextId: `f:${n}`, line: 9, toolUseId: `call${n}` }));
  const rows = received.map((item) => row({ contextId: item.contextId, line: 4, toolUseId: item.toolUseId }));
  assert.equal(report({ deliveries: received, rows }).rules[id].measures.noise.count, 0);
  const foreign = received.map((item) => ({ ...item, rulesDir: other.rulesDir }));
  assert.equal(report({ deliveries: [...foreign, ...received], rows, rules: [base, other] }).rules[id].measures.noise.cases, 5);
  const undecidable = report({ deliveries: received, rows: [], store: { uncertainContexts: received.map((item) => ({ ruleId: id, contextId: item.contextId })) } }).rules[id].measures.noise;
  assert.equal(undecidable.unresolved, 5);
  assert.equal(undecidable.status, 'unknown');
});

test('delete requires both cohorts and both follow-rate predicates; guard and delete name actions', () => {
  const unserved = (count, followed) => Array.from({ length: count }, (_, n) => row({ verdict: 'trigger miss', served: false, checkVerdict: n < followed ? 'followed' : 'not followed', line: n }));
  const served = (count, followed) => Array.from({ length: count }, (_, n) => row({ checkVerdict: n < followed ? 'followed' : 'not followed', line: n + 100 }));
  const alone = report({ rows: unserved(5, 5) }).rules[id].measures.delete;
  assert.equal(alone.status, 'unknown');
  assert.equal(alone.servedApplicable, 0);
  assert.equal(alone.unservedApplicable, 5);
  assert.equal(report({ rows: [...unserved(5, 5), ...served(4, 4)] }).rules[id].measures.delete.status, 'watch');
  assert.equal(report({ rows: [...unserved(20, 18), ...served(20, 10)] }).rules[id].measures.delete.status, 'OK');
  assert.equal(report({ rows: [...unserved(20, 19), ...served(20, 20)] }).rules[id].measures.delete.status, 'OK');
  assert.equal(report({ rows: [...unserved(20, 20), ...served(5, 3)] }).rules[id].measures.delete.rate, 1);
  assert.match(report({ rows: [...unserved(20, 20), ...served(20, 15)] }).rules[id].proposals.join(' '), /delete: followed even when not served \(20 of 20\)/);
  assert.match(report({ rows: served(5, 0) }).rules[id].proposals.join(' '), /convert to a guard \(5 of 5 violated, code-checkable\)/);
});

test('slow health requires five calls at >=1% and UTC day alignment reports retention gap', () => {
  const days = { '2026-09-20': { calls: 500, errors: 0, slow: 5, totalMs: 500, maxMs: 100 }, '2026-09-19': { calls: 1, errors: 1 } };
  const input = { store: { health: { days } }, days: 1 };
  assert.equal(report(input).health.status, 'problem');
  assert.equal(report({ ...input, store: { health: { days: { ...days, '2026-09-20': { ...days['2026-09-20'], slow: 4 } } } } }).health.status, 'OK');
  assert.equal(report({ ...input, store: { health: { days: { ...days, '2026-09-20': { ...days['2026-09-20'], calls: 501 } } } } }).health.status, 'OK');
  assert.equal(report({ ...input, store: { health: { days: { ...days, '2026-09-20': { calls: 10, errors: 0 } } } } }).health.status, 'OK');
  assert.equal(report({ ...input, days: .6, healthDays: 2, store: { health: { days: { ...days, '2026-09-20': { calls: 10, errors: 0 } } } } }).health.status, 'problem');
  assert.equal(report(input).health.windowDays, 1);
  assert.equal(report(input).health.alignment, 'utc-day');
  assert.equal(report({ ...input, days: 32 }).health.retentionGap, true);
  assert.equal(report({ ...input, days: 32, store: { health: { days: { '2026-09-20': { calls: 10 } } } } }).health.status, 'unknown');
  assert.deepEqual(report({ store: { health: { days }, profiles: [{ configDir: '/missing', recorded: false }] } }).health.unrecorded, ['/missing']);
  assert.equal(report({ store: { health: { days: { '2026-09-20': { calls: 10500, slow: 5 } } },
    profiles: [{ configDir: '/slow', recorded: true, health: { days: { '2026-09-20': days['2026-09-20'] } } },
      { configDir: '/busy', recorded: true, health: { days: { '2026-09-20': { calls: 10000 } } } }] } }).health.status, 'problem');
});

test('volume ingests stable identities every day and late equal-timestamp acts', () => {
  let state = {};
  for (let day = 0; day < 25; day++) {
    const current = time + day * 86400000;
    const rows = Array.from({ length: Math.min(day + 1, 7) }, (_, offset) => row({ file: 'f', line: day - offset + 1, toolUseId: `act${day - offset}`, at: new Date(current - offset * 86400000).toISOString() }));
    const result = report({ rows, previousState: state, now: current + 20000, days: 7, volume: 20 });
    if (day === 19) assert.equal(result.state.rules[id].pending, 19);
    if (day === 20) assert.equal(result.rules[id].measures.volume.due, true);
    state = result.state;
  }
  assert.equal(state.rules[id].pending, 4);
  const late = report({ rows: [row({ file: 'f', line: 500, toolUseId: 'late', at: at(1) })], previousState: state, now: time + 25 * 86400000, days: 30 });
  assert.equal(late.rules[id].measures.volume.newActs, 1);
  const replay = report({ rows: [row({ file: 'f', line: 500, toolUseId: 'late', at: at(1), checkVerdict: 'not followed' })],
    previousState: late.state, now: time + 25 * 86400000, days: 30 });
  assert.equal(replay.rules[id].measures.volume.newActs, 0);
});

test('hook health bounds errors and days, excludes downstream latency, and survives failed health writes', async () => {
  resetForSelftest();
  const handlers = new Map(), stored = new Map([['served', { preserved: { count: 3 } }], ['compliance-verdicts-jsonl', 'preserved\n']]);
  let tick = time, failHealth = true;
  const RealDate = Date;
  class FixtureDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [tick])); }
    static now() { return tick; }
  }
  globalThis.Date = FixtureDate;
  try {
    register((name, handler) => handlers.set(name, handler), { enabled: true });
    const $ = { env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : null },
      fs: { list: async () => [{ name: 'bad.md', kind: 'file' }], stat: async (path) => ({ kind: path.endsWith('.md') ? 'file' : 'dir', size: 999999 }) },
      ui: { log: async () => {} }, session: { id: async () => 'one', messages: async () => { tick += 110; return [{ role: 'assistant' }]; } },
      store: { get: async (key) => { if (key === 'health' && failHealth) { failHealth = false; throw new Error('health unavailable'); } return stored.get(key); },
        set: async (key, value) => stored.set(key, value) } };
    for (let n = 0; n < 32; n++) {
      tick = time + n * 86400000;
      await handlers.get('prompt.context')($, { cwd: '/fixture' }, async () => { tick += 1000; return {}; });
      // Reload to exercise the skipped-file error on every UTC day.
      await handlers.get('session.compact')($, {}, async () => ({}));
    }
    const health = stored.get('health');
    assert.equal(Object.keys(health.days).length, 31);
    assert.equal(health.lastErrors.length, 20);
    assert.ok(Object.values(health.days).some((day) => day.slow > 0));
    assert.ok(Object.values(health.days).every((day) => day.maxMs < 1000));
    assert.deepEqual(stored.get('served'), { preserved: { count: 3 } });
    assert.equal(stored.get('compliance-verdicts-jsonl'), 'preserved\n');
  } finally { globalThis.Date = RealDate; }
});

test('hook event registrations use statically named top-level handlers', async () => {
  const source = await readFile(fileURLToPath(new URL('../hooks/hooks.js', import.meta.url)), 'utf8');
  for (const event of ['prompt.context', 'session.compact', 'prompt.submit', 'turn.complete', 'tool.call'])
    assert.match(source, new RegExp(`on\\('${event.replace('.', '\\.')}', [a-zA-Z]+Event\\)`));
  assert.doesNotMatch(source, /trackedOn\(/);
});

test('a failed health store read cannot discard a served rule or its compliance verdict', async () => {
  resetForSelftest();
  const handlers = new Map(), stored = new Map();
  let failHealth = true;
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = { env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : null },
    fs: { list: async (path) => path.endsWith('rules-on-demand') ? [{ name: 'a.md', kind: 'file' }] : [],
      stat: async (path) => ({ kind: path.endsWith('.md') ? 'file' : 'dir', size: 100 }),
      read: async () => text.replace("check: 'gate-background'", "check: 'agent-model'") },
    ui: { log: async () => {} }, session: { id: async () => 'one' },
    store: { get: async (key) => { if (key === 'health' && failHealth) { failHealth = false; throw new Error('health read failed'); } return stored.get(key); },
      set: async (key, value) => stored.set(key, value) } };
  await handlers.get('tool.call')($, { tool: 'Agent', input: { model: 'sonnet' }, cwd: '/fixture' }, async () => ({}));
  assert.equal(stored.get('served')['a.md'].count, 1);
  assert.match(stored.get('compliance-verdicts-jsonl'), /"rule":"a.md"/);
});
