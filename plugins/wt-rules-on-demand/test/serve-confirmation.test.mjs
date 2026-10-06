import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, link, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hooks from '../hooks/hooks.js';
import { STORE_BUDGETS, archiveTexts, shrink } from '../hooks/store-budget.js';
import * as delivery from '../scripts/delivery-join.mjs';
import * as archives from '../scripts/store-archives.mjs';
import * as lifecycle from '../scripts/rule-lifecycle-lib.mjs';
import { dailyRollback } from '../scripts/daily-rollback.mjs';
import { checkRollbackScope } from '../scripts/daily-provisional.mjs';
import { measureInputs } from '../scripts/quality-check.mjs';
import { scanTranscripts } from '../scripts/transcript-verdicts.mjs';
import { normal } from '../paths.js';

const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'Delivery-only fixture' } };
const body = 'Keep this instruction available.\n';
const old = '2020-01-01T00:00:00.000Z';
const newer = '2020-01-02T00:00:00.000Z';
const rollbackScript = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));

function engine(stored = new Map()) {
  hooks.resetForSelftest();
  const handlers = new Map();
  hooks.register((name, handler) => handlers.set(name, handler), { enabled: true });
  const text = ['---', 'on-demand:', '  triggers:', '    - kind: tool', '      tool: ^Agent$',
    '      unconditional: true', '  compliance:', '    kind: none', '    reason: Delivery-only fixture', '---', body].join('\n');
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/config', HOME: '/home' })[name] },
    fs: { list: async (path) => path === '/config/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [],
      read: async () => text, stat: async (path) => ({ kind: 'dir', size: text.length, realPath: path }) },
    ui: { log: async () => {} }, store: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value) },
    session: { id: async () => 'session' },
  };
  return { $, stored, call: (tool) => handlers.get('tool.call')($, { cwd: '/project', tool }, async () => ({})),
    callWith: (context, tool) => handlers.get('tool.call')(context, { cwd: '/project', tool }, async () => ({})),
    complete: () => handlers.get('turn.complete')($, { cwd: '/project' }, async () => ({})) };
}

test('engine records a load without a trigger, and a serve of the exact identity', async () => {
  const f = engine(), identity = 'user:/config/rules-on-demand:sample.md';
  const before = Date.now();
  await f.call('Read');
  const activity = f.stored.get('identityActivity');
  assert.ok(Date.parse(activity?.[identity]?.loadedAt) >= before, 'a loaded rule must have its own loadedAt record');
  assert.equal(activity[identity].servedAt, undefined);
  await f.call('Agent');
  assert.ok(Date.parse(f.stored.get('identityActivity')[identity].servedAt) >= before, 'a served rule must have its own servedAt record');
});

test('first activity write in a new engine process bypasses the stored throttle', async () => {
  const identity = 'user:/config/rules-on-demand:sample.md';
  const prior = new Date(Date.now() - 1000).toISOString();
  const f = engine(new Map([['identityActivity', { [identity]: { loadedAt: prior, servedAt: prior } }]]));
  await f.call('Agent');
  const row = f.stored.get('identityActivity')?.[identity];
  assert.ok(Date.parse(row?.loadedAt) > Date.parse(prior), 'the first load is unconditional in each process');
  assert.ok(Date.parse(row?.servedAt) > Date.parse(prior), 'the first serve is unconditional in each process');
  const loaded = row.loadedAt;
  await f.call('Read');
  assert.equal(f.stored.get('identityActivity')[identity].loadedAt, loaded, 'subsequent loads within ten minutes are throttled');
});

test('cached loaded identities refresh on a non-loading hook after the throttle window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(newer) });
  const f = engine(), identity = 'user:/config/rules-on-demand:sample.md';
  await f.call('Read');
  t.mock.timers.tick(600_001);
  await f.complete();
  assert.ok(Date.parse(f.stored.get('identityActivity')[identity].loadedAt) > Date.parse(newer), 'every hook call refreshes loaded identities when the throttle expires');
});

test('failed activity writes back off and later retain both the original serve and refreshed load', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(newer) });
  const f = engine(), identity = 'user:/config/rules-on-demand:sample.md';
  const set = f.$.store.set;
  let attempts = 0;
  f.$.store.set = async (key, value) => { if (key === 'identityActivity') { attempts++; throw new Error('disk full'); } return set(key, value); };
  await f.call('Agent');
  await f.call('Read');
  assert.equal(attempts, 1, 'a failed activity write must not be retried by every hook');
  f.$.store.set = set;
  t.mock.timers.tick(600_001);
  await f.complete();
  const row = f.stored.get('identityActivity')[identity];
  assert.equal(row.servedAt, newer, 'retry keeps the original serve instant instead of inventing a later serve');
  assert.ok(Date.parse(row.loadedAt) > Date.parse(newer));
});

test('identity activity joins each timestamp independently across live and archive copies', () => {
  assert.equal(typeof delivery.joinIdentityActivity, 'function', 'activity needs a timestamp join');
  const a = { id: { loadedAt: newer, servedAt: old } }, b = { id: { loadedAt: old, servedAt: newer } };
  const expected = { id: { loadedAt: newer, servedAt: newer } };
  assert.deepEqual(delivery.joinIdentityActivity(a, b), expected);
  assert.deepEqual(delivery.joinIdentityActivity(b, a, a), expected);
  assert.deepEqual(archives.withArchivedIdentityActivity([{ key: 'identityActivity', format: 1, value: b }], a), expected);
});

test('identity activity budget archives older identities without losing either timestamp', () => {
  assert.equal(STORE_BUDGETS.identityActivity, 20_000, 'activity is bounded below the old-engine foreign-key allowance');
  const input = Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`identity-${n}`, { loadedAt: old, servedAt: newer }]));
  input.latest = { loadedAt: '2020-01-03T00:00:00.000Z' };
  const plan = shrink('identityActivity', input);
  assert.ok(plan.evicted && Object.keys(plan.evicted).length);
  assert.ok(plan.value.latest, 'the latest loaded or served identities stay live');
  const pieces = archiveTexts('identityActivity', plan.evicted).map(JSON.parse);
  assert.ok(pieces.every((piece) => piece.format === 1 && piece.key === 'identityActivity'));
  assert.deepEqual(archives.withArchivedIdentityActivity(pieces, plan.value), input, 'archive round trip retains the complete activity record');
});

async function fixtureMirrors(dir, staticDir, mirrors) {
  const mirrorDirs = [];
  for (const mode of mirrors) {
    const mirror = join(dir, `mirror-${mirrorDirs.length}`);
    await mkdir(join(mirror, 'rules'), { recursive: true });
    if (mode === 'link') await symlink(join(staticDir, 'sample.md'), join(mirror, 'rules', 'sample.md'));
    else await writeFile(join(mirror, 'rules', 'sample.md'), body);
    mirrorDirs.push(mirror);
  }
  return mirrorDirs;
}

function fixtureLayout(dir, scope) {
  const config = join(dir, 'config'), root = scope === 'user' ? config : join(dir, 'project');
  const staticDir = join(root, scope === 'user' ? 'rules' : '.claude/rules');
  const ledger = join(root, scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
  const demand = join(root, scope === 'user' ? 'rules-on-demand' : '.claude/rules-on-demand');
  return { config, root, staticDir, ledger, demand };
}

async function fixture(t, { scope = 'user', mirrors = [], profileAlias = false } = {}) {
  // Physical root: the engine and the reader compare physical identities, and macOS (/var) and Windows (8.3 names)
  // hand out temp paths that are not their own real path. Aliases under test are created explicitly below.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rod-observed-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { config, root, staticDir, ledger, demand } = fixtureLayout(dir, scope);
  await mkdir(staticDir, { recursive: true });
  await mkdir(config, { recursive: true });
  await writeFile(join(staticDir, 'sample.md'), body);
  const mirrorDirs = await fixtureMirrors(dir, staticDir, mirrors);
  const selected = profileAlias ? join(dir, 'selected-profile') : config;
  if (profileAlias) await symlink(config, selected, 'dir');
  await lifecycle.migrateRule(root, 'sample.md', spec, {}, { scope, mirrorDirs, configDir: selected });
  const migration = JSON.parse((await readFile(ledger, 'utf8')).trim());
  migration.time = old;
  await writeFile(ledger, JSON.stringify(migration) + '\n');
  const identity = `${scope}:${await realpath(demand)}:sample.md`;
  return { dir, config, selected, root, ledger, migration, demand, identity, staticDir, mirrorDirs, scope };
}

async function hydrateIdentity(config, identity, row) {
  const parts = lifecycle.splitRuleIdentity(identity);
  const text = parts ? await readFile(join(parts.dir, parts.name), 'utf8').catch(() => '') : '';
  const generation = /^# migration-generation: ([a-f0-9-]+)$/m.exec(text)?.[1];
  if (generation && !row.generations) row.generations = { [generation]: Object.fromEntries(['loadedAt', 'servedAt'].filter((field) => row[field]).map((field) => [field, row[field]])) };
  row.reportedAt ??= [row.loadedAt, row.servedAt].filter(Boolean).sort().at(-1);
  row.writers ??= { 'fixture-run': { ...row, profile: config } };
}

function hydrateHealthDay(writer, day, counts) {
  writer.healthCalls ??= {};
  writer.healthTotals ??= {};
  writer.healthCalls[day] ??= counts.calls;
  writer.healthTotals[day] ??= counts.calls;
}

function hydrateHealth(value) {
  const capability = value.identityActivity?.['@capability']?.reportedAt;
  for (const [day, counts] of Object.entries(value.health?.days ?? {})) if (capability?.slice(0, 10) >= day) {
    hydrateHealthDay(value.identityActivity['@capability'].writers['fixture-run'], day, counts);
  }
}

async function store(config, value, name = 'wt-rules-on-demand_test.json', hydrate = true) {
  if (hydrate) {
    for (const [identity, row] of Object.entries(value.identityActivity ?? {})) await hydrateIdentity(config, identity, row);
    hydrateHealth(value);
  }
  const directory = join(config, 'plugins', 'store');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), JSON.stringify(value));
}

