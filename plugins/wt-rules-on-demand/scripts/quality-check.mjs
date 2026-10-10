#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, realpath, writeFile, rm, rename, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { ruleDirectories, configDirectory } from '../paths.js';
import { fileURLToPath } from 'node:url';
import { assertSafeDataDir, qualityDataDir } from './rule-lifecycle-lib.mjs';
import { readFile } from 'node:fs/promises';
import { scanTranscripts, summarise } from './transcript-verdicts.mjs';
import { measureRules, ruleId } from './quality-measures.mjs';
import { createHash } from 'node:crypto';
import { rollbackArchiveDirectory } from './rollback-input-paths.mjs';
import { readStoreArchives, reportUnreadable, withArchivedSessions } from './store-archives.mjs';
import { serveWindowHours } from './serve-confirmation.mjs';
import { rollbackWindowArgs } from './daily-provisional.mjs';

export async function measureInputs(configDirs, scopes, target) {
  const steps = measureInputSteps(configDirs, scopes, target);
  let step = steps.next();
  while (!step.done) {
    try { step = steps.next(await step.value); }
    catch (error) { step = steps.throw(error); }
  }
  return step.value;
}

// Each yield replaces one original await; delegation itself is synchronous.
function* measureInputSteps(configDirs, scopes, target) {
  const state = { stores: [], profiles: [], unreadableArchives: [], storeBytes: 0 };
  for (const config of configDirs) yield* profileInputs(config, state);
  const ledger = {};
  for (const scope of scopes) {
    const root = scope.scope === 'user' ? resolve(scope.rulesDir, '..') : scope.projectRoot;
    const path = join(root, scope.scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
    for (const line of (yield readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))).split('\n').filter(Boolean)) updateInputLedger(ledger, scope, line);
  }
  const sources = new Map();
  for (const config of configDirs) yield* installedSources(config, sources);
  const pluginRulesDir = shippedRuleSources(scopes, configDirs, sources);
  const previousState = yield readFile(join(target, 'measures-state.json'), 'utf8').then(JSON.parse, (error) => error.code === 'ENOENT' ? {} : Promise.reject(error));
  const { stores, profiles, unreadableArchives, storeBytes } = state;
  const health = aggregateHealth(stores);
  return { ledger, previousState, pluginRulesDir,
    store: { health, profiles, sessions: Object.assign({}, ...stores.map((item) => item.sessions ?? {})), unreadableArchives }, storeBytes: stores.length ? storeBytes : null };
}

function* profileInputs(config, state) {
  const dir = join(config, 'plugins', 'store');
  const files = (yield readdir(dir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)))
      .filter((name) => /^wt-rules-on-demand[_-].*\.json$/.test(name));
  let item = null;
  if (files.length) {
    const candidates = yield Promise.all(files.map(async (name) => ({ file: join(dir, name), info: await stat(join(dir, name)) })));
    const { file, info } = candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0];
    item = JSON.parse(yield readFile(file, 'utf8'));
    state.stores.push(item);
    state.storeBytes += info.size;
  }
  // Read the live store before its archives, then join them in this profile's context.
  const { archives, unreadable } = yield readStoreArchives(rollbackArchiveDirectory(config));
  for (const entry of reportUnreadable('quality-check', unreadable)) state.unreadableArchives.push(entry);
  if (item && archives.length) item.sessions = withArchivedSessions(archives, item.sessions);
  state.profiles.push({ configDir: config, recorded: !!item?.health, health: item?.health ?? null, sessions: item ? item.sessions ?? {} : withArchivedSessions(archives, {}) });
}

function updateInputLedger(ledger, scope, line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return; }
  const id = ruleId({ scope: scope.scope, rulesDir: scope.rulesDir, rule: entry.rule });
  if (entry.action === 'migrate') ledger[id] = entry;
  else if (['revert', 'retire'].includes(entry.action)) delete ledger[id];
}

