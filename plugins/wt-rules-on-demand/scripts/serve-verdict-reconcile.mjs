#!/usr/bin/env node
// Read-only comparison of retained serve journals with in-hook verdict rows.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory } from '../paths.js';
import { qualityDataDir } from './rule-lifecycle-lib.mjs';

const archivePattern = /^compliance-verdicts-archive-\d+-\d+\.jsonl$/;
export const LIMITS = [
  'which verdict belongs to which serve when two serves of one rule share a context within the tolerance (rows carry no delivery id)',
  'whether two rows with identical key are one decision written twice or two decisions (rows carry no decision id)',
  'which MAIN context generation a row belongs to (rows carry agentId null for every MAIN generation)',
  'whether a journal entry without ruleIdentity owns a row of another rule identity with the same file name',
];
const milliseconds = (value) => Date.parse(value);
const lag = (row) => milliseconds(row.decidedAt) - milliseconds(row.injectedAt);
const ratio = (count, denominator) => ({ count, denominator, rate: denominator ? count / denominator : null });
const sameRule = (serve, row) => serve.ruleIdentity ? row.ruleIdentity === serve.ruleIdentity : row.rule === serve.rule;
const sameContext = (serve, row) => serve.sessionId === row.sessionId && serve.agentId === (row.agentId ?? null) && sameRule(serve, row);

function servesOf(sessions) {
  const serves = [];
  for (const [sessionId, session] of Object.entries(sessions)) {
    for (const [context, data] of Object.entries(session.contexts ?? {})) {
      const agentId = context.startsWith('agent:') ? context.slice(6) : null;
      for (const entry of data.complianceInjected ?? []) serves.push({ ...entry, sessionId, agentId, context });
    }
  }
  return serves;
}

function naive(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.sessionId, row.agentId ?? null, row.ruleIdentity || row.rule, row.injectedAt]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const split = (sets) => {
    const values = [...sets];
    return {
      rows: values.reduce((sum, group) => sum + group.length, 0), groups: values.length,
      multipleGroups: values.filter((group) => group.length > 1).length,
      surplusRows: values.reduce((sum, group) => sum + group.length - 1, 0),
      conflictingGroups: values.filter((group) => new Set(group.map((row) => row.verdict)).size > 1).length,
    };
  };
  const all = [...groups.values()];
  return { all: split(all), lagged: split(all.filter((group) => group.every((row) => lag(row) > 50))),
    unlagged: split(all.filter((group) => !group.every((row) => lag(row) > 50))) };
}

function naiveRates(buckets) {
  return Object.fromEntries(Object.entries(buckets).map(([name, bucket]) => [name, {
    rows: ratio(bucket.rows, bucket.rows), groups: ratio(bucket.groups, bucket.groups),
    multipleGroups: ratio(bucket.multipleGroups, bucket.groups), surplusRows: ratio(bucket.surplusRows, bucket.rows),
    conflictingGroups: ratio(bucket.conflictingGroups, bucket.groups),
  }]));
}

function claimRows(serves, rows, toleranceMs) {
  const claims = serves.map(() => []);
  const matched = new Set();
  rows.forEach((row, index) => {
    const possible = serves.map((serve, position) => ({ serve, position }))
      .filter(({ serve }) => sameContext(serve, row) && milliseconds(row.injectedAt) >= milliseconds(serve.at) - toleranceMs
        && milliseconds(row.injectedAt) <= milliseconds(serve.at));
    // Smallest timestamp distance wins; equal distances go to the earlier journal entry.
    possible.sort((a, b) => milliseconds(a.serve.at) - milliseconds(b.serve.at) || a.position - b.position);
    if (possible.length) { claims[possible[0].position].push(index); matched.add(index); }
  });
  return { claims, matched };
}

// A served declarative rule drops its fresh window and writes a per-act row in the same handler, so a discharge
// follows its serve within the tolerance; each such row discharges one serve only.
function dischargeRow(serve, rows, used, toleranceMs) {
  const start = milliseconds(serve.at);
  return rows.findIndex((row, index) => !used.has(index) && sameContext(serve, row) && lag(row) <= 50
    && milliseconds(row.injectedAt) > start && milliseconds(row.injectedAt) <= start + toleranceMs);
}