const evaluation = (f, extra = {}) => ({ scope: f.scope, configDir: f.config, root: f.root, windowHours: 0, ...extra });
const evidenceModule = () => import('../scripts/serve-confirmation.mjs');
async function evaluate(f, extra) {
  const module = await evidenceModule();
  return module.migrationEvidence({ ...f.migration, migratedAt: old }, 'sample.md', evaluation(f, extra));
}

test('migration is provisional and records only profiles that lost static delivery', async (t) => {
  const f = await fixture(t, { mirrors: ['link', 'copy'] });
  assert.equal(f.migration.state, 'provisional', 'migrate must ledger provisional state');
  assert.deepEqual(f.migration.profiles, [f.config, f.mirrorDirs[0]], 'an independent static copy is not a required profile');
});

test('confirmation is once-only, requires a later serve, and does not advance the lifecycle cutoff', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof lifecycle.confirmMigration, 'function', 'confirmation needs a lock-protected ledger writer');
  const evidence = { generation: f.migration.generation, profiles: [{ dir: f.config, state: 'served', servedAt: newer, generation: f.migration.generation }] };
  assert.equal((await lifecycle.confirmMigration(f.root, 'sample.md', old, evidence, { scope: 'user' })).changed, true);
  assert.equal((await lifecycle.confirmMigration(f.root, 'sample.md', old, evidence, { scope: 'user' })).changed, false);
  assert.equal(await lifecycle.lastLifecycleTime(f.root, 'sample.md', 'user'), old);
  assert.equal((await readFile(f.ledger, 'utf8')).trim().split('\n').filter((line) => JSON.parse(line).action === 'confirm').length, 1);
});

test('stale confirmation and stale provisional revert do not move or write anything', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof lifecycle.revertIfStillProvisional, 'function', 'provisional revert needs a state recheck under the scope lock');
  await lifecycle.ledger(f.root, { ...f.migration, action: 'migrate' }, 'user');
  const before = await readFile(f.ledger, 'utf8');
  const evidence = { generation: f.migration.generation, profiles: [{ dir: f.config, state: 'served', servedAt: newer, generation: f.migration.generation }] };
  assert.equal((await lifecycle.confirmMigration(f.root, 'sample.md', old, evidence, { scope: 'user' })).changed, false);
  assert.equal((await lifecycle.revertIfStillProvisional(f.root, 'sample.md', old, 'no observed load', { scope: 'user' })).changed, false);
  assert.equal(await readFile(f.ledger, 'utf8'), before);
  assert.equal(await readFile(join(f.demand, 'sample.md'), 'utf8').then(Boolean), true);
});

test('legacy, retired, reverted and confirmed migrations are not provisional', async () => {
  const { provisionalMigration } = await evidenceModule();
  const migration = { action: 'migrate', rule: 'sample.md', time: old, state: 'provisional' };
  const text = (rows) => rows.map(JSON.stringify).join('\n');
  assert.equal(provisionalMigration(text([{ ...migration, state: undefined }]), 'sample.md'), null);
  for (const action of ['retire', 'revert']) assert.equal(provisionalMigration(text([migration, { action, rule: 'sample.md' }]), 'sample.md'), null);
  assert.equal(provisionalMigration(text([migration, { action: 'confirm', rule: 'sample.md', migratedAt: old }]), 'sample.md'), null);
  assert.equal(provisionalMigration(text([migration, { action: 'confirm', rule: 'sample.md', migratedAt: newer }]), 'sample.md').migratedAt, old);
  const current = { ...migration, generation: 'current' };
  for (const generation of [undefined, 'previous']) {
    assert.equal(provisionalMigration(text([current, { action: 'confirm', rule: 'sample.md', migratedAt: old, generation }]), 'sample.md')?.generation, 'current', 'confirmation row must match the current migration generation');
  }
  assert.equal(provisionalMigration(text([current, { action: 'confirm', rule: 'sample.md', migratedAt: old, generation: 'current' }]), 'sample.md'), null);
});

test('confirm rows leave measurement and transcript ledger readers unchanged', async (t) => {
  const f = await fixture(t);
  const scope = { scope: 'user', configDir: f.config, configDirs: [f.config], rulesDir: f.demand, ledgerRoots: [f.root], rules: [] };
  const target = join(f.dir, 'quality');
  await mkdir(target);
  await mkdir(join(f.config, 'projects'));
  const options = { scopes: [scope], projectsDirs: [join(f.config, 'projects')], collect: true, migrationDate: async () => null, lastChange: async () => null };
  const before = await measureInputs([f.config], [scope], target);
  const scanBefore = await scanTranscripts(options);
  await lifecycle.ledger(f.root, { action: 'confirm', rule: 'sample.md', migratedAt: old, servedAt: newer }, 'user');
  assert.deepEqual((await measureInputs([f.config], [scope], target)).ledger, before.ledger);
  const scanAfter = await scanTranscripts(options);
  assert.deepEqual(scanAfter.scopes, scanBefore.scopes, 'confirm must not alter transcript migration or change dates');
});

test('serve confirmation rejects old, equal-time and different-identity serves', async (t) => {
  const f = await fixture(t);
  for (const servedAt of [old, '2019-12-31T00:00:00.000Z']) {
    await store(f.config, { identityActivity: { [f.identity]: { servedAt } } });
    assert.equal((await evaluate(f)).decision, 'revert', 'a serve at or before migration cannot confirm');
  }
  await store(f.config, { identityActivity: { [`${f.identity}-other`]: { servedAt: newer } } });
  assert.equal((await evaluate(f)).decision, 'revert');
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  assert.equal((await evaluate(f)).decision, 'confirm');
});

test('all recorded profiles must serve, irrespective of caller mirror arguments', async (t) => {
  const f = await fixture(t, { mirrors: ['link'] });
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  assert.equal((await evaluate(f)).decision, 'revert', 'an omitted mirror still requires its own serve');
  const mirrorIdentity = `user:${await realpath(join(f.mirrorDirs[0], 'rules-on-demand'))}:sample.md`;
  await store(f.mirrorDirs[0], { identityActivity: { [mirrorIdentity]: { servedAt: newer } } });
  assert.equal((await evaluate(f)).decision, 'confirm');
  await rm(f.mirrorDirs[0], { recursive: true });
  assert.equal((await evaluate(f)).decision, 'attention', 'a missing recorded profile cannot be restored');
});

test('loaded-without-serve stays provisional and reports attention after the window', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { [f.identity]: { loadedAt: newer } } });
  const result = await evaluate(f);
  assert.equal(result.decision, 'attention');
  assert.match(result.reason, /loaded but never served within 0h/);
  assert.equal(result.annotation.profiles[0].state, 'loaded');
  assert.equal((await evaluate(f, { windowHours: 168, now: Date.parse(old) + 1000 })).decision, null);
});

test('activity reader reads older store files, archived activity and identity aliases', async (t) => {
  const f = await fixture(t), alias = join(f.dir, 'alias');
  await symlink(f.demand, alias, 'dir');
  await store(f.config, { identityActivity: { [`user:${alias}:sample.md`]: { servedAt: newer } } }, 'wt-rules-on-demand_old.json');
  await store(f.config, {}, 'wt-rules-on-demand_new.json');
  assert.equal((await evaluate(f)).decision, 'confirm');
  await rm(join(f.config, 'plugins', 'store'), { recursive: true });
  const archiveDir = join(f.config, 'plugins', 'data', 'wt-rules-on-demand-inline', 'quality');
  await mkdir(archiveDir, { recursive: true });
  const archived = { servedAt: newer, reportedAt: newer, generations: { [f.migration.generation]: { servedAt: newer } } };
  archived.writers = { 'fixture-run': { ...archived, profile: f.config } };
  await writeFile(join(archiveDir, 'rod-store-archive-1-1.json'), JSON.stringify({ format: 1, key: 'identityActivity', value: { [f.identity]: archived } }));
  assert.equal((await evaluate(f)).decision, 'confirm', 'inline host archives are engine evidence too');
});

