import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { measure, main, seedControl, measureExact, seedExactControl } from '../scripts/serve-verdict-reconcile.mjs';
import { mergeSessions } from '../scripts/delivery-join.mjs';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'serve-verdict-store.json');
const archives = dirname(fixture);
const input = ['--store', fixture, '--archives', archives];
const store = JSON.parse(await readFile(fixture, 'utf8'));
const rows = store['compliance-verdicts-jsonl'].trim().split('\n').map(JSON.parse);

test('reconciles every retained serve, orphan class, identity fallback and unjoinable verdict', () => {
  const result = measure(rows, store.sessions);
  assert.equal(result.rows, 10);
  assert.equal(result.serves, 8);
  assert.deepEqual(result.naive, {
    all: { rows: 10, groups: 8, multipleGroups: 2, surplusRows: 2, conflictingGroups: 1 },
    lagged: { rows: 9, groups: 7, multipleGroups: 2, surplusRows: 2, conflictingGroups: 1 },
    unlagged: { rows: 1, groups: 1, multipleGroups: 0, surplusRows: 0, conflictingGroups: 0 },
  });
  assert.deepEqual(Object.fromEntries(Object.entries(result.join).map(([key, item]) => [key, item.count])), {
    orphan: 3, dischargedByPerAct: 1, openAtFreeze: 1, unexplained: 1,
    duplicate: 2, surplus: 2, conflicting: 1, nameOnly: 1,
  });
  assert.equal(result.join.orphan.denominator, 8);
  assert.equal(result.join.orphan.rate, 3 / 8);
  assert.deepEqual(result.unjoinable, { count: 1, denominator: 10, rate: 0.1 });
  assert.deepEqual(result.verdictsWithoutServe, { count: 2, denominator: 10, rate: 0.2 });
  assert.equal(result.details.find((item) => item.rule === 'agent.md').matchedRows.length, 1);
  assert.equal(result.details.find((item) => item.rule === 'conflict.md').conflicting, true);
  assert.equal(result.details.find((item) => item.rule === 'legacy.md').matchedRows.length, 1);
  assert.equal(result.details.find((item) => item.rule === 'open.md').orphanKind, 'openAtFreeze');
});

async function capture(args) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => { lines.push(parts.join(' ')); };
  try { return { code: await main(args), lines }; } finally { console.log = original; }
}

test('CLI seed control detects both mutations and names hashed input', async () => {
  const { code, lines } = await capture([...input, '--seed-control']);
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /CONTROL duplicate \+1: ok\nCONTROL orphan \+1: ok/);
  assert.match(lines[0], /^INPUT .*serve-verdict-store\.json bytes=\d+ sha256=[a-f0-9]{64}$/);
  assert.match(lines.join('\n'), /rows carry no delivery id/);
  assert.match(lines.join('\n'), /rows carry no decision id/);
});

test('CLI reports an unavailable control and rejects unknown options', async () => {
  const unavailable = await capture([...input, '--tolerance-ms', '0', '--seed-control']);
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.lines.join('\n'), /CONTROL unavailable: no matched window rows/);
  const original = console.error;
  const errors = [];
  console.error = (text) => errors.push(text);
  try { assert.equal(await main(['--unknown']), 2); } finally { console.error = original; }
  assert.match(errors.join('\n'), /unknown option: --unknown/);
});

const at = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const row = (rule, injected, decided, extra = {}) => ({ rule, ruleIdentity: `user:${rule}`, sessionId: 's', agentId: null, injectedAt: at(injected), decidedAt: at(decided), verdict: 'followed', ...extra });
const journal = (contexts) => ({ s: { contexts: Object.fromEntries(Object.entries(contexts).map(([key, serves]) => [key, { complianceInjected: serves.map(([rule, ms]) => ({ rule, ruleIdentity: `user:${rule}`, at: at(ms) })) }])) } });