function classifyOrphans(serves, claims, rows, { newest, marginMs, toleranceMs }) {
  const kinds = new Map(), used = new Set();
  const orphans = serves.map((serve, index) => ({ serve, index })).filter(({ index }) => !claims[index].length)
    .sort((a, b) => milliseconds(a.serve.at) - milliseconds(b.serve.at) || a.index - b.index);
  for (const { serve, index } of orphans) {
    const discharge = dischargeRow(serve, rows, used, toleranceMs);
    if (discharge >= 0) { used.add(discharge); kinds.set(index, 'dischargedByPerAct'); }
    else if (newest - milliseconds(serve.at) <= marginMs && newest >= milliseconds(serve.at)) kinds.set(index, 'openAtFreeze');
    else kinds.set(index, 'unexplained');
  }
  return kinds;
}

function statusOf(matched) {
  if (!matched) return 'ORPHAN';
  return matched > 1 ? 'DUPLICATE' : 'MATCHED';
}

export function measure(rows, sessions, { toleranceMs = 2000, openMarginMin = 60 } = {}) {
  const serves = servesOf(sessions);
  const { claims, matched } = claimRows(serves, rows, toleranceMs);
  const newest = Math.max(-Infinity, ...rows.map((row) => milliseconds(row.decidedAt)).filter(Number.isFinite));
  const kinds = classifyOrphans(serves, claims, rows, { newest, marginMs: openMarginMin * 60000, toleranceMs });
  const counts = { orphan: 0, dischargedByPerAct: 0, openAtFreeze: 0, unexplained: 0, duplicate: 0, surplus: 0, conflicting: 0, nameOnly: 0 };
  const details = serves.map((serve, index) => {
    const owned = claims[index].map((id) => rows[id]);
    if (!serve.ruleIdentity && owned.length) counts.nameOnly++;
    if (!owned.length) { counts.orphan++; counts[kinds.get(index)]++; }
    if (owned.length > 1) { counts.duplicate++; counts.surplus += owned.length - 1; }
    if (new Set(owned.map((row) => row.verdict)).size > 1) counts.conflicting++;
    return { ...serve, matchedRows: claims[index], status: statusOf(owned.length),
      ...(owned.length ? {} : { orphanKind: kinds.get(index) }),
      conflicting: new Set(owned.map((row) => row.verdict)).size > 1 };
  });
  const unjoinable = rows.filter((row) => !Object.hasOwn(sessions, row.sessionId)).length;
  const withoutServe = rows.filter((row, index) => lag(row) > 50 && !matched.has(index)).length;
  const grouped = naive(rows);
  return { rows: rows.length, serves: serves.length, naive: grouped, naiveRates: naiveRates(grouped), details,
    join: Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, ratio(count, serves.length)])),
    unjoinable: ratio(unjoinable, rows.length), verdictsWithoutServe: ratio(withoutServe, rows.length) };
}