test('unknown activity blocks confirmation and restoration; incomplete sessions splits do not', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  await writeFile(join(f.config, 'plugins', 'store', 'wt-rules-on-demand_bad.json'), '{');
  assert.equal((await evaluate(f)).decision, 'attention');
  await rm(join(f.config, 'plugins', 'store', 'wt-rules-on-demand_bad.json'));
  const archiveDir = join(f.config, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  await mkdir(archiveDir, { recursive: true });
  const path = join(archiveDir, 'rod-store-archive-1-1.json');
  await writeFile(path, JSON.stringify({ format: 2, key: 'sessions', value: [{ split: { id: 'partial', index: 0, of: 2 }, context: {} }] }));
  assert.equal((await evaluate(f)).decision, 'confirm');
  await writeFile(path, '{');
  assert.equal((await evaluate(f)).decision, 'attention');
});

test('old engines and physically shared profile stores require attention', async (t) => {
  const f = await fixture(t, { mirrors: ['link'] });
  await store(f.config, { health: { days: { '2020-01-02': { calls: 1 } } } });
  let result = await evaluate(f);
  assert.equal(result.decision, 'attention');
  assert.match(result.reason, /engine too old to report loads/);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  await mkdir(join(f.mirrorDirs[0], 'plugins'), { recursive: true });
  await symlink(join(f.config, 'plugins', 'store'), join(f.mirrorDirs[0], 'plugins', 'store'), 'dir');
  result = await evaluate(f);
  assert.equal(result.decision, 'attention');
  assert.match(result.reason, /share activity storage/);
});

test('project exposure is bounded to post-migration cwd and confirms only at the deadline', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  assert.equal((await evaluate(f)).decision, 'attention', 'missing exposure in a recorded profile requires attention');
  await expose(f.config, f.root, JSON.stringify({ cwd: join(f.root, 'nested-worktree'), timestamp: newer }) + '\n');
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  assert.equal((await evaluate(f, { windowHours: 168, now: Date.parse(old) + 1000 })).decision, null, 'project confirmation waits for exposure discovery through the deadline');
  assert.equal((await evaluate(f)).decision, 'confirm');
  await expose(f.config, f.root, JSON.stringify({ cwd: `${f.root}-other`, timestamp: newer }) + '\n');
  assert.equal((await evaluate(f)).decision, 'attention', 'a sibling path prefix is not project exposure');
});

async function daily(f, extra = {}) {
  return dailyRollback({ configDirs: [f.config], projectsDirs: [], project: f.root, dataDir: join(f.dir, 'quality'),
    checkQuality: async () => ({ complete: false, scan: {}, coverage: {}, scopes: [] }), serveWindowHours: 0, ...extra });
}

test('daily provisional pass restores a never-loaded rule despite incomplete transcript coverage', async (t) => {
  const f = await fixture(t, { mirrors: ['link'] });
  const { result } = await daily(f, { apply: true });
  assert.equal(result.reverted.length, 1, 'the provisional safety pass must run before the coverage gate');
  assert.equal(await readFile(join(f.staticDir, 'sample.md'), 'utf8'), body);
  assert.equal(await readFile(join(f.mirrorDirs[0], 'rules', 'sample.md'), 'utf8'), body, 'recorded mirrors regain static delivery');
  assert.match(result.reverted[0].reason, /no observed load or serve within 0h/);
  assert.match(await readFile(join(f.dir, 'quality', 'revert-notifications.jsonl'), 'utf8'), /no observed load or serve/);
});

test('daily dry-run maps would-revert and leaves the ledger and files untouched', async (t) => {
  const f = await fixture(t), before = await readFile(f.ledger, 'utf8');
  const { result } = await daily(f);
  assert.equal(result.wouldRevert?.length, 1, 'daily reporting explicitly maps the would revert action');
  assert.equal(await readFile(f.ledger, 'utf8'), before);
  assert.ok(await readFile(join(f.demand, 'sample.md'), 'utf8'));
});

test('daily confirmation is serve-only, dry-run read-only and bucketed as an annotation', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  const before = await readFile(f.ledger, 'utf8');
  const dry = await daily(f);
  assert.equal(dry.result.provisional.length, 1);
  assert.equal(dry.result.provisional[0].wouldConfirm, true);
  assert.equal(await readFile(f.ledger, 'utf8'), before);
  const applied = await daily(f, { apply: true });
  assert.equal(applied.result.confirmed.length, 1);
  assert.equal(applied.result.confirmed[0].action, 'none', 'confirmation preserves the original outcome action');
  assert.match(await readFile(f.ledger, 'utf8'), /"action":"confirm"/);
});

test('daily reports loaded-but-unserved attention and applies the configured waiting window', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { [f.identity]: { loadedAt: newer } } });
  const { result } = await daily(f, { apply: true });
  assert.match(result.attention[0].reason, /loaded but never served/);
  assert.equal(result.provisional.length, 1);
  assert.ok(await readFile(join(f.demand, 'sample.md'), 'utf8'));
  const waiting = await daily(f, { serveWindowHours: 100_000 });
  assert.equal(waiting.result.wouldRevert.length, 0);
  assert.equal(waiting.result.provisional[0].provisional.serveWindowHours, 100_000);
});

test('daily keeps processing independent scopes after a failed provisional check', async (t) => {
  const f = await fixture(t);
  const bad = join(f.dir, 'bad-config');
  await mkdir(join(bad, 'rules-on-demand'), { recursive: true });
  await writeFile(join(bad, 'rules-on-demand', 'sample.md'), 'invalid rule');
  await mkdir(join(bad, 'rules-on-demand-ledger.jsonl'));
  const { result } = await daily(f, { configDirs: [bad, f.config], apply: true });
  assert.equal(result.failed.length, 1, 'failed checks are recorded without aborting the next scope');
  assert.equal(result.reverted.length, 1);
});

const completeQuality = async () => ({ complete: true, scan: {}, coverage: {}, scopes: [] });
const outcomeBuckets = () => ({ provisional: [], confirmed: [], reverted: [], wouldRevert: [], attention: [], refused: [], withinNoise: [], failed: [] });
const slug = (root) => root.replace(/[^a-zA-Z0-9]/g, '-');
async function expose(config, root, text = JSON.stringify({ cwd: root, timestamp: newer }) + '\n') {
  const dir = join(config, 'projects', slug(root));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'session.jsonl');
  await writeFile(path, text);
  return path;
}

test('fix1 project required profiles survive caller omission and transcript cleanup', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  const b = join(f.dir, 'profile-b');
  await mkdir(b);
  f.migration.profiles = [f.config, b];
  await expose(f.config, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  for (const profileDirs of [[f.config, b], [f.config]]) {
    const result = await evaluate(f, { profileDirs });
    assert.equal(result.decision, 'attention', 'missing recorded project exposure must prevent confirmation');
    assert.ok(result.reason.includes(b), 'attention names the required profile whose exposure is missing');
  }
});