test('a per-act row discharges at most one serve, and only when it follows within the tolerance', () => {
  const late = measure([row('late.md', 7_200_000, 7_200_001)], journal({ 0: [['late.md', 1000]] }), { openMarginMin: 0 });
  assert.equal(late.join.dischargedByPerAct.count, 0, 'a per-act row two hours later does not discharge the serve');
  assert.equal(late.join.unexplained.count, 1);
  const shared = measure([row('twice.md', 5050, 5051)], journal({ 0: [['twice.md', 1000]], 1: [['twice.md', 5000]] }), { openMarginMin: 0 });
  assert.equal(shared.join.dischargedByPerAct.count, 1, 'one per-act row discharges one serve');
  assert.equal(shared.join.unexplained.count, 1);
});

test('a window settled before its serve was journalled is still claimed by that serve', () => {
  const result = measure([row('early.md', 0, 100)], journal({ 0: [['early.md', 200]] }), { openMarginMin: 0 });
  assert.equal(result.join.orphan.count, 0);
  assert.deepEqual(result.details[0].matchedRows, [0]);
});

test('the seeded duplicate control fails when the duplicate-serve counter is broken', () => {
  const rows = [row('a.md', 900, 1300), row('b.md', 1900, 2300), row('c.md', 2900, 3300)];
  const sessions = journal({ 0: [['a.md', 1000], ['b.md', 2000], ['c.md', 3000]] });
  assert.equal(seedControl(rows, sessions).duplicate, true, 'working counters pass the control');
  const broken = (...args) => { const result = measure(...args); result.join.duplicate = { ...result.join.duplicate, count: 0 }; return result; };
  assert.equal(seedControl(rows, sessions, {}, broken).duplicate, false, 'a duplicate counter stuck at zero fails the control');
});