function* installedSources(config, sources) {
  const installed = yield readFile(join(config, 'plugins', 'installed_plugins.json'), 'utf8').then(JSON.parse, (error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const records = Object.entries(installed?.plugins ?? {}).filter(([name]) => name.startsWith('workflow-toolbox@'));
  for (const [, versions] of records) {
    for (const entry of Array.isArray(versions) ? versions : [versions]) yield* sourceEntry(config, sources, entry);
  }
}

function* sourceEntry(config, sources, entry) {
  if (!entry?.installPath) return;
  const dir = join(entry.installPath, 'rules');
  for (const name of (yield readdir(dir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter((item) => item.endsWith('.md'))) {
    sources.set(config, [...sources.get(config) ?? [], { name, text: yield readFile(join(dir, name), 'utf8'), version: entry.version ?? entry.installPath, path: entry.installPath }]);
  }
}

function shippedRuleSources(scopes, configDirs, sources) {
  const pluginRulesDir = {};
  for (const scope of scopes) for (const rule of scope.rules) {
    const owners = scope.scope === 'user' ? scope.configDirs ?? [scope.configDir] : configDirs;
    const candidates = owners.flatMap((config) => (sources.get(config) ?? []).filter((source) => source.name === rule.name));
    recordShippedSource(pluginRulesDir, rule, scope, owners, candidates, sources);
  }
  return pluginRulesDir;
}

function recordShippedSource(pluginRulesDir, rule, scope, owners, candidates, sources) {
  if (!candidates.length) { pluginRulesDir[ruleId({ ...rule, ...scope })] = owners.some((config) => sources.has(config)) ? null : undefined; return; }
  const versions = candidates.map((source) => ({ configDir: owners.find((config) => sources.get(config)?.includes(source)), version: source.version, path: source.path,
        fingerprint: createHash('sha256').update(source.text.trimEnd()).digest('hex').slice(0, 12) }));
  pluginRulesDir[ruleId({ ...rule, ...scope })] = { text: candidates[0].text, versions, ambiguous: new Set(versions.map((version) => version.fingerprint)).size > 1 };
}

function aggregateHealth(stores) {
  const health = stores.some((item) => item.health) ? { days: {}, lastErrors: [] } : undefined;
  if (health) for (const item of stores) if (item.health) {
    addHealthDays(health, item);
    for (const error of item.health.lastErrors ?? []) health.lastErrors.push(error);
  }
  return health;
}

function addHealthDays(health, item) {
  for (const [day, counts] of Object.entries(item.health.days ?? {})) {
    const total = health.days[day] ?? { calls: 0, errors: 0, totalMs: 0, maxMs: 0, slow: 0 };
    for (const key of ['calls', 'errors', 'totalMs', 'slow']) total[key] += counts[key] ?? 0;
    total.maxMs = Math.max(total.maxMs, counts.maxMs ?? 0);
    health.days[day] = total;
  }
}

export async function qualityCheck({ configDirs, projectsDirs, project, followedRoots = [], dataDir, days = 7, since, volume = 20, verdictPath: privateVerdictPath, serveWindowHours: windowHours }) {
  const steps = qualitySteps({ configDirs, projectsDirs, project, followedRoots, dataDir, days, since, volume, privateVerdictPath, windowHours });
  let step = steps.next();
  while (!step.done) {
    try { step = steps.next(await step.value); }
    catch (error) { step = steps.throw(error); }
  }
  return step.value;
}

function* qualitySteps({ configDirs, projectsDirs, project, followedRoots, dataDir, days, since, volume, privateVerdictPath, windowHours }) {
  const target = yield assertSafeDataDir(dataDir ?? qualityDataDir(configDirs[0]));
  yield mkdir(target, { recursive: true });
  const latest = join(target, 'latest.json');
  try {
    const scopes = yield* qualityScopes(configDirs, project, followedRoots);
    const runNow = Date.now();
    const initial = yield scanTranscripts({ projectsDirs, scopes, days, since, now: runNow, collect: true, discoverProjects: true, nonProofNames: process.env.WT_ROD_NON_PROOF_NAMES?.split(',').filter(Boolean) ?? [] });
    if (!initial.stats.filesRead) throw new Error(`0 transcript files read; files failed: ${initial.stats.filesFailed}; errors: ${initial.stats.errors.join('; ')}; skipped ${initial.stats.skipped.length}: ${initial.stats.skipped.join('; ')}`);
    return yield* qualityReport({ initial, configDirs, target, latest, days, since, volume, privateVerdictPath, windowHours, runNow });
  } catch (error) {
    yield atomicLatest(latest, { ok: false, finishedAt: new Date().toISOString(), error: error.message });
    throw error;
  }
}

function* qualityScopes(configDirs, project, followedRoots) {
  const scopes = [], physical = new Set();
  for (const configDir of configDirs) {
    const rulesDir = ruleDirectories(project, configDir).user;
    const resolved = yield realpath(rulesDir).catch(() => null);
    if (!resolved) continue;
    if (knownUserScope(scopes, physical, resolved, configDir)) continue;
    if ((yield readdir(resolved)).some((name) => name.endsWith('.md')))
      scopes.push({ scope: 'user', rulesDir: resolved, configDir: resolve(resolved, '..'), configDirs: [...new Set([configDir, resolve(resolved, '..')])], ledgerRoots: [resolve(resolved, '..')] });
  }
  yield* projectScopes(scopes, physical, configDirs, project, followedRoots);
  return scopes;
}

function knownUserScope(scopes, physical, resolved, configDir) {
  // Symlinked user mirrors join the scope's transcript owners rather than being dropped.
  const shared = scopes.find((scope) => scope.rulesDir === resolved);
  if (shared) {
    if (!shared.configDirs.includes(configDir)) shared.configDirs.push(configDir);
    return true;
  }
  if (physical.has(resolved)) return true;
  physical.add(resolved);
  return false;
}

function* projectScopes(scopes, physical, configDirs, project, followedRoots) {
  for (const root of new Set([project, ...followedRoots])) {
    const candidate = ruleDirectories(root, configDirs[0]).project;
    if ((yield readdir(candidate).catch((error) => ['ENOENT', 'ENOTDIR'].includes(error.code) ? [] : Promise.reject(error))).some((name) => name.endsWith('.md'))) {
      const resolved = yield realpath(candidate);
      // A home-root project can point to the very same rules as the user config scope.
      if (physical.has(resolved)) continue;
      scopes.push({ scope: 'project', projectRoot: root, rulesDir: resolved, ledgerRoots: [root] });
    }
  }
}

function* qualityReport({ initial, configDirs, target, latest, days, since, volume, privateVerdictPath, windowHours, runNow }) {
  const rows = initial.rows;
  const date = new Date().toISOString().slice(0, 10);
  const verdictPath = privateVerdictPath ?? join(target, `verdicts-${date}.jsonl`);
  if (privateVerdictPath && (resolve(privateVerdictPath) !== resolve(target, 'daily', privateVerdictPath.split(/[\\/]/).at(-1)))) throw new Error('private verdict path must be inside the daily quality directory');
  yield writeFile(verdictPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  const { rollback, rollbackNotes } = dryRunRollbacks(initial, configDirs, verdictPath, windowHours);
  const { latestMigration, malformedLedgerLines } = yield* latestMigrations(initial.scopes);
  const unproven = [...latestMigration.entries()].filter(([, row]) => row.unproven).map(([key, row]) => ({ scope: key.split(':')[0], rule: row.rule, reason: row.noProofReason }));
  const applicableSamples = rows.filter((row) => ['followed', 'not followed'].includes(row.verdict)).length;
  const inputs = yield measureInputs(configDirs, initial.scopes, target);
  const measures = qualityMeasures(rows, initial, inputs, volume, runNow, since, days);
  const raw = rawMeasures(rows, initial);
  yield writeFile(join(target, `measure-rows-${date}.jsonl`), raw.map((row) => JSON.stringify(row)).join('\n') + (raw.length ? '\n' : ''));
  const report = finishedReport({ initial, applicableSamples, malformedLedgerLines, since, days, verdictPath, unproven, measures, rows, rollback, rollbackNotes });
  yield writeFile(join(target, `quality-${date}.json`), JSON.stringify(report, null, 2) + '\n');
  yield atomicLatest(latest, report);
  yield atomicLatest(join(target, 'measures-state.json'), measures.state);
  const archives = (yield readdir(target)).filter((name) => /^(?:quality-.*\.json|verdicts-.*\.jsonl|measure-rows-.*\.jsonl)$/.test(name)).sort();
  for (const prefix of ['quality-', 'verdicts-', 'measure-rows-']) for (const name of archives.filter((item) => item.startsWith(prefix)).slice(0, -14)) yield rm(join(target, name));
  return report;
}

function dryRunRollbacks(initial, configDirs, verdictPath, windowHours) {
  const rollback = [], rollbackNotes = [];
  for (const scope of initial.scopes) {
    // The only rollback-check invocation is ALWAYS dry-run, including all project scopes and errors.
    const args = [fileURLToPath(new URL('./rollback-check.mjs', import.meta.url)), '--dry-run', '--json', '--verdicts', verdictPath,
      ...(scope.scope === 'user' ? ['--user', '--config-dir', resolve(scope.rulesDir, '..')] : ['--project', scope.projectRoot, ...configDirs.flatMap((dir) => ['--profile-dir', dir])]),
      ...rollbackWindowArgs({ serveWindowHours: windowHours })];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`rollback-check ${scope.rulesDir}: ${run.stderr || run.stdout}`);
    for (const outcome of JSON.parse(run.stdout)) rollback.push(outcome);
    for (const line of run.stderr.split('\n').filter((line) => line.startsWith('rollback-check:'))) rollbackNotes.push(line);
  }
  return { rollback, rollbackNotes };
}

function* latestMigrations(scopes) {
  const latestMigration = new Map();
  let malformedLedgerLines = 0;
  for (const scope of scopes) for (const root of scope.ledgerRoots ?? [scope.scope === 'user' ? resolve(scope.rulesDir, '..') : scope.projectRoot]) {
    const file = join(root, scope.scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
    const lines = (yield readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))).split('\n');
    malformedLedgerLines += updateLatestMigrations(latestMigration, scope, lines);
  }
  return { latestMigration, malformedLedgerLines };
}

function updateLatestMigrations(latestMigration, scope, lines) {
  let malformed = 0;
  for (const line of lines) if (line.trim()) {
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    const key = `${scope.scope}:${row.rule}`;
    if (row.action === 'migrate') latestMigration.set(key, row);
    if (row.action === 'revert' || row.action === 'retire') latestMigration.delete(key);
  }
  return malformed;
}

function qualityMeasures(rows, initial, inputs, volume, runNow, since, days) {
  return measureRules({ rows, deliveries: initial.deliveries, acts: initial.acts, effective: initial.effective,
    rules: initial.scopes.flatMap((scope) => scope.rules.map((rule) => ({ ...rule, scope: scope.scope, rulesDir: scope.rulesDir }))),
    ...inputs, store: { ...inputs.store, uncertainContexts: initial.uncertainContexts }, volume, now: runNow, days: initial.stats.days,
    healthDays: since ? Math.floor((Date.parse(new Date(runNow).toISOString().slice(0, 10)) - Date.parse(new Date(since).toISOString().slice(0, 10))) / 86400000) + 1 : days });
}

function rawMeasures(rows, initial) {
  return [...rows.map((row) => ({ type: 'act', ...row })), ...initial.deliveries.map((delivery) => ({ type: 'delivery', ...delivery })),
    ...initial.effective.map((context) => ({ type: 'context', ...context })), ...initial.uncertainContexts.map((context) => ({ type: 'uncertain-context', ...context })), ...Object.entries(initial.acts).map(([key, value]) => ({ type: 'act-key', key, ...value }))];
}

function finishedReport({ initial, applicableSamples, malformedLedgerLines, since, days, verdictPath, unproven, measures, rows, rollback, rollbackNotes }) {
  return { ok: true, complete: initial.complete && applicableSamples > 0 && !malformedLedgerLines, coverage: { ...initial.coverage, applicableSamples, malformedLedgerLines }, finishedAt: new Date().toISOString(), window: since ? `since ${since}` : `${days}d`, verdictPath, unproven, measures: { rules: measures.rules, coverage: measures.coverage, health: measures.health },
    scopes: initial.scopes, table: summarise(rows), rollback, rollbackNotes, scan: initial.stats };
}

export async function atomicLatest(path, report) {
  const temp = `${path}.${process.pid}.tmp`;
  try { await writeFile(temp, JSON.stringify(report, null, 2) + '\n'); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
   const options = { configDirs: [], projectsDirs: [], project: process.cwd(), days: 7 };
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--config-dir') options.configDirs.push(resolve(process.argv[++i]));
      else if (arg === '--projects-dir') options.projectsDirs.push(resolve(process.argv[++i]));
      else if (arg === '--project') options.project = resolve(process.argv[++i]);
       else if (arg === '--data-dir') options.dataDir = resolve(process.argv[++i]);
       else if (arg === '--serve-window-hours') options.serveWindowHours = serveWindowHours(process.argv[++i] ?? NaN);
       else if (arg === '--days') options.days = Number(process.argv[++i]);
        else if (arg === '--since') options.since = process.argv[++i];
       else if (arg === '--volume') options.volume = Number(process.argv[++i]);
       else if (arg === '--strict-measures') options.strictMeasures = true;
      else throw new Error(`unknown option: ${arg}`);
    }
     if (!options.configDirs.length) options.configDirs = (process.env.WT_ROD_CONFIG_DIRS?.split(delimiter).filter(Boolean) ?? [configDirectory(process.env)]).map((dir) => {
       if (!dir) throw new Error('HOME or USERPROFILE required to locate config directory');
       return resolve(dir);
     });
     if (!options.projectsDirs.length) options.projectsDirs = options.configDirs.map((dir) => join(dir, 'projects'));
     const report = await qualityCheck(options);
     console.log(JSON.stringify(report));
     if (options.strictMeasures) {
       const values = Object.values(report.measures.rules);
       if (values.some((item) => item.verdict === 'problem') || report.measures.health.status === 'problem') process.exitCode = 4;
       else if (values.some((item) => item.verdict !== 'OK') || report.measures.health.status !== 'OK' || !report.complete) process.exitCode = 3;
     }
  } catch (error) { console.error(`quality-check: ${error.message}`); process.exitCode = error.code === 'UNSAFE_DATA_DIR' ? 2 : 1; }
}