for (const mode of ['symlink', 'hardlink']) test(`fix1 shared ${mode} store files cannot prove two profiles served`, async (t) => {
  const f = await fixture(t, { scope: 'project' });
  const b = join(f.dir, 'profile-b');
  await expose(f.config, f.root);
  await expose(b, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  await mkdir(join(b, 'plugins', 'store'), { recursive: true });
  const source = join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  const target = join(b, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  await (mode === 'symlink' ? symlink(source, target) : link(source, target));
  const result = await evaluate(f, { profileDirs: [f.config, b] });
  assert.equal(result.decision, 'attention', 'shared physical store files must not confirm two profiles');
  assert.match(result.reason, /share activity storage/);
});

test('fix1 cached OLD generation cannot confirm newly migrated NEW body', async (t) => {
  const f = await fixture(t);
  const instance = engine();
  instance.$.env.get = async (name) => name === 'CLAUDE_CONFIG_DIR' ? f.config : undefined;
  // The engine spells host paths with forward slashes (paths.js normal); Windows' native spelling uses backslashes.
  instance.$.fs.list = async (path) => normal(path) === normal(f.demand) ? [{ kind: 'file', name: 'sample.md' }] : [];
  instance.$.fs.read = async () => readFile(join(f.demand, 'sample.md'), 'utf8');
  instance.$.fs.stat = async (path) => ({ kind: 'dir', size: 4096, realPath: path });
  await instance.call('Read');
  await lifecycle.revertRule(f.root, 'sample.md', 'replace body', { scope: 'user' });
  await writeFile(join(f.staticDir, 'sample.md'), 'NEW instruction\n');
  await lifecycle.migrateRule(f.root, 'sample.md', spec, {}, { scope: 'user' });
  const migration = JSON.parse((await readFile(f.ledger, 'utf8')).trim().split('\n').at(-1));
  migration.time = new Date(Date.now() - 1000).toISOString();
  const rows = (await readFile(f.ledger, 'utf8')).trim().split('\n');
  rows[rows.length - 1] = JSON.stringify(migration);
  await writeFile(f.ledger, rows.join('\n') + '\n');
  const served = await instance.call('Agent');
  assert.ok(JSON.stringify(served).includes(body.trim()), 'the cached session really served OLD');
  await store(f.config, { identityActivity: instance.stored.get('identityActivity') }, undefined, false);
  const { migrationEvidence } = await evidenceModule();
  const result = await migrationEvidence({ ...migration, migratedAt: migration.time }, 'sample.md', evaluation(f));
  assert.notEqual(result.decision, 'confirm', 'OLD loaded generation must not confirm NEW migration');
  assert.equal(result.annotation.profiles[0].state, 'not loaded');
  const engineIdentity = `user:${normal(f.demand)}:sample.md`;
  assert.ok(instance.stored.get('identityActivity')[engineIdentity]?.generations?.[f.migration.generation]?.servedAt, 'engine echoes the generation of OLD actually served');
  hooks.resetForSelftest();
  const fresh = await instance.call('Agent');
  assert.ok(JSON.stringify(fresh).includes('NEW instruction'));
  await store(f.config, { identityActivity: instance.stored.get('identityActivity') }, undefined, false);
  const confirmed = await migrationEvidence({ ...migration, migratedAt: migration.time }, 'sample.md', evaluation(f));
  assert.equal(confirmed.decision, 'confirm', 'freshly loaded NEW generation confirms its own migration');
});

test('fix1 every revert restores ledger mirrors after confirmation and merges explicit mirrors', async (t) => {
  const f = await fixture(t, { mirrors: ['link'] });
  await lifecycle.ledger(f.root, { action: 'confirm', rule: 'sample.md', migratedAt: old, generation: f.migration.generation }, 'user');
  const extra = join(f.dir, 'extra');
  await mkdir(join(extra, 'rules'), { recursive: true });
  await mkdir(join(extra, 'rules-on-demand'));
  await symlink(join(f.demand, 'sample.md'), join(extra, 'rules-on-demand', 'sample.md'));
  await lifecycle.revertRule(f.root, 'sample.md', 'compliance', { scope: 'user', mirrorDirs: [extra] });
  assert.equal(await readFile(join(f.mirrorDirs[0], 'rules', 'sample.md'), 'utf8').catch(() => null), body, 'confirmed-rule revert must restore recorded mirror');
  assert.equal(await readFile(join(extra, 'rules', 'sample.md'), 'utf8'), body);
});

for (const missing of ['file', 'directory']) test(`fix1 missing provisional ${missing} is a named failing daily outcome`, async (t) => {
  const f = await fixture(t);
  await rm(missing === 'file' ? join(f.demand, 'sample.md') : f.demand, { recursive: true });
  const run = await daily(f, { apply: true, checkQuality: completeQuality });
  assert.notEqual(run.code, 0, 'missing provisional delivery must fail the daily run');
  assert.ok(run.result.attention.some((row) => row.rule === 'sample.md' && /delivery loss/.test(row.reason)), 'missing provisional rule must be named');
});

test('fix1 concurrent module writers re-read activity immediately before writing', async () => {
  const a = await import('../hooks/hooks.js?writer-a');
  const b = await import('../hooks/hooks.js?writer-b');
  const stored = new Map();
  const make = (module, name) => {
    const f = engine(stored), handlers = new Map();
    module.register((event, fn) => handlers.set(event, fn), { enabled: true });
    f.$.fs.list = async (path) => path === '/config/rules-on-demand' ? [{ kind: 'file', name }] : [];
    f.$.store.get = async (key) => structuredClone(stored.get(key));
    f.$.store.set = async (key, value) => stored.set(key, structuredClone(value));
    f.$.store.keys = async () => [];
    return { ...f, call: () => handlers.get('tool.call')(f.$, { cwd: '/project', tool: 'Agent' }, async () => ({})) };
  };
  const first = make(a, 'a.md'), second = make(b, 'b.md');
  let released;
  const paused = new Promise((resolve) => { released = resolve; });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let firstActivityRead = true;
  second.$.store.get = async (key) => {
    const value = structuredClone(stored.get(key));
    if (key === 'identityActivity' && firstActivityRead) { firstActivityRead = false; started(); await paused; }
    return value;
  };
  const pending = second.call();
  await ready;
  await first.call();
  released();
  await pending;
  assert.ok(stored.get('identityActivity')?.['user:/config/rules-on-demand:a.md']?.servedAt, 'B must preserve A serve after its stale snapshot');
});

test('fix1 empty or historical activity keys do not establish current engine capability', async (t) => {
  const f = await fixture(t);
  for (const activity of [{}, { [f.identity]: { loadedAt: old, servedAt: old } }]) {
    await store(f.config, { health: { days: { '2020-01-02': { calls: 1 } } }, identityActivity: activity });
    const result = await evaluate(f);
    assert.equal(result.decision, 'attention', 'historical activity key must not hide an old engine');
    assert.match(result.reason, /engine too old to report loads/);
  }
  await store(f.config, { health: { days: { '2020-01-02': { calls: 1 } } }, identityActivity: { '@capability': { reportedAt: newer } } });
  assert.equal((await evaluate(f)).decision, 'revert', 'a current capability write distinguishes a reporting engine that did not load this rule');
});

test('fix1 aliased on-demand directory checks physical ledger owner in either order', async (t) => {
  const f = await fixture(t), alias = join(f.dir, 'alias-profile');
  await mkdir(alias);
  await symlink(f.demand, join(alias, 'rules-on-demand'), 'dir');
  for (const configDirs of [[alias, f.config], [f.config, alias]]) {
    const run = await daily(f, { configDirs, checkQuality: completeQuality });
    assert.equal(run.result.wouldRevert.length, 1, 'alias-first order must evaluate the physical owner migration');
    assert.equal(run.result.wouldRevert[0].provisional.profiles[0].dir, f.config);
  }
});

test('fix1 exposure skips unrelated directories, streams complete observations and caches malformed-line count', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  const good = await expose(f.config, f.root, '{bad\n' + JSON.stringify({ cwd: f.root, timestamp: newer }) + '\n{unread-tail\n');
  const stale = join(f.config, 'projects', slug(f.root), 'old.jsonl');
  await writeFile(stale, '{bad');
  await utimes(stale, new Date('2019-01-01'), new Date('2019-01-01'));
  await mkdir(join(f.config, 'projects', '!unrelated'));
  await symlink(join(f.dir, 'absent'), join(f.config, 'projects', '!unrelated', 'sentinel.jsonl'));
  const reads = [], cache = new Map();
  const reader = async function* (path) { reads.push(path); for (const line of (await readFile(path, 'utf8')).split('\n')) yield line; };
  await writeFile(join(f.demand, 'other.md'), await readFile(join(f.demand, 'sample.md'), 'utf8'));
  const otherIdentity = `${f.identity.slice(0, -'sample.md'.length)}other.md`;
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer }, [otherIdentity]: { servedAt: newer } } });
  const { migrationEvidence } = await evidenceModule();
  for (const name of ['sample.md', 'other.md']) {
    const result = await migrationEvidence({ ...f.migration, rule: name, migratedAt: old }, name, evaluation(f, { exposureCache: cache, exposureReader: reader }));
    assert.equal(result.decision, 'confirm', 'malformed exposure line must not poison a valid project record');
    assert.equal(result.annotation.profiles[0].exposure.badLines, 3);
  }
  assert.deepEqual(reads.sort(), [good, stale].sort(), 'own-slug observations are streamed once across rules, including older files needed by other cutoffs');
});

test('fix1 failed restoration fails daily and publishes a named failure notification', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.staticDir, 'sample.md'), 'conflicting static body');
  const run = await daily(f, { apply: true, checkQuality: completeQuality });
  assert.notEqual(run.code, 0, 'restoration failure must fail daily rollback');
  assert.equal(run.result.ok, false);
  assert.match(run.result.attention[0].reason, /revert failed/);
  assert.match(await readFile(join(f.dir, 'quality', 'revert-notifications.jsonl'), 'utf8'), /rule restoration failed.*sample\.md|sample\.md.*revert failed/);
});

test('fix1 unreadable stores remain failures for provisional and legacy rules together', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.demand, 'legacy.md'), await readFile(join(f.demand, 'sample.md'), 'utf8'));
  await lifecycle.ledger(f.root, { action: 'migrate', rule: 'legacy.md' }, 'user');
  await store(f.config, {});
  await writeFile(join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json'), '{bad');
  const args = [rollbackScript, '--user', '--config-dir', f.config, '--json', '--dry-run', '--serve-window-hours', '0'];
  const buckets = outcomeBuckets();
  const code = checkRollbackScope(buckets, { scope: 'user', root: f.config }, args);
  assert.notEqual(code, 0, 'unreadable store must remain a failing status with mixed migrations');
  const rows = buckets.attention;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.action, 'attention');
    assert.ok(row.unreadableStores?.length, `${row.rule} must carry the store read failure`);
  }
  const directory = join(f.config, 'plugins', 'store');
  await rm(directory, { recursive: true });
  await symlink('store', directory, 'dir');
  const listing = outcomeBuckets();
  assert.notEqual(checkRollbackScope(listing, { scope: 'user', root: f.config }, args), 0, 'unreadable store directory must remain a failing status with mixed migrations');
  assert.equal(listing.attention.length, 2);
  assert.ok(listing.attention.every((row) => row.unreadableStores?.length));
  await rm(directory);
  await store(f.config, {});
  const archiveDir = join(f.dir, 'archives');
  await symlink('archives', archiveDir, 'dir');
  const archived = outcomeBuckets();
  const archiveArgs = [...args, '--store', join(directory, 'wt-rules-on-demand_test.json'), '--store-archives', archiveDir];
  assert.notEqual(checkRollbackScope(archived, { scope: 'user', root: f.config }, archiveArgs), 0, 'unreadable store archive directory must remain a failing status with mixed migrations');
  assert.equal(archived.attention.length, 2);
  assert.ok(archived.attention.every((row) => row.unreadableStores?.length));
});

