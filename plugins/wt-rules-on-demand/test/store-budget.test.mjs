import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostStore, hookFixture, atLimitStore, readerTotals, HOST_STORE_LIMIT, archivedUnits, shrinkDeliveries } from './store-host-fake.mjs';
import { STORE_LIMIT, STORE_BUDGETS, STORE_OVERHEAD, STORE_MARGIN, FOREIGN_KEYS_BUDGET, EVICT_TO, VERDICTS, ARCHIVE_RETENTION_BYTES,
  VERDICT_ARCHIVE, STORE_ARCHIVE, archiveTexts, retentionVictims, shrink, jsonLength } from '../hooks/store-budget.js';
import { mergeSessions, sumSessions, sumServed, archivedSegments } from '../scripts/delivery-join.mjs';
import { measureInputs } from '../scripts/quality-check.mjs';
import { main as reconcile } from '../scripts/serve-verdict-reconcile.mjs';
import { newJudgeOutput } from '../scripts/judge-output.mjs';

const failures = (logs) => logs.filter((line) => /write failed|sweep failed/.test(line));
const minus = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
const listArchives = async (f, family = STORE_ARCHIVE) => (await readdir(f.quality).catch(() => [])).filter((name) => name.startsWith(family.prefix));
const keySizes = (store) => Object.fromEntries([...store.map].map(([key, value]) => [key, jsonLength(value)]));