test('an explicit --store reads no archive from the ambient config dir', async () => {
  const config = await mkdtemp(join(tmpdir(), 'svr-config-'));
  try {
    const quality = join(config, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
    await mkdir(quality, { recursive: true });
    await writeFile(join(quality, 'compliance-verdicts-archive-1-1.jsonl'), `${JSON.stringify(rows[0])}\n`);
    const { code, lines } = await capture(['--store', fixture, '--config-dir', config]);
    assert.equal(code, 0);
    assert.equal(lines.filter((line) => line.startsWith('INPUT ')).length, 1, 'only the named store is read');
  } finally { await rm(config, { recursive: true, force: true }); }
});

test('reconcile prints exact buckets and checks four independent seeded controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svr-exact-'));
  try {
    const file = join(root, 'store.json');
    const serves = [10, 20, 30].map((seq) => ({ rule: 'r.md', ruleIdentity: 'user:r.md', deliveryId: `t-${seq}`, deliverySeq: seq, servingSeq: seq - 1, at: at(seq) }));
    const rows = serves.map((item) => ({ ...item, verdictId: `t-${item.deliverySeq + 1}`, actSeq: item.deliverySeq + 1, sessionId: 's', agentId: null, verdict: 'followed', injectedAt: item.at, decidedAt: at(item.deliverySeq + 2) }));
    await writeFile(file, JSON.stringify({ sessions: { s: { contexts: { 0: { complianceInjected: serves, lastClose: { token: 't', seq: 40, at: at(40) } } } } }, 'compliance-verdicts-jsonl': rows.map(JSON.stringify).join('\n') }));
    const { code, lines } = await capture(['--store', file, '--archives', root, '--seed-control']);
    assert.equal(code, 0, lines.join('\n'));
    const exact = JSON.parse(lines.find((line) => line.startsWith('EXACT ')).slice(6));
    assert.equal(exact.withId, 3);
    assert.equal(exact.anomaly.count, 0);
    for (const name of ['duplicate', 'settled', 'open', 'copy']) assert.match(lines.join('\n'), new RegExp(`CONTROL ${name} \\+1: ok`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every exact seeded control fails against its own broken counter', () => {
  const serves = [10, 20].map((seq) => ({ rule: 'r.md', ruleIdentity: 'user:r.md', deliveryId: `t-${seq}`, deliverySeq: seq, servingSeq: seq - 1, at: at(seq) }));
  const sessions = { s: { contexts: { 0: { complianceInjected: serves, lastClose: { token: 't', seq: 30, at: at(30) } } } } };
  const rows = serves.map((serve) => ({ ...serve, sessionId: 's', verdictId: `t-${serve.deliverySeq + 1}`, actSeq: serve.deliverySeq + 1, verdict: 'followed', decidedAt: at(serve.deliverySeq + 2) }));
  const controls = seedExactControl(rows, sessions);
  for (const [name, field] of [['duplicate', 'duplicateIds'], ['settled', 'unjudgedSettled'], ['open', 'unjudgedOpen'], ['copy', 'copies']]) {
    assert.equal(controls[name], true, `working ${name} control passes`);
    const broken = (...args) => { const result = measureExact(...args); result[field] = { ...result[field], count: 0 }; return result; };
    assert.equal(seedExactControl(rows, sessions, {}, broken)[name], false, `${name} control detects a stuck counter`);
  }
});

test('multiple stores preserve shared-session journals in either order: anomaly is 1/2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'svr-merge-'));
  try {
    const serves = [10, 20].map((seq) => ({ rule: 'r.md', ruleIdentity: 'user:r.md', deliveryId: `t-${seq}`, deliverySeq: seq, servingSeq: seq - 1, at: at(seq) }));
    const judged = { ...serves[1], sessionId: 's', verdictId: 't-21', actSeq: 21, verdict: 'followed', decidedAt: at(22) };
    const files = [join(root, 'a.json'), join(root, 'b.json')];
    for (const [index, file] of files.entries()) await writeFile(file, JSON.stringify({
      sessions: { s: { contexts: { 0: { complianceInjected: [serves[index]], lastClose: { token: 't', seq: 30 + index, at: at(30 + index) } } } } },
      'compliance-verdicts-jsonl': index ? JSON.stringify(judged) : '',
    }));
    for (const order of [files, [...files].reverse()]) {
      const { lines } = await capture([...order.flatMap((file) => ['--store', file]), '--archives', root, '--json']);
      assert.deepEqual(JSON.parse(lines[0]).exact.anomaly, { count: 1, denominator: 2, rate: 0.5 }, 'shared session keeps both deliveries');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function exactFixture() {
  const serve = { rule: 'r.md', ruleIdentity: 'user:r.md', deliveryId: 't-10', deliverySeq: 10, servingSeq: 9, at: at(10) };
  return {
    sessions: { s: { contexts: { 0: { complianceInjected: [serve], lastClose: { token: 't', seq: 30, at: at(30) } } } } },
    rows: [{ ...serve, sessionId: 's', verdictId: 't-11', actSeq: 11, verdict: 'followed', decidedAt: at(12) }],
  };
}

test('anomaly upper includes id-bearing verdicts from missing sessions', () => {
  const { rows, sessions } = exactFixture();
  const result = measureExact([...rows, { ...rows[0], sessionId: 'absent', deliveryId: 'absent-10' }], sessions);
  assert.equal(result.sessionMissing.count, 1);
  assert.equal(result.anomalyUpper.count, 1, 'missing-session claims contribute to the upper anomaly count');
  assert.equal(result.anomaly.count, 0);
});

for (const name of ['duplicate', 'settled']) test(`${name} control rejects a headline anomaly stuck at zero`, () => {
  const { rows, sessions } = exactFixture();
  const broken = (...args) => { const result = measureExact(...args); result.anomaly.count = 0; return result; };
  const controls = seedExactControl(rows, sessions, {}, broken);
  assert.equal(controls[name], false, `${name} control detects a stuck headline anomaly`);
  assert.equal(controls.open, true);
  assert.equal(controls.copy, true);
});

test('all exact controls reject a headline rate stuck at zero', () => {
  const { rows, sessions } = exactFixture();
  sessions.s.contexts[0].complianceInjected.push({ ...rows[0], deliveryId: 't-20', deliverySeq: 20, servingSeq: 19, at: at(20) });
  const working = seedExactControl(rows, sessions);
  const broken = (...args) => { const result = measureExact(...args); result.anomaly.rate = 0; return result; };
  const controls = seedExactControl(rows, sessions, {}, broken);
  for (const name of ['duplicate', 'settled', 'open', 'copy']) {
    assert.equal(working[name], true, `working ${name} control passes with a nonzero baseline anomaly`);
    assert.equal(controls[name], false, `${name} control detects a rate-only stuck headline`);
  }
});

test('each exact control checks its own headline rate and the baseline rate', () => {
  const { rows, sessions } = exactFixture();
  for (const [name, call] of [['duplicate', 1], ['settled', 2], ['copy', 3], ['open', 4]]) {
    let calls = 0;
    const broken = (...args) => {
      const result = measureExact(...args);
      if (calls++ === call) result.anomaly.rate = -1;
      return result;
    };
    const controls = seedExactControl(rows, sessions, {}, broken);
    for (const other of ['duplicate', 'settled', 'open', 'copy']) {
      assert.equal(controls[other], other !== name, `${other} control checks its own run's rate`);
    }
  }
  let calls = 0;
  const brokenBaseline = (...args) => {
    const result = measureExact(...args);
    if (calls++ === 0) result.anomaly.rate = -1;
    return result;
  };
  const controls = seedExactControl(rows, sessions, {}, brokenBaseline);
  for (const name of ['duplicate', 'settled', 'open', 'copy']) assert.equal(controls[name], false, 'an inconsistent baseline invalidates every control');
});

test('exact controls require the producer null rate when the headline denominator is zero', () => {
  const { rows, sessions } = exactFixture();
  for (const rate of [0, null]) {
    const wrapper = (...args) => {
      const result = measureExact(...args);
      result.anomaly.denominator = 0;
      result.anomaly.rate = rate;
      return result;
    };
    const controls = seedExactControl(rows, sessions, {}, wrapper);
    for (const name of ['duplicate', 'settled', 'open', 'copy']) {
      assert.equal(controls[name], rate === null, `${name} requires the null rate ratio() produces for a zero denominator`);
    }
  }
});

test('archive populations include judged old deliveries exactly once as out of reach', () => {
  const { rows, sessions } = exactFixture();
  sessions.s.contexts[0].complianceInjected.push({ rule: 'legacy.md', at: at(1) }, { ...rows[0], deliveryId: 't-20', deliverySeq: 20, at: at(20) });
  const result = measureExact(rows, sessions, { archivesRead: 1, archiveRows: [{ decidedAt: at(15) }] });
  assert.equal(result.outOfReach, 1, 'judged delivery older than the archive bound is out of reach');
  assert.equal(result.withId + result.withoutId + result.outOfReach, 3, 'each MAIN delivery belongs to one population');
  assert.equal(result.withId, 1);
  assert.equal(result.withoutId, 1);
});

test('open control seeds the newest MAIN context after compactions and later process closes', () => {
  const { rows, sessions } = exactFixture();
  sessions.s.contexts[0].lastClose = { token: 't', seq: 50, at: at(50) };
  sessions.s.contexts[6] = { complianceInjected: [], lastClose: { token: 'new', seq: 70, at: at(70) } };
  const original = structuredClone(sessions);
  const measured = [];
  const observe = (...args) => { const result = measureExact(...args); measured.push(result); return result; };
  const control = seedExactControl(rows, sessions, {}, observe);
  assert.equal(control.open, true, 'open control must seed an actually open window after compaction');
  assert.equal(measured[4].unjudgedOpen.count, measured[0].unjudgedOpen.count + 1);
  assert.equal(measured[4].anomaly.count, measured[0].anomaly.count);
  assert.deepEqual(sessions, original, 'controls never modify the original store');
});

test('open control does not accidentally seed a same-act discharged window', () => {
  const { rows, sessions } = exactFixture();
  rows[0].actSeq = 31;
  assert.equal(seedExactControl(rows, sessions).open, true, 'synthetic serving admission must be later than existing verdict acts');
});

test('open control seeds past every retained close marker', () => {
  const { rows, sessions } = exactFixture();
  sessions.s.contexts[0].lastClose = { token: 't', seq: 50, at: at(5) };
  const foreign = structuredClone(sessions);
  foreign.s.contexts[0].lastClose = { token: 'q', seq: 1, at: at(40) };
  const merged = mergeSessions([{ sessions }, { sessions: foreign }]);
  assert.equal(seedExactControl(rows, merged).open, true, 'open seed must exceed close sequences hidden by the readable lastClose');
});