async function complianceFixture(t, options) {
  const f = await fixture(t, options);
  const text = await readFile(join(f.demand, 'sample.md'), 'utf8');
  await writeFile(join(f.demand, 'sample.md'), text.replace('    kind: \'none\'', '    kind: \'tool-input\'').replace('    reason: \'Delivery-only fixture\'', () => "    tool: '^Agent$'\n    require-input-regex: 'yes'\n    window: 1\n    on-close: 'not applicable'"));
  const verdicts = join(f.dir, 'verdicts.jsonl');
  const rows = Array.from({ length: 12 }, (_, i) => ({ rule: 'sample.md', scope: 'user', rulesDir: f.demand, at: i < 6 ? '2019-12-31T00:00:00.000Z' : newer, phase: i < 6 ? 'before' : 'after', verdict: i < 6 ? 'followed' : 'not followed', checkVerdict: i < 6 ? 'followed' : 'not followed' }));
  rows.push({ rule: 'sample.md', scope: 'user', rulesDir: f.demand, at: newer, verdict: 'trigger miss', triggerMatched: false, file: 'session.jsonl', line: 1 });
  await writeFile(verdicts, rows.map(JSON.stringify).join('\n') + '\n');
  return { ...f, verdicts };
}
const complianceArgs = (f) => [rollbackScript, '--user', '--config-dir', f.config, '--verdicts', f.verdicts, '--json'];

test('fix1 legacy trigger-miss evidence keeps base rate-summary suppression', async (t) => {
  const f = await complianceFixture(t);
  f.migration.state = undefined;
  await writeFile(f.ledger, JSON.stringify(f.migration) + '\n');
  const buckets = outcomeBuckets();
  assert.equal(checkRollbackScope(buckets, { scope: 'user', root: f.config }, complianceArgs(f)), 0, JSON.stringify(buckets.failed));
  assert.equal(buckets.reverted[0]?.action, 'reverted');
  assert.equal(await readFile(join(lifecycle.qualityDataDir(f.config, {}), 'rollback-user-latest.json'), 'utf8').catch(() => null), null, 'legacy trigger-miss rollback must not publish a rate summary');
});

test('fix1 confirmed compliance rollback restores mirrors without repeated argv', async (t) => {
  const f = await complianceFixture(t, { mirrors: ['link'] });
  await lifecycle.ledger(f.root, { action: 'confirm', rule: 'sample.md', migratedAt: old, generation: f.migration.generation }, 'user');
  const buckets = outcomeBuckets();
  assert.equal(checkRollbackScope(buckets, { scope: 'user', root: f.config }, complianceArgs(f)), 0, JSON.stringify(buckets.failed));
  assert.equal(buckets.reverted.length, 1);
  assert.equal(await readFile(join(f.mirrorDirs[0], 'rules', 'sample.md'), 'utf8').catch(() => null), body, 'compliance rollback must restore recorded mirrors after confirmation');
});

test('fix1 legacy restoration exceptions keep their failing propagation', async (t) => {
  const f = await complianceFixture(t);
  f.migration.state = undefined;
  await writeFile(f.ledger, JSON.stringify(f.migration) + '\n');
  await writeFile(join(f.staticDir, 'sample.md'), 'conflict');
  const buckets = outcomeBuckets();
  const code = checkRollbackScope(buckets, { scope: 'user', root: f.config }, complianceArgs(f));
  assert.notEqual(code, 0, 'legacy restoration exception must not turn into a successful attention outcome');
  assert.equal(buckets.attention.length, 0, 'legacy restoration must propagate instead of publishing an attention outcome');
  assert.match(buckets.failed[0].stderr, /destination exists.*sample\.md/);
});

test('fix1 legacy daily restoration failure is journaled before exception propagation', async (t) => {
  const f = await complianceFixture(t);
  f.migration.state = undefined;
  await writeFile(f.ledger, JSON.stringify(f.migration) + '\n');
  await writeFile(join(f.staticDir, 'sample.md'), 'conflict');
  const run = await daily(f, { apply: true, checkQuality: async () => ({ complete: true, scan: {}, coverage: {}, verdictPath: f.verdicts, scopes: [{ scope: 'user', rulesDir: f.demand }] }) });
  assert.notEqual(run.code, 0);
  assert.ok(run.result.failed.some((row) => row.stderr.includes('sample.md')));
  const notice = await readFile(join(f.dir, 'quality', 'revert-notifications.jsonl'), 'utf8').catch(() => '');
  assert.match(notice, /rule restoration failed.*sample\.md/, 'legacy restoration failure must reach the notification path before propagating');
});

test('fix2 copied activity cannot confirm another profile', async (t) => {
  const f = await fixture(t, { scope: 'project' }), b = join(f.dir, 'profile-b');
  await expose(f.config, f.root);
  await expose(b, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  const source = join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  await mkdir(join(b, 'plugins', 'store'), { recursive: true });
  await writeFile(join(b, 'plugins', 'store', 'wt-rules-on-demand_test.json'), await readFile(source));
  const result = await evaluate(f, { profileDirs: [f.config, b] });
  assert.notEqual(result.decision, 'confirm', 'copied activity must not confirm a profile that did not write it');
  assert.match(result.reason, /provenance|writer/);
});

test('fix2 copied provenance cannot follow a writer profile alias retargeting', async (t) => {
  const f = await fixture(t, { scope: 'project' }), b = join(f.dir, 'profile-b');
  await expose(b, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  const bytes = await readFile(join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json'));
  await rename(f.config, join(f.dir, 'original-profile'));
  await symlink(b, f.config, 'dir');
  await mkdir(join(b, 'plugins', 'store'), { recursive: true });
  await writeFile(join(b, 'plugins', 'store', 'wt-rules-on-demand_test.json'), bytes);
  const result = await evaluate(f, { profileDirs: [b] });
  assert.notEqual(result.decision, 'confirm', 'an observed writer identity must not change when its former path is retargeted');
});

test('fix2 hooks stamp physical writer profile and per-run capability', async () => {
  const first = engine();
  first.$.fs.stat = async (path) => ({ kind: 'dir', size: 4096, realPath: path === '/config' ? '/physical-config' : path });
  await first.call('Agent');
  const row = first.stored.get('identityActivity')['user:/config/rules-on-demand:sample.md'];
  assert.ok(Object.values(row.writers ?? {}).some((writer) => writer.profile === '/physical-config' && writer.servedAt), 'engine activity must stamp its physical writer profile');
  const runs = Object.keys(row.writers);
  const second = engine();
  await second.call('Agent');
  const next = second.stored.get('identityActivity')['user:/config/rules-on-demand:sample.md'];
  assert.ok(Object.keys(next.writers).every((run) => !runs.includes(run)), 'engine runs need distinct capability markers');
  for (const [run, writer] of Object.entries(next.writers)) {
    assert.equal(second.stored.get('identityActivity')['@capability'].writers[run].profile, writer.profile);
  }
});

test('fix2 cached writer profile survives a fresh hook context object', async () => {
  const f = engine(), identity = 'user:/config/rules-on-demand:sample.md';
  await f.call('Read');
  const context = { ...f.$, env: { get: async () => { throw new Error('cached hook must not reread its profile environment'); } } };
  await f.callWith(context, 'Agent');
  const writers = f.stored.get('identityActivity')[identity].writers;
  assert.ok(Object.values(writers).some((writer) => writer.profile === '/config' && writer.servedAt), 'a fresh hook context must retain the run writer profile and publish its serve');
});

test('fix2 registration cannot restamp another run pending serve', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(newer) });
  const f = engine(), identity = 'project:/project/.claude/rules-on-demand:sample.md';
  f.$.env.get = async (name) => name === 'CLAUDE_CONFIG_DIR' ? '/profile-a' : undefined;
  f.$.fs.list = async (path) => path === '/project/.claude/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [];
  const read = f.$.fs.read;
  f.$.fs.read = async () => (await read()).replace('\n---\n', '\n# migration-generation: a0000000-0000-0000-0000-000000000000\n---\n');
  const set = f.$.store.set;
  f.$.store.set = async (key, value) => { if (key === 'identityActivity') { throw new Error('store unavailable'); } return set(key, value); };
  await f.call('Agent');
  hooks.register(() => {}, { enabled: true });
  f.$.env.get = async (name) => name === 'CLAUDE_CONFIG_DIR' ? '/profile-b' : undefined;
  f.$.store.set = set;
  t.mock.timers.tick(600_001);
  await f.call('Read');
  const writers = f.stored.get('identityActivity')[identity].writers;
  assert.ok(Object.values(writers).every((writer) => writer.profile !== '/profile-b' || !writer.servedAt), 'registration must not attribute another run pending serve to the new profile');
});