async function sandbox(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// The act every reader-visible test performs: one Bash call that serves the bash-command rule and is judged by it.
const act = (f, agentId) => f.call({ command: 'git push origin main', ...(agentId ? { agentId } : {}) });

// What one act adds for each reader, measured on an empty store where nothing can be evicted.
async function actDelta(t) {
  const store = hostStore();
  const f = await hookFixture(await sandbox(t, 'rod-delta-'), store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  return minus(await readerTotals(f, store.snapshot()), before);
}
async function identityIn(root) { return (await hookFixture(root, hostStore())).identity; }

test('a store at the host limit takes the next act and every reader sees before plus that act, exactly', async (t) => {
  const delta = await actDelta(t);
  assert.ok(['served', 'verdictRows', 'deliveries', 'joinedRows', 'applicable', 'followed', 'servedTotal'].every((key) => delta[key] >= 1), `the act must be visible to every reader: ${JSON.stringify(delta)}`);
  const root = await sandbox(t, 'rod-limit-');
  const store = hostStore(atLimitStore(await identityIn(root)));
  assert.equal(store.size(), HOST_STORE_LIMIT);
  const f = await hookFixture(root, store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.deepEqual(failures(f.logs), [], 'no write may fail on the store size');
  assert.ok(store.size() <= HOST_STORE_LIMIT);
  assert.deepEqual(minus(await readerTotals(f, store.snapshot()), before), delta);
});

test('budgets: every key the hook writes is named, measured as JSON text, and the sum leaves the stated margin', () => {
  assert.equal(STORE_LIMIT, HOST_STORE_LIMIT);
  assert.deepEqual(Object.keys(STORE_BUDGETS).sort(), [VERDICTS, 'health', 'served', 'sessions'].sort());
  const total = Object.values(STORE_BUDGETS).reduce((sum, budget) => sum + budget, 0);
  assert.equal(total + FOREIGN_KEYS_BUDGET + STORE_OVERHEAD + STORE_MARGIN, STORE_LIMIT);
  assert.ok(STORE_MARGIN >= 600_000, `margin ${STORE_MARGIN}`);
  // Every key filled exactly to its budget (and foreign keys to their allowance) is still under the host limit.
  const full = Object.fromEntries(Object.entries(STORE_BUDGETS).map(([name, budget]) => [name, 'x'.repeat(budget - 2)]));
  full.foreign = 'x'.repeat(FOREIGN_KEYS_BUDGET - jsonLength('foreign') - 4);
  assert.ok(JSON.stringify(full).length <= STORE_LIMIT - STORE_MARGIN);
});

test('every hook store write goes through the budgeted path', async () => {
  const source = await readFile(new URL('../hooks/hooks.js', import.meta.url), 'utf8');
  assert.equal(source.match(/\$\.store\.set\(/g).length, 1, 'the only direct store write is the budgeted one');
  assert.match(source, /async function setBounded\(\$, name, value, budget, keep\) \{[^]*?await \$\.store\.set\(name, kept\)/);
  for (const match of source.matchAll(/setWithin\(\$, ([^,)]+)/g)) assert.ok(['VERDICTS', "'sessions'", "'served'", "'health'", 'name'].includes(match[1]), match[0]);
});

test('a store at the limit recovers on the first write of any kind: journal, turn close, health alone', async (t) => {
  for (const kind of ['tool.call', 'turn.complete', 'health']) {
    const root = await sandbox(t, `rod-kind-${kind}-`);
    const store = hostStore(atLimitStore(await identityIn(root)));
    const f = await hookFixture(root, store, kind === 'health' ? { sessionId: null } : {});
    if (kind === 'tool.call') await act(f);
    else await f.handlers.get('turn.complete')(f.$, { cwd: f.project }, async () => ({}));
    assert.deepEqual(failures(f.logs), [], kind);
    // Shrinking writes go first: the host never had to refuse a write on the way.
    assert.equal(store.refusals(), 0, `${kind}: host refusals`);
    const sizes = keySizes(store);
    for (const [name, budget] of Object.entries(STORE_BUDGETS)) assert.ok((sizes[name] ?? 0) <= budget, `${kind}: ${name} ${sizes[name]} over ${budget}`);
    if (kind === 'health') assert.equal(store.map.get('health').days[new Date().toISOString().slice(0, 10)]?.calls, 1);
    assert.ok((await listArchives(f, VERDICT_ARCHIVE)).length >= 1, `${kind}: the over-budget verdicts were archived`);
  }
});

test('a store another writer filled to the limit after the first sweep still takes the next act', async (t) => {
  const root = await sandbox(t, 'rod-refusal-');
  const store = hostStore();
  const f = await hookFixture(root, store);
  await act(f);
  const before = await readerTotals(f, store.snapshot());
  const full = atLimitStore(f.identity, { sessionId: 'other-session' });
  for (const [key, value] of Object.entries(full)) if (key !== 'sessions') store.map.set(key, value);
  store.map.set('sessions', { ...full.sessions, ...store.map.get('sessions') });
  const grown = minus(await readerTotals(f, store.snapshot()), before);
  await act(f, 'second-agent');
  assert.deepEqual(failures(f.logs), []);
  const after = minus(await readerTotals(f, store.snapshot()), before);
  const delta = await actDelta(t);
  assert.deepEqual(after, Object.fromEntries(Object.keys(delta).map((key) => [key, grown[key] + delta[key]])));
});

test('evicted sessions are archived oldest first with hysteresis, the context being written last, and no archive per act after', async (t) => {
  const root = await sandbox(t, 'rod-hysteresis-');
  const sessions = atLimitStore(await identityIn(root), { verdictChars: 10, sessionChars: STORE_BUDGETS.sessions - 20_000 }).sessions;
  // Just under the budget: the sweep leaves it, and this act's own rows push it over, inside the journal write.
  const main = sessions['sample-session'].contexts[0];
  main.pad = '';
  main.pad = 'p'.repeat(STORE_BUDGETS.sessions - 50 - jsonLength(sessions));
  const store = hostStore({ sessions });
  const f = await hookFixture(root, store);
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  const size = jsonLength(store.map.get('sessions'));
  assert.ok(size <= STORE_BUDGETS.sessions * EVICT_TO, `sessions ${size} after eviction`);
  const archived = await Promise.all((await listArchives(f)).map(async (name) => JSON.parse(await readFile(join(f.quality, name), 'utf8'))));
  const archivedKeys = archived.flatMap(archivedUnits).map((unit) => unit.key).filter((key) => key !== null);
  const live = Object.keys(store.map.get('sessions')['sample-session'].contexts);
  // The main context is the OLDEST one, but this act writes it: it moves last, so it stays live with its rows.
  assert.ok(!archivedKeys.includes('0') && live.includes('0'), 'the context being written moves last');
  assert.equal(store.map.get('sessions')['sample-session'].contexts[0].complianceInjected.length, 831);
  // Agent contexts were created oldest first: everything archived is older than everything kept.
  const order = Object.keys(sessions['sample-session'].contexts).filter((key) => key !== '0');
  const newestArchived = Math.max(...archivedKeys.map((key) => order.indexOf(key)));
  const oldestKept = Math.min(...live.filter((key) => order.includes(key)).map((key) => order.indexOf(key)));
  assert.ok(archivedKeys.length && newestArchived < oldestKept, `${newestArchived} < ${oldestKept}`);
  const count = (await listArchives(f)).length;
  for (let index = 0; index < 5; index++) await act(f, `steady-${index}`);
  assert.equal((await listArchives(f)).length, count, 'no archive per act once under the hysteresis target');
});

test('a store write refused without committing keeps the archive it wrote, and every reader counts those rows once', async (t) => {
  const root = await sandbox(t, 'rod-refused-');
  const full = atLimitStore(await identityIn(root), { verdictChars: 10, sessionChars: STORE_BUDGETS.sessions + 20_000 });
  const store = hostStore({ sessions: full.sessions }, { refuse: (key) => (key === 'sessions' ? 'disk unavailable' : null) });
  const f = await hookFixture(root, store);
  const before = await readerTotals(f, store.snapshot());
  await f.handlers.get('turn.complete')(f.$, { cwd: f.project }, async () => ({}));
  assert.match(f.logs.join('\n'), /journal write failed: disk unavailable/);
  assert.ok((await listArchives(f)).length >= 1, 'the archive stays: a rejected write may have committed');
  assert.equal(jsonLength(store.map.get('sessions')), jsonLength(full.sessions), 'the live sessions are untouched');
  assert.deepEqual(await readerTotals(f, store.snapshot()), before);
});

test('a single context pushed over the sessions budget by this act is still written: archived, restarted, summed by readers', async (t) => {
  const delta = await actDelta(t);
  const root = await sandbox(t, 'rod-huge-');
  const identity = await identityIn(root);
  const big = atLimitStore(identity, { verdictChars: 10, sessionChars: 10 });
  const main = big.sessions['sample-session'].contexts[0];
  big.sessions['sample-session'].contexts = { 0: main };
  delete big[VERDICTS];
  // One context just under the budget: the sweep leaves it, and this act's own rows push it over at the journal write.
  main.triggerErrors = [{ rule: 'sample.md', kind: 'tool', error: '', at: '2026-09-30T00:00:00.000Z', channel: 'tool.call' }];
  main.triggerErrors[0].error = 'x'.repeat(STORE_BUDGETS.sessions - 50 - jsonLength(big.sessions));
  const store = hostStore(big);
  const f = await hookFixture(root, store);
  const before = await readerTotals(f, store.snapshot());
  await act(f);
  assert.deepEqual(failures(f.logs), []);
  const live = store.map.get('sessions')['sample-session'].contexts[0];
  assert.equal(live.triggerErrors, undefined, 'the live context restarted');
  assert.ok(jsonLength(store.map.get('sessions')) <= STORE_BUDGETS.sessions);
  const after = await readerTotals(f, store.snapshot());
  assert.deepEqual(minus(after, before), delta);
  // The restarted context is a new segment: writing it again never hides the segment that moved out.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(f);
  const later = await readerTotals(f, store.snapshot());
  assert.deepEqual(Object.keys(later).filter((key) => later[key] < after[key]), [], `no reader total goes down: ${JSON.stringify(minus(later, after))}`);
});

test('archive retention keeps the same volume of history as the previous 14 x 3.5 MB rotation, newest first', () => {
  const files = (family, count, size) => Array.from({ length: count }, (_, i) => ({ name: `${family.prefix}${1000 + i}-${i}${family.suffix}`, size }));
  assert.deepEqual(retentionVictims(files(VERDICT_ARCHIVE, 17, 3_500_000), VERDICT_ARCHIVE).sort(), files(VERDICT_ARCHIVE, 3, 0).map((item) => item.name).sort());
  // The smaller budget rotates more often; history is kept by volume, so 1.2 MB files keep about 40 of them.
  assert.equal(retentionVictims(files(VERDICT_ARCHIVE, 50, 1_200_000), VERDICT_ARCHIVE).length, 50 - Math.floor(ARCHIVE_RETENTION_BYTES / 1_200_000));
  assert.deepEqual(retentionVictims([{ name: `${VERDICT_ARCHIVE.prefix}1-1${VERDICT_ARCHIVE.suffix}`, size: 90_000_000 }], VERDICT_ARCHIVE), [], 'the newest is always kept');
  assert.equal(retentionVictims(files(VERDICT_ARCHIVE, 20, 0), VERDICT_ARCHIVE).length, 20 - Math.floor(ARCHIVE_RETENTION_BYTES / VERDICT_ARCHIVE.unknownSize));
  assert.deepEqual(retentionVictims([{ name: 'other.jsonl', size: 1e9 }, ...files(VERDICT_ARCHIVE, 1, 1)], VERDICT_ARCHIVE), []);
  // Store-key archives hold the only copy of what left the store: none is ever a retention victim, whatever the volume.
  assert.deepEqual(retentionVictims(files(STORE_ARCHIVE, 40, 3_000_000), STORE_ARCHIVE), []);
});

test('archive parts stay under the host file-write limit and keep every evicted row', () => {
  const lines = Array.from({ length: 4_000 }, (_, i) => JSON.stringify({ verdictId: `v-${i}`, evidence: 'é'.repeat(800) })).join('\n') + '\n';
  const parts = archiveTexts(VERDICTS, lines);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(new TextEncoder().encode(part).length <= 3_000_000);
  assert.equal(parts.join(''), lines);
  const contexts = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`agent:${i}`, { complianceInjected: [{ deliveryId: `d-${i}`, pad: 'é'.repeat(10_000) }] }]));
  const units = Object.entries(contexts).map(([key, context]) => ({ sessionId: 's', first: 'a', last: 'b', key, context: { ...context, seg: key } }));
  const sessions = archiveTexts('sessions', units).map((text) => JSON.parse(text));
  assert.ok(sessions.length > 1);
  assert.deepEqual(Object.keys(sumSessions(archivedSegments(sessions, 'sessions')).s.contexts).sort(), Object.keys(contexts).sort());
});

test('readers sum a context split between archives and the live store; mirror copies still merge without double counting', () => {
  const identity = 'user:/r:sample.md';
  const older = { s: { first: '2026-01-01', last: '2026-01-02', contexts: { 0: { seg: 'one', served: { 'sample.md': 2 }, servedIdentity: { [identity]: 2 }, suppressedCap: { x: 1 },
    governedActs: [{ rule: 'sample.md', ruleIdentity: identity, at: '2026-01-01', last: '2026-01-02', count: 3 }],
    complianceInjected: [{ deliveryId: 't-1' }, { deliveryId: 't-2' }], triggerErrors: [{ at: '2026-01-01' }], lastClose: { token: 't', seq: 5, at: '2026-01-02' } } } } };
  const live = { s: { first: '2026-01-03', last: '2026-01-04', contexts: { 0: { seg: 'two', served: { 'sample.md': 1 }, servedIdentity: { [identity]: 1 }, suppressedCap: {},
    governedActs: [{ rule: 'sample.md', ruleIdentity: identity, at: '2026-01-03', last: '2026-01-04', count: 1 }],
    complianceInjected: [{ deliveryId: 't-3' }], lastClose: { token: 't', seq: 9, at: '2026-01-04' } } } } };
  const summed = sumSessions([older, live]);
  const ctx = summed.s.contexts[0];
  assert.deepEqual(ctx.served, { 'sample.md': 3 });
  assert.deepEqual(ctx.servedIdentity, { [identity]: 3 });
  assert.deepEqual(ctx.suppressedCap, { x: 1 });
  assert.deepEqual(ctx.governedActs, [{ rule: 'sample.md', ruleIdentity: identity, at: '2026-01-01', last: '2026-01-04', count: 4 }]);
  assert.deepEqual(ctx.complianceInjected.map((item) => item.deliveryId), ['t-1', 't-2', 't-3']);
  assert.equal(ctx.triggerErrors.length, 1);
  assert.deepEqual(ctx.lastClose, { token: 't', seq: 9, at: '2026-01-04' });
  assert.deepEqual([summed.s.first, summed.s.last], ['2026-01-01', '2026-01-04']);
  // Copies of ONE segment (an archive written before a store write that never landed, or two processes archiving the
  // same value) count once, whatever their order: the newest copy, which holds the older one's rows.
  const grown = { s: { ...live.s, contexts: { 0: { ...live.s.contexts[0], served: { 'sample.md': 4 }, last: '2026-01-05' } } } };
  for (const order of [[older, live, grown, live], [grown, live, older], [live, older, grown]]) {
    assert.deepEqual(sumSessions(order).s.contexts[0].served, { 'sample.md': 6 }, 'segment one plus the newest copy of segment two');
  }
  // A unit without a segment (written before segments) is one segment per session and context.
  const legacy = (served) => ({ s: { first: 'x', contexts: { 0: { served: { r: served }, last: `2026-01-0${served}` } } } });
  assert.deepEqual(sumSessions([legacy(1), legacy(2)]).s.contexts[0].served, { r: 2 });
  assert.deepEqual(sumServed([{ r: { count: 2, last: 'b' } }, { r: { count: 1, last: 'a' } }]).r.count, 2);
  assert.deepEqual(sumServed([{ r: { count: 2, last: 'b', seg: 'x' } }, { r: { count: 3, last: 'c', seg: 'y' } }, { r: { count: 2, last: 'b', seg: 'x' } }]).r.count, 5);
  // Two COPIES of one store (mirror directories) are not segments: the copy merge keeps one of each.
  const copies = mergeSessions([{ sessions: live }, { sessions: live }]).s.contexts[0];
  assert.deepEqual(copies.served, { 'sample.md': 1 });
  assert.equal(copies.complianceInjected.length, 1);
});

test('the shrink plan never loses a row: kept plus evicted is the input, for every budgeted key', () => {
  const sessions = atLimitStore('id', { verdictChars: 10, sessionChars: 400_000 }).sessions;
  let fresh = 0;
  const { value, evicted } = shrink('sessions', sessions, 200_000, { id: 'sample-session', ck: '0', newSeg: () => `new-${fresh++}` });
  assert.ok(jsonLength(value) <= 200_000);
  assert.deepEqual([...shrinkDeliveries(evicted), ...shrinkDeliveries(value)].sort(), shrinkDeliveries(sessions).sort());
  const served = Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`r${i}`, { count: 1, last: `2026-01-${String(i % 28 + 1).padStart(2, '0')}` }]));
  const cut = shrink('served', served, 50_000);
  assert.deepEqual(Object.keys({ ...cut.value, ...cut.evicted }).sort(), Object.keys(served).sort());
  assert.ok(Math.max(...Object.values(cut.evicted).map((item) => Date.parse(item.last))) <= Math.min(...Object.values(cut.value).map((item) => Date.parse(item.last))));
  // The context being written moves last even when another writer's clock left newer stamps on the others.
  const context = (last) => ({ last, complianceInjected: [{ deliveryId: last, pad: 'p'.repeat(100_000) }] });
  const skewed = { s: { contexts: { a: context('2026-01-01'), b: context('2026-02-01'), c: context('2026-03-01') } } };
  const kept = shrink('sessions', skewed, 250_000, { id: 's', ck: 'a', newSeg: () => 'new' });
  assert.deepEqual(Object.keys(kept.value.s.contexts), ['a']);
  assert.deepEqual(archivedUnits({ key: 'sessions', value: kept.evicted }).map((unit) => unit.key).sort(), ['b', 'c']);
  const text = 'a\nb\nc\n';
  assert.deepEqual(shrink(VERDICTS, text, 8, { line: 'c\n' }), { value: 'c\n', evicted: 'a\nb\n' });
});