function parseArgs(args) {
  const options = { stores: [], toleranceMs: 2000, openMarginMin: 60, json: false, seedControl: false };
  const values = { '--store': 'stores', '--config-dir': 'configDir', '--archives': 'archives', '--tolerance-ms': 'toleranceMs', '--open-margin-min': 'openMarginMin' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') options.json = true;
    else if (flag === '--seed-control') options.seedControl = true;
    else if (Object.hasOwn(values, flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      if (flag === '--store') options.stores.push(value);
      else options[values[flag]] = value;
    } else throw new Error(`unknown option: ${flag}`);
  }
  for (const key of ['toleranceMs', 'openMarginMin']) {
    const value = Number(options[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a nonnegative integer`);
    options[key] = value;
  }
  return options;
}

async function defaultStorePath(configDir) {
  const directory = join(configDir, 'plugins', 'store');
  const names = (await readdir(directory)).filter((name) => /^wt-rules-on-demand[_-].*\.json$/.test(name));
  if (!names.length) throw new Error(`no wt-rules-on-demand store found under ${directory}`);
  const candidates = await Promise.all(names.map(async (name) => ({ name, mtime: (await stat(join(directory, name))).mtimeMs })));
  candidates.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return join(directory, candidates[0].name);
}

async function inputs(options) {
  const configDir = options.configDir || configDirectory(process.env);
  if (!options.stores.length && !configDir) throw new Error('HOME or USERPROFILE required to locate config directory');
  const storePaths = options.stores.length ? options.stores : [await defaultStorePath(configDir)];
  // Named snapshots read only the archives named beside them: ambient archives would mix in another state of the store.
  const archiveDir = options.archives || (!options.stores.length && configDir ? qualityDataDir(configDir) : '');
  const archives = archiveDir ? (await readdir(archiveDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    .filter((name) => archivePattern.test(name)).sort().map((name) => join(archiveDir, name)) : [];
  const files = [], rows = [], sessions = {};
  async function load(path) {
    const bytes = await readFile(path);
    files.push({ path: resolve(path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    return bytes.toString('utf8');
  }
  const addLines = (text) => { for (const line of String(text ?? '').split('\n').filter(Boolean)) rows.push(JSON.parse(line)); };
  for (const path of storePaths) {
    const store = JSON.parse(await load(path));
    Object.assign(sessions, store.sessions ?? {});
    addLines(store['compliance-verdicts-jsonl']);
    for (const [key, value] of Object.entries(store)) if (key.startsWith('compliance-verdicts-archive-')) addLines(value);
  }
  for (const path of archives) addLines(await load(path));
  return { files, rows, sessions };
}

// Duplicate one singly matched serve's row and remove another's: a working join reports exactly one more duplicate
// serve, one more surplus row and one more orphan. `measureFn` lets a test prove the control fails on a broken counter.
export function seedControl(rows, sessions, options = {}, measureFn = measure) {
  const original = measureFn(rows, sessions, options);
  const singles = original.details.filter((serve) => serve.matchedRows.length === 1).map((serve) => ({ id: serve.matchedRows[0], serve }));
  singles.sort((a, b) => milliseconds(rows[a.id].decidedAt) - milliseconds(rows[b.id].decidedAt)
    || rows[a.id].rule.localeCompare(rows[b.id].rule) || a.id - b.id);
  const [first, other] = singles;
  if (!first || !other) return { available: false, reason: first ? 'no other singly matched window row' : 'no matched window rows' };
  const changed = rows.filter((_, index) => index !== other.id).concat({ ...rows[first.id] });
  const control = measureFn(changed, sessions, options);
  const plusOne = (key) => control.join[key].count === original.join[key].count + 1;
  return { available: true, duplicate: plusOne('duplicate') && plusOne('surplus'), orphan: plusOne('orphan') };
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); } catch (error) { console.error(error.message); return 2; }
  try {
    const { files, rows, sessions } = await inputs(options);
    const result = measure(rows, sessions, options);
    const control = options.seedControl ? seedControl(rows, sessions, options) : null;
    if (options.json) console.log(JSON.stringify({ files, result, limits: LIMITS, control }, null, 2));
    else {
      for (const file of files) console.log(`INPUT ${file.path} bytes=${file.bytes} sha256=${file.sha256}`);
      console.log(`NAIVE ${JSON.stringify({ counts: result.naive, rates: result.naiveRates })}`);
      console.log(`JOIN ${JSON.stringify({ rows: result.rows, serves: result.serves, counts: result.join, unjoinable: result.unjoinable, verdictsWithoutServe: result.verdictsWithoutServe })}`);
      for (const serve of result.details) console.log(`SERVE ${JSON.stringify(serve)}`);
      for (const limit of LIMITS) console.log(`CANNOT ANSWER: ${limit}`);
      if (control) {
        if (!control.available) console.log(`CONTROL unavailable: ${control.reason}`);
        else { console.log(`CONTROL duplicate +1: ${control.duplicate ? 'ok' : 'FAILED'}`); console.log(`CONTROL orphan +1: ${control.orphan ? 'ok' : 'FAILED'}`); }
      }
    }
    return control && (!control.available || !control.duplicate || !control.orphan) ? 1 : 0;
  } catch (error) { console.error(`serve-verdict-reconcile: ${error.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