test('fix2 unattributed observed serve remains named unknown', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer, reportedAt: newer, generations: { [f.migration.generation]: { servedAt: newer } } } } }, undefined, false);
  const result = await evaluate(f);
  assert.equal(result.decision, 'attention', 'unattributed records must be unknown rather than served');
  assert.equal(result.annotation.profiles[0].state, 'unknown');
  assert.match(result.reason, /provenance|writer/);
});

test('fix2 writer generations survive joins and budget archive round trips', () => {
  const a = { id: { writers: { first: { profile: '/profile-a', reportedAt: newer, generations: { current: { loadedAt: newer } } } } } };
  const b = { id: { writers: { second: { profile: '/profile-b', reportedAt: newer, generations: { current: { servedAt: newer } } } } } };
  const merged = delivery.joinIdentityActivity(a, b);
  assert.equal(Object.keys(merged.id.writers ?? {}).length, 2, 'activity joins must retain separate writer-run facts');
  const pieces = archiveTexts('identityActivity', merged).map(JSON.parse);
  assert.deepEqual(archives.withArchivedIdentityActivity(pieces), merged);
  assert.deepEqual(delivery.joinIdentityActivity(b, a), merged);
});

test('fix2 applying project checks persist added requirements across caller omission', async (t) => {
  const f = await fixture(t, { scope: 'project' }), b = join(f.dir, 'profile-b');
  await expose(f.config, f.root);
  await expose(b, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  const args = [rollbackScript, '--project', f.root, '--provisional-only', '--json', '--profile-dir', f.config];
  const pending = outcomeBuckets();
  assert.equal(checkRollbackScope(pending, { scope: 'project', root: f.root }, [...args, '--profile-dir', b, '--serve-window-hours', '100000']), 0);
  const later = outcomeBuckets();
  assert.equal(checkRollbackScope(later, { scope: 'project', root: f.root }, [...args, '--serve-window-hours', '0']), 0);
  assert.equal(later.confirmed.length, 0, 'a profile required by an earlier applying check must not disappear');
  const rows = (await readFile(f.ledger, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.action === 'require' && row.profiles.includes(b)), 'added project requirements must survive in the ledger');
});

test('fix2 project requirement rows are generation-bound and dry-run read-only', async (t) => {
  const f = await fixture(t, { scope: 'project' }), b = join(f.dir, 'profile-b');
  await expose(f.config, f.root);
  await expose(b, f.root);
  const before = await readFile(f.ledger, 'utf8');
  const args = [rollbackScript, '--project', f.root, '--provisional-only', '--json', '--profile-dir', f.config, '--profile-dir', b, '--serve-window-hours', '100000'];
  checkRollbackScope(outcomeBuckets(), {}, [...args, '--dry-run']);
  assert.equal(await readFile(f.ledger, 'utf8'), before);
  checkRollbackScope(outcomeBuckets(), {}, args);
  const text = await readFile(f.ledger, 'utf8');
  assert.match(text, /"action":"require"/, 'applying checks must ledger requirement extensions');
  const { provisionalMigration } = await evidenceModule();
  const wrong = { action: 'require', rule: 'sample.md', migratedAt: old, generation: 'wrong', profiles: ['/unrelated-profile'] };
  assert.ok(!provisionalMigration(text + JSON.stringify(wrong), 'sample.md').profiles.includes('/unrelated-profile'));
  const evidence = { generation: f.migration.generation, profiles: [{ dir: f.config, state: 'served', servedAt: newer, generation: f.migration.generation }] };
  assert.equal((await lifecycle.confirmMigration(f.root, 'sample.md', old, evidence)).changed, false, 'locked confirmation must recheck ledger-recorded requirements');
});

test('fix2 supplied ledger survives relocation to a shared on-demand directory', async (t) => {
  const f = await fixture(t), shared = join(f.dir, 'shared');
  await mkdir(shared);
  await rename(f.demand, join(shared, 'rules-on-demand'));
  await symlink(join(shared, 'rules-on-demand'), f.demand, 'dir');
  const run = await daily(f, { apply: true, checkQuality: completeQuality });
  assert.ok(run.result.refused.some((row) => row.rule === 'sample.md'), 'supplied profile ledger must be checked even when its on-demand directory has another owner');
  const { rollbackOutcomeLines } = await import('../scripts/rollback-output.mjs');
  assert.ok(rollbackOutcomeLines(run.result).some((line) => line.includes('sample.md') && line.includes('refused')), 'a discovered migration refused restoration must be named in daily text');
});

for (const mode of ['second-profile', 'explicit']) test(`fix2 project enumeration includes ${mode} roots`, async (t) => {
  const f = await fixture(t, { scope: 'project' }), b = join(f.dir, 'profile-b');
  await mkdir(b);
  await expose(f.config, f.root);
  await expose(b, f.root);
  if (mode === 'second-profile') {
    await mkdir(join(b, 'rules-on-demand'));
    await writeFile(join(b, 'rules-on-demand', 'followed-projects.json'), JSON.stringify([{ root: f.root, addedAt: old, by: 'fixture' }]));
  }
  const run = await daily(f, { configDirs: [f.config, b], project: mode === 'explicit' ? f.root : join(f.dir, 'elsewhere'), apply: true, checkQuality: completeQuality });
  assert.ok(run.result.reverted.some((row) => row.rule === 'sample.md' && row.scope === 'project'), 'every supplied profile followed root and explicit project must reach the provisional pass');
  assert.equal(await readFile(join(f.staticDir, 'sample.md'), 'utf8'), body);
});

test('fix2 project enumeration retains every explicit root', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  await expose(f.config, f.root);
  const run = await daily(f, { project: join(f.dir, 'elsewhere'), projects: [f.root], apply: true, checkQuality: completeQuality });
  assert.equal(run.result.reverted.length, 1, 'earlier explicit project roots must not be replaced by the last root');
});

test('fix2 intentionally excluded discovered project is named in daily text', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  const run = await daily(f, { project: join(f.dir, 'elsewhere'), apply: true, checkQuality: async () => ({ complete: true, scan: {}, coverage: {}, scopes: [{ scope: 'project', projectRoot: f.root, rulesDir: f.demand }], rollback: [{ scope: 'project', rule: 'sample.md', action: 'would revert', reason: 'fixture' }] }) });
  assert.ok(run.result.attention.some((row) => row.rule === 'sample.md' && row.root === f.root), 'an intentionally excluded discovered migration must produce named daily attention');
  const { rollbackOutcomeLines } = await import('../scripts/rollback-output.mjs');
  assert.ok(rollbackOutcomeLines(run.result).some((line) => line.includes('sample.md')));
});

test('fix2 capability in another store cannot mask later old-engine health', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { '@capability': { reportedAt: newer } } }, 'wt-rules-on-demand_new.json');
  await store(f.config, { health: { days: { '2020-01-03': { calls: 1 } } } }, 'wt-rules-on-demand_old.json');
  const result = await evaluate(f);
  assert.equal(result.decision, 'attention', 'another store capability must not erase old-engine uncertainty');
  assert.match(result.reason, /engine too old/);
});

test('fix2 later health in one store cannot borrow an earlier run capability', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { '@capability': { reportedAt: newer } }, health: { days: { '2020-01-03': { calls: 1 } } } });
  assert.equal((await evaluate(f)).decision, 'attention', 'later unattributed health must not borrow earlier run capability');
});

test('fix2 same-day old health cannot borrow another writer run capability', async (t) => {
  const f = await fixture(t);
  await store(f.config, { identityActivity: { '@capability': { reportedAt: newer, writers: { 'fixture-run': {
    profile: f.config, reportedAt: newer, healthCalls: { '2020-01-02': 1 }, healthTotals: { '2020-01-02': 1 },
  } } } }, health: { days: { '2020-01-02': { calls: 2 } } } });
  assert.equal((await evaluate(f)).decision, 'attention', 'unattributed same-day health calls must not borrow another writer run capability');
});

test('fix2 hook health attributes calls to its capable writer run', async (t) => {
  const f = await fixture(t), instance = engine();
  instance.$.env.get = async (name) => name === 'CLAUDE_CONFIG_DIR' ? f.config : undefined;
  instance.$.fs.list = async () => [];
  await instance.call('Read');
  await instance.complete();
  const health = instance.stored.get('health');
  const capabilities = instance.stored.get('identityActivity')['@capability'].writers;
  assert.ok(Object.values(capabilities).some((writer) => Object.keys(writer.healthCalls ?? {}).length), 'hook health must identify the writer run for its calls');
  for (const writer of Object.values(capabilities)) {
    assert.equal(writer.profile, f.config);
    for (const [day, calls] of Object.entries(writer.healthCalls)) assert.equal(calls, health.days[day].calls);
  }
  await store(f.config, { health, identityActivity: instance.stored.get('identityActivity') }, undefined, false);
  assert.equal((await evaluate(f)).decision, 'revert', 'a capable current writer with no loaded rule is known absence, not old-engine uncertainty');
});