async function splitContextConfig(t) {
  const root = await sandbox(t, 'rod-split-');
  const f = await hookFixture(root, hostStore());
  const now = new Date().toISOString();
  const store = { sessions: { s: { first: now, last: now, contexts: { 0: { seg: 'live', served: {}, suppressedCap: {}, complianceInjected: [],
    governedActs: [{ rule: 'sample.md', ruleIdentity: f.identity, at: now, last: now, count: 1 }] } } } },
  served: { 'sample.md': { count: 2, last: now, byChannel: { 'tool.call': 2 }, seg: 'live' } }, 'compliance-verdicts-jsonl': '' };
  const storePath = join(f.config, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  await mkdir(join(f.config, 'plugins', 'store'), { recursive: true });
  await writeFile(storePath, JSON.stringify(store));
  await mkdir(f.quality, { recursive: true });
  const archive = (n, key, value, format = 1) => writeFile(join(f.quality, `${STORE_ARCHIVE.prefix}1000-${n}${STORE_ARCHIVE.suffix}`), JSON.stringify({ format, key, archivedAt: now, value }));
  await archive(1, 'sessions', [{ sessionId: 's', first: now, last: now, key: '0', context: { seg: 'old', complianceInjected: [{ rule: 'sample.md', ruleIdentity: f.identity, at: now, deliveryId: 'tok-1', deliverySeq: 1, servingSeq: 1 }] } }], 2);
  await archive(2, 'served', { 'sample.md': { count: 3, last: now, byChannel: { 'tool.call': 3 }, seg: 'old' } });
  await archive(3, 'sessions', { gone: { first: now, last: now, contexts: { 'agent:a': { triggerErrors: [{ at: now }] } } } });
  return { ...f, storePath };
}

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const rollback = (f, extra) => {
  const run = spawnSync(process.execPath, [script('rollback-check.mjs'), '--user', '--config-dir', f.config, ...extra, '--dry-run', '--json'],
    { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: '', CLAUDE_PLUGIN_ROOT: '' } });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout)[0];
};
const report = (f, extra) => {
  const run = spawnSync(process.execPath, [script('compliance-report.mjs'), ...extra, '--config-dir', f.config, '--rules-dir', join(f.config, 'rules-on-demand'), '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout)['sample.md'];
};
const UNPROVEN = 'trigger miss unproven: store cannot show non-delivery';

test('rollback-check reads a delivery that only an archive holds, so the governed act is not an unproven miss', async (t) => {
  const f = await splitContextConfig(t);
  assert.notEqual(rollback(f, ['--store', f.storePath, '--store-archives', f.quality]).reason, UNPROVEN);
  assert.notEqual(rollback(f, []).reason, UNPROVEN, 'the default store reads the config dir archives');
});

test('compliance-report sums archived served counters and reads archived deliveries', async (t) => {
  const f = await splitContextConfig(t);
  for (const extra of [['--store', f.storePath, '--store-archives', f.quality], []]) {
    const row = report(f, extra);
    assert.equal(row.served, 5);
    assert.equal(row.unjudged, 1, 'the delivery only an archive holds is joined');
  }
});

test('a named store snapshot reads store-key archives only from the directory named beside it, never the config dir', async (t) => {
  const f = await splitContextConfig(t);
  const row = report(f, ['--store', f.storePath]);
  assert.equal(row.served, 2, 'the snapshot alone: the config dir archives belong to another store state');
  assert.equal(row.unjudged ?? 0, 0);
  assert.equal(rollback(f, ['--store', f.storePath]).reason, UNPROVEN, 'no archived delivery joins a named snapshot');
  const elsewhere = join(f.config, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  assert.equal(report(f, ['--store', f.storePath, '--store-archives', elsewhere]).served, 2);
});

test('serve-verdict-reconcile reads store archives from its archive directory only: a named snapshot without --archives reads none', async (t) => {
  const f = await splitContextConfig(t);
  const serves = async (args) => {
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(line);
    try { assert.equal(await reconcile([...args, '--json']), 0); } finally { console.log = log; }
    return JSON.parse(lines.join('\n')).result.serves;
  };
  assert.equal(await serves(['--store', f.storePath]), 0);
  assert.equal(await serves(['--store', f.storePath, '--archives', f.quality]), 1);
  assert.equal(await serves(['--config-dir', f.config]), 1);
});

test('quality-check counts archived sessions and their trigger errors with the live ones', async (t) => {
  const f = await splitContextConfig(t);
  const inputs = await measureInputs([f.config], [], join(f.root ?? f.config, 'measures'));
  assert.deepEqual(Object.keys(inputs.store.profiles[0].sessions).sort(), ['gone', 's']);
  assert.equal(inputs.store.sessions.gone.contexts['agent:a'].triggerErrors.length, 1);
});

test('judge output refuses a store archive name, as it refuses every other rollback input', async (t) => {
  const root = await sandbox(t, 'rod-judge-');
  await assert.rejects(() => newJudgeOutput(join(root, 'out', `${STORE_ARCHIVE.prefix}1-2${STORE_ARCHIVE.suffix}`), 'cases.jsonl', join(root, 'config')), /rollback input/);
});