test('fix2 archived capability credits only a store with its own matching writer run', async (t) => {
  const f = await fixture(t), writer = { profile: f.config, reportedAt: newer, loadedAt: newer };
  await store(f.config, { health: { days: { '2020-01-02': { calls: 1 } } }, identityActivity: {
    [`user:${f.demand}:other.md`]: { loadedAt: newer, writers: { 'fixture-run': writer } },
  } }, undefined, false);
  const archiveDir = lifecycle.qualityDataDir(f.config, {});
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, 'rod-store-archive-1-1.json'), JSON.stringify({ format: 1, key: 'identityActivity', value: {
    '@capability': { reportedAt: newer, writers: { 'fixture-run': { profile: f.config, reportedAt: newer,
      healthCalls: { '2020-01-02': 1 }, healthTotals: { '2020-01-02': 1 } } } },
  } }));
  assert.equal((await evaluate(f)).decision, 'revert', 'archived writer accounting must retain current-engine capability for its own store');
  await store(f.config, { health: { days: { '2020-01-02': { calls: 1 } } } }, 'wt-rules-on-demand_old.json');
  assert.equal((await evaluate(f)).decision, 'attention', 'archived capability must not clear another store without that writer run');
});

test('fix2 descendant transcript slug establishes project exposure with physical cwd guard', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  const { projectExposure } = await import('../scripts/project-exposure.mjs');
  await expose(f.config, join(f.root, 'child'), JSON.stringify({ cwd: join(f.root, 'child'), timestamp: newer }) + '\n');
  assert.equal((await projectExposure(f.config, f.root, old)).exposed, true, 'a descendant cwd transcript must establish exposure for its project root');
  await expose(f.config, join(f.root, 'child'), JSON.stringify({ cwd: `${f.root}-sibling`, timestamp: newer }) + '\n');
  assert.equal((await projectExposure(f.config, f.root, old)).exposed, false, 'lossy slug prefix alone must never establish exposure');
});

test('fix2 a hundred distinct cutoffs share one activity and exposure observation', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  await expose(f.config, f.root);
  const { migrationEvidence, readIdentityActivity } = await evidenceModule();
  const exposureCache = new Map(), activityCache = new Map();
  let exposureReads = 0, activityReads = 0;
  const exposureReader = async function* () { exposureReads++; yield JSON.stringify({ cwd: f.root, timestamp: newer }); };
  const activityReader = (...args) => { activityReads++; return readIdentityActivity(...args); };
  for (let n = 0; n < 100; n++) {
    const migratedAt = new Date(Date.parse(old) + n).toISOString();
    const name = `rule-${n}.md`;
    const result = await migrationEvidence({ ...f.migration, rule: name, migratedAt }, name, evaluation(f, { exposureCache, activityCache, exposureReader, activityReader }));
    assert.equal(result.decision, 'revert');
  }
  assert.equal(exposureReads, 1, 'distinct migration cutoffs must share one exposure scan');
  assert.equal(activityReads, 1, 'distinct migration cutoffs must share one injected activity scan');
});

test('fix2 raw exposure observations answer cutoffs without rereading', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  await expose(f.config, f.root);
  const { projectExposure } = await import('../scripts/project-exposure.mjs');
  const cache = new Map();
  let reads = 0;
  const reader = async function* () { reads++; yield JSON.stringify({ cwd: f.root, timestamp: newer }); yield JSON.stringify({ cwd: f.root, timestamp: '2020-01-04T00:00:00.000Z' }); };
  assert.equal((await projectExposure(f.config, f.root, '2020-01-05T00:00:00.000Z', { cache, reader })).exposed, false);
  assert.equal((await projectExposure(f.config, f.root, '2020-01-03T00:00:00.000Z', { cache, reader })).exposed, true);
  assert.equal((await projectExposure(f.config, f.root, old, { cache, reader })).exposed, true);
  assert.equal(reads, 1, 'later cutoffs must derive from complete raw exposure observations');
});

test('fix2 absent store keeps legacy failure in a mixed provisional scope', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.demand, 'legacy.md'), await readFile(join(f.demand, 'sample.md'), 'utf8'));
  await lifecycle.ledger(f.root, { action: 'migrate', rule: 'legacy.md' }, 'user');
  const buckets = outcomeBuckets();
  const code = checkRollbackScope(buckets, { scope: 'user', root: f.config }, [rollbackScript, '--user', '--config-dir', f.config, '--json', '--dry-run']);
  assert.notEqual(code, 0, 'a legacy rule must keep base missing-store failure even beside a provisional rule');
  assert.match(buckets.failed[0].stderr, /no wt-rules-on-demand store/);
});

for (const mode of ['timeout', 'overflow']) test(`fix2 child ${mode} is bounded and named failed`, () => {
  const buckets = outcomeBuckets();
  const source = mode === 'timeout' ? 'setTimeout(() => process.stdout.write("[]"), 500)' : 'process.stdout.write("x".repeat(20000))';
  const code = checkRollbackScope(buckets, { scope: 'user', root: '/profile' }, ['-e', source], { timeout: mode === 'timeout' ? 200 : 5000, maxBuffer: 1024 });
  assert.notEqual(code, 0, 'child timeout or output overflow must fail the daily scope');
  assert.match(buckets.failed[0].error, mode === 'timeout' ? /ETIMEDOUT|timeout/i : /ENOBUFS|maxBuffer|buffer/i, 'child resource failure must keep its named cause');
});

for (const mode of ['malformed', 'unreadable', 'dangling']) test(`fix2 ${mode} existing daily report produces one startup line`, async (t) => {
  const f = await fixture(t), dataDir = lifecycle.qualityDataDir(f.config, {});
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'daily-rollback-latest.json');
  if (mode === 'malformed') await writeFile(path, '{bad');
  else if (mode === 'dangling') await symlink(join(f.dir, 'absent-report'), path);
  else await mkdir(path);
  const { dailyRollbackLines } = await import('../hooks/revert-notifications.mjs');
  const text = await dailyRollbackLines(f.config, dataDir);
  assert.match(text, /daily-rollback-latest\.json.*unreadable|unreadable.*daily-rollback-latest\.json/, 'existing unreadable daily report must be named at SessionStart');
  assert.equal(text.trim().split('\n').length, 1, 'duplicate report locations must produce one failure line');
  await rm(path, { recursive: true });
  assert.equal(await dailyRollbackLines(f.config, dataDir), '', 'absent reports stay silent');
});

async function retargetedProfile(t) {
  const f = await fixture(t, { scope: 'project', profileAlias: true }), b = join(f.dir, 'profile-b');
  await expose(b, f.root);
  await store(b, { identityActivity: { [f.identity]: { servedAt: newer } } });
  await rm(f.selected);
  await symlink(b, f.selected, 'dir');
  return { ...f, b };
}

const servedEvidence = (f, dir) => ({ generation: f.migration.generation, profiles: [{ dir, state: 'served', servedAt: newer, generation: f.migration.generation }] });

test('fix3 migration pins physical profiles beside lexical aliases', async (t) => {
  const f = await fixture(t, { scope: 'project', profileAlias: true });
  const physical = await realpath(f.config);
  assert.ok(f.migration.profileIdentities?.some((row) => row.path === f.selected && row.physical === physical), 'migration must pin the selected alias physical profile');
  const user = await fixture(t, { mirrors: ['link'] });
  assert.deepEqual(user.migration.profileIdentities.map((row) => row.physical), await Promise.all([user.config, ...user.mirrorDirs].map((dir) => realpath(dir))));
});

test('fix3 retargeted profile alias cannot confirm from replacement native serves', async (t) => {
  const f = await retargetedProfile(t);
  const result = await evaluate(f, { configDir: f.selected, profileDirs: [f.selected] });
  assert.equal(result.decision, 'attention', 'replacement profile native serves must not confirm the original required profile');
  assert.match(result.reason, /profile identity changed since migration/);
  for (const path of [f.selected, f.config, f.b]) assert.ok(result.reason.includes(path));
  const buckets = outcomeBuckets();
  assert.equal(checkRollbackScope(buckets, { scope: 'project', root: f.root }, [rollbackScript, '--project', f.root, '--provisional-only', '--json', '--profile-dir', f.selected, '--serve-window-hours', '0']), 0);
  assert.equal(buckets.confirmed.length, 0);
  assert.match(buckets.attention[0].reason, /profile identity changed since migration/);
});

test('fix3 locked confirmation rejects a retargeted required alias', async (t) => {
  const f = await retargetedProfile(t), before = await readFile(f.ledger, 'utf8');
  const result = await lifecycle.confirmMigration(f.root, 'sample.md', old, servedEvidence(f, f.b));
  assert.equal(result.changed, false, 'locked confirmation must preserve the migration-time physical profile');
  assert.match(result.skipped, /profile identity changed since migration/);
  assert.equal(await readFile(f.ledger, 'utf8'), before);
});

test('fix3 extending requirements preserves old identities and pins new aliases', async (t) => {
  const f = await retargetedProfile(t), alias = join(f.dir, 'added-profile');
  await symlink(f.b, alias, 'dir');
  await lifecycle.requireMigrationProfiles(f.root, 'sample.md', old, f.migration.generation, [f.selected, alias]);
  const text = await readFile(f.ledger, 'utf8'), { provisionalMigration } = await evidenceModule();
  const current = provisionalMigration(text, 'sample.md');
  const original = await realpath(f.config), added = await realpath(f.b);
  assert.ok(current.profileIdentities?.some((row) => row.path === f.selected && row.physical === original), 'require must not replace the original physical identity with the retargeted alias');
  const required = text.trim().split('\n').map(JSON.parse).find((row) => row.action === 'require');
  assert.ok(required.profileIdentities.some((row) => row.path === alias && row.physical === added));
  assert.equal(required.generation, f.migration.generation);
});

test('fix3 a generation-bound added alias retains its identity after retargeting', async (t) => {
  const f = await fixture(t, { scope: 'project' }), b = join(f.dir, 'profile-b'), alias = join(f.dir, 'added-profile');
  await mkdir(b);
  await symlink(b, alias, 'dir');
  await lifecycle.requireMigrationProfiles(f.root, 'sample.md', old, f.migration.generation, [alias]);
  await rm(alias);
  await symlink(f.config, alias, 'dir');
  await expose(f.config, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  const { provisionalMigration, migrationEvidence } = await evidenceModule();
  const migration = provisionalMigration(await readFile(f.ledger, 'utf8'), 'sample.md');
  const result = await migrationEvidence(migration, 'sample.md', evaluation(f));
  assert.equal(result.decision, 'attention', 'retargeting an added requirement must not collapse it into a served profile');
  assert.match(result.reason, /profile identity changed since migration/);
  assert.equal((await lifecycle.confirmMigration(f.root, 'sample.md', old, servedEvidence(f, f.config))).changed, false);
});

for (const mode of ['evidence', 'locked']) test(`fix3 ${mode} confirmation names missing migration identities`, async (t) => {
  const f = await fixture(t);
  delete f.migration.profileIdentities;
  await writeFile(f.ledger, JSON.stringify(f.migration) + '\n');
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  if (mode === 'evidence') {
    const result = await evaluate(f);
    assert.equal(result.decision, 'attention', 'a provisional migration without physical identities cannot confirm');
    assert.match(result.reason, /migration profile identities unknown/);
  } else {
    const result = await lifecycle.confirmMigration(f.root, 'sample.md', old, servedEvidence(f, f.config), { scope: 'user' });
    assert.equal(result.changed, false, 'locked confirmation cannot infer missing migration-time identities');
    assert.match(result.skipped, /migration profile identities unknown/);
  }
});

test('fix3 replacing a directory at the same pathname cannot confirm', async (t) => {
  const f = await fixture(t, { scope: 'project' });
  await rename(f.config, join(f.dir, 'original-profile'));
  await expose(f.config, f.root);
  await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
  assert.equal((await evaluate(f)).decision, 'attention', 'a replacement directory at the same realpath must not inherit the required profile identity');
  const result = await lifecycle.confirmMigration(f.root, 'sample.md', old, servedEvidence(f, f.config));
  assert.equal(result.changed, false);
  assert.match(result.skipped, /profile identity changed since migration/);
});

test('fix3 unchanged plain and aliased project profiles still confirm', async (t) => {
  for (const profileAlias of [false, true]) {
    const f = await fixture(t, { scope: 'project', profileAlias });
    await expose(f.config, f.root);
    await store(f.config, { identityActivity: { [f.identity]: { servedAt: newer } } });
    const result = await evaluate(f, { configDir: f.selected, profileDirs: [f.selected] });
    assert.equal(result.decision, 'confirm');
    assert.equal((await lifecycle.confirmMigration(f.root, 'sample.md', old, result.annotation)).changed, true);
  }
});

test('fix3 successful restoration has one daily text line and no duplicate startup revert', async (t) => {
  const f = await fixture(t), { result } = await daily(f, { apply: true });
  const { rollbackOutcomeLines } = await import('../scripts/rollback-output.mjs');
  const lines = rollbackOutcomeLines(result);
  assert.equal(lines.length, 1, 'successful restoration must print a default daily outcome line');
  assert.match(lines[0], /user sample\.md: reverted: no observed load or serve/);
  const { dailyRollbackLines, revertNotificationLine } = await import('../hooks/revert-notifications.mjs');
  const dataDir = join(f.dir, 'quality');
  assert.equal(await dailyRollbackLines(f.config, dataDir), '', 'startup must not repeat the revert already carried by its notification line');
  assert.match(await revertNotificationLine(f.config, dataDir), /1 recorded revert notification\(s\); latest user sample.md/);
});

test('fix5 confirmation rejects the first incomplete profiles snapshot', async (t) => {
  const f = await fixture(t), before = await readFile(f.ledger, 'utf8');
  const valid = servedEvidence(f, f.config), incomplete = valid.profiles.map((row) => ({ ...row, state: 'not loaded', servedAt: undefined }));
  let profilesReads = 0, generationReads = 0;
  const evidence = {
    get profiles() { return ++profilesReads === 1 ? incomplete : valid.profiles; },
    get generation() { generationReads++; return valid.generation; },
  };
  assert.deepEqual(await lifecycle.confirmMigration(f.root, 'sample.md', old, evidence, { scope: 'user' }),
    { changed: false, skipped: 'serve evidence incomplete' }, 'confirmation must validate the profiles snapshot it would ledger');
  assert.equal(profilesReads, 1, 'profiles are read once');
  assert.equal(generationReads, 1, 'generation is read once');
  assert.equal(await readFile(f.ledger, 'utf8'), before, 'incomplete evidence must write no confirm row');
});

test('fix5 confirmation writes only the first complete profiles snapshot', async (t) => {
  const f = await fixture(t), valid = servedEvidence(f, f.config);
  let profilesReads = 0, generationReads = 0;
  const evidence = {
    get profiles() { return ++profilesReads === 1 ? valid.profiles : []; },
    get generation() { return ++generationReads === 1 ? valid.generation : 'other-generation'; },
  };
  assert.deepEqual(await lifecycle.confirmMigration(f.root, 'sample.md', old, evidence, { scope: 'user' }),
    { changed: true }, 'confirmation must not replace the complete snapshot with a second read');
  assert.equal(profilesReads, 1);
  assert.equal(generationReads, 1);
  const confirmation = (await readFile(f.ledger, 'utf8')).trim().split('\n').map(JSON.parse).find((row) => row.action === 'confirm');
  assert.deepEqual(confirmation.profiles, valid.profiles);
  assert.equal(confirmation.generation, valid.generation);
});

for (const key of ['hasOwnProperty', 'toString', 'constructor']) test(`fix5 joins ${key} as a default field`, () => {
  assert.equal(delivery.joinServed({ count: 9 }, { count: 10 }).count, 10, 'an owned special field keeps its combiner');
  const a = { [key]: 'alpha' }, b = { [key]: 'zeta' };
  const sessionJoin = (x, y) => delivery.sumSessions([{ session: x }, { session: y }]).session;
  for (const combine of [delivery.joinContexts, delivery.joinServed, sessionJoin]) {
    assert.equal(combine(a, b)[key], 'zeta', 'inherited map names must use the default greater JSON value');
    assert.equal(combine(b, a)[key], 'zeta');
  }
});

test('fix5 uncertainty failure retains the already observed profile annotation', async (t) => {
  const f = await fixture(t);
  await store(f.config, { health: { days: { '2020-01-02': null } } }, undefined, false);
  const result = await evaluate(f);
  assert.equal(result.decision, 'attention');
  assert.match(result.reason, /Cannot read properties of null/);
  assert.deepEqual(result.annotation.profiles, [{ dir: await realpath(f.config), state: 'not loaded', generation: f.migration.generation }],
    'a profile annotation must survive a subsequent uncertainty error');
});

const manyWriters = (profile) => Object.fromEntries(Array.from({ length: 140_000 }, (_, index) => [`run-${index}`, { profile, reportedAt: newer }]));

for (const source of ['store', 'archive']) test(`fix5 large writer ${source} retains observations without unreadable evidence`, async (t) => {
  const f = await fixture(t), value = { '@capability': { writers: manyWriters(f.config) } };
  if (source === 'store') await store(f.config, { identityActivity: value }, undefined, false);
  else {
    const dir = lifecycle.qualityDataDir(f.config, {});
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'rod-store-archive-1-1.json'), JSON.stringify({ key: 'identityActivity', format: 1, value }));
    await store(f.config, { identityActivity: { '@capability': { writers: { 'run-0': { profile: f.config, reportedAt: newer } } } } }, undefined, false);
  }
  const { readIdentityActivity } = await evidenceModule(), result = await readIdentityActivity(f.config);
  assert.deepEqual(result.unreadable, [], 'writer cardinality must not become an unreadable RangeError');
  assert.equal(result.observations.length, 1, 'the store observation must be retained');
  assert.equal(result.observations[0].capabilities.length, source === 'store' ? 140_000 : 2);
});
