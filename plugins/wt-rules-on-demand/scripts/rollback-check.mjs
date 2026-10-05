#!/usr/bin/env node
import { readFile, readdir, mkdir, realpath, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEMAND_DIR, lastLifecycleTime, revertRule, revertIfStillProvisional, confirmMigration, requireMigrationProfiles, rollbackDecision, qualityDataDir, assertSafeDataDir, splitRuleIdentity } from './rule-lifecycle-lib.mjs';
import { provisionalMigration, provisionalRuleNames, migrationEvidence, serveWindowHours } from './serve-confirmation.mjs';
import { configDirectory, ruleDirectories } from '../paths.js';
import { createHash } from 'node:crypto';
import { verdictPath, readVerdicts, pendingRules, recordRollback } from './verdict-record.mjs';
import { rollbackStoreDirectory, rollbackArchiveDirectory, rollbackInputLocations } from './rollback-input-paths.mjs';
import { journalDeliveries, joinDeliveries } from './delivery-join.mjs';
import { readStoreArchives, readVerdictArchives, reportUnreadable, withArchivedSessions } from './store-archives.mjs';

const args = process.argv.slice(2);
const options = { project: process.cwd(), stores: [], storeArchiveDir: '', verdictFiles: [], dryRun: false, json: false, user: false, configDir: '', mirrorDirs: [], profileDirs: [], serveWindowHours: 168 };
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--project') options.project = args[++index] ?? '';
  else if (args[index] === '--store') options.stores.push(args[++index] ?? '');
  else if (args[index] === '--store-archives') options.storeArchiveDir = args[++index] ?? '';
  else if (args[index] === '--verdicts') options.verdictFiles.push(args[++index] ?? '');
  else if (args[index] === '--json') options.json = true;
  else if (args[index] === '--dry-run') options.dryRun = true;
  else if (args[index] === '--mechanical-only') options.mechanicalOnly = true;
  else if (args[index] === '--provisional-only') options.provisionalOnly = true;
  else if (args[index] === '--profile-dir') options.profileDirs.push(resolve(args[++index] ?? ''));
  else if (args[index] === '--serve-window-hours') options.serveWindowHours = serveWindowHours(args[++index] ?? NaN);
  else if (args[index] === '--journal') options.journal = args[++index] ?? '';
  else if (args[index] === '--user') options.user = true;
  else if (args[index] === '--config-dir') options.configDir = args[++index] ?? '';
  else if (args[index] === '--mirror-dir') options.mirrorDirs.push(resolve(args[++index] ?? ''));
  else { console.error(`unknown option: ${args[index]}`); process.exit(2); }
}
if (!options.user && (options.configDir || options.mirrorDirs.length)) { console.error('--config-dir and --mirror-dir require --user'); process.exit(2); }
if (options.mechanicalOnly && !options.verdictFiles.length && !options.provisionalOnly) { console.error('--mechanical-only requires --verdicts'); process.exit(2); }
const project = resolve(options.project);
const scope = options.user ? 'user' : 'project';
const configDir = resolve(options.configDir || configDirectory(process.env) || (() => { throw new Error('HOME or USERPROFILE required'); })());
// User scope: the rules, ledger and default store live under the config dir.
// In-hook verdict archives are store keys; quality scan verdicts live under qualityDataDir(configDir).
const lifecycleRoot = scope === 'user' ? configDir : project;
const rulesDir = scope === 'user' ? ruleDirectories(project, configDir).user : ruleDirectories(project, configDir).project;
const hasRecord = scope === 'project' && await readFile(verdictPath(project)).then(() => true, (error) => { if (error.code === 'ENOENT') { return false; } throw error; });
if (hasRecord && !options.provisionalOnly) await readVerdicts(project);

// Never report "nothing to roll back" over a directory that was never there: that exit 0 checked nothing.
const ledgerPath = join(lifecycleRoot, scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
let ledgerText = await readFile(ledgerPath, 'utf8').catch((error) => ['ENOENT', 'ENOTDIR'].includes(error.code) ? '' : Promise.reject(error));
const ledgerNames = provisionalRuleNames(ledgerText);
if (scope === 'project' && !options.dryRun && ledgerNames.length) {
  for (const name of ledgerNames) {
    const migration = provisionalMigration(ledgerText, name);
    await requireMigrationProfiles(lifecycleRoot, name, migration.migratedAt, migration.generation,
      options.profileDirs.length ? options.profileDirs : [configDir], { scope });
  }
  ledgerText = await readFile(ledgerPath, 'utf8');
}
let names;
try {
  names = (await readdir(rulesDir)).filter((name) => name.endsWith('.md'));
} catch (error) {
  if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  if (!ledgerNames.length) {
    console.error(`rollback-check: on-demand rules directory does not exist: ${rulesDir} (${scope} scope${scope === 'user' ? '' : '; pass --user [--config-dir <dir>] for a config dir'}); refusing to report a scan that did not happen`);
    process.exit(1);
  }
  names = [];
}
names = [...new Set([...names, ...ledgerNames])];

async function defaultStorePath() {
   const root = rollbackStoreDirectory(configDir);
   const names = (await readdir(root).catch((error) => (['ENOENT', 'ENOTDIR'].includes(error.code) ? [] : Promise.reject(error)))).filter((name) => rollbackInputLocations[0].namePattern.test(name));
  if (!names.length) throw Object.assign(new Error(`no wt-rules-on-demand store found under ${root}`), { code: 'STORE_ABSENT' });
  const candidates = await Promise.all(names.map(async (name) => ({ path: join(root, name), mtime: (await stat(join(root, name))).mtimeMs })));
  return candidates.sort((a, b) => b.mtime - a.mtime)[0].path;
}

function policy(text) {
  const threshold = Number(/^\s{4}rollback-threshold:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1] ?? 0.8);
  const minimum = Number(/^\s{4}rollback-min-samples:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1] ?? 5);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('rollback-threshold must be between 0 and 1');
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error('rollback-min-samples must be a positive integer');
  return { threshold, minimum };
}

// The store carries the in-hook verdicts of rules the transcript scan cannot measure (`model` kind): read it on the
// --verdicts path too. There, a missing store is stated and the scan rows still decide; without --verdicts it is fatal.
async function storePaths() {
  if (options.provisionalOnly) return [];
  if (options.stores.length) return options.stores;
  try { return [await defaultStorePath()]; } catch (error) {
    if (error.code !== 'STORE_ABSENT') unreadableStores.push({ path: rollbackStoreDirectory(configDir), error: error.message });
    if (!options.verdictFiles.length && (!hasProvisional || hasLegacy && error.code === 'STORE_ABSENT')) throw error;
    console.error(`rollback-check: ${error.message}; in-hook verdicts not read, transcript rows only`);
    return [];
  }
}
const hasProvisional = names.some((name) => provisionalMigration(ledgerText, name));
const hasLegacy = names.some((name) => !provisionalMigration(ledgerText, name));
const unreadableStores = [];
const stores = await Promise.all((await storePaths()).map(async (path) => {
  try { return JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch (error) { unreadableStores.push({ path, error: error.message }); return {}; }
}));
const archiveDir = await assertSafeDataDir(rollbackArchiveDirectory(configDir));
// Contexts the hook moved out of an over-budget store are summed back with their live segment: from the config dir's
// quality data for the default store, and for a named --store only from --store-archives (never another store's).
const storeKeyDir = options.stores.length ? options.storeArchiveDir : archiveDir;
// Every store copy (mirrors included) and every archive is a segment source of the same join (delivery-join.mjs). The
// stores were read above, before this directory is listed (store-archives.mjs).
const storeKeyRead = options.provisionalOnly ? { archives: [], unreadable: [] } : await readStoreArchives(storeKeyDir).catch((error) => {
  if (!hasProvisional) throw error;
  unreadableStores.push({ path: storeKeyDir, error: error.message });
  return { archives: [], unreadable: [{ path: storeKeyDir, error: error.message }] };
});
const store = { sessions: withArchivedSessions(storeKeyRead.archives, ...stores.map((item) => item.sessions)) };
const verdictLines = stores.map((item) => String(item['compliance-verdicts-jsonl'] ?? ''));
for (const item of stores) for (const [name, text] of Object.entries(item)) if (name.startsWith('compliance-verdicts-archive-')) verdictLines.push(String(text));
const verdictArchives = options.provisionalOnly ? { texts: [], unreadable: [] } : await readVerdictArchives(archiveDir);
for (const text of verdictArchives.texts) verdictLines.push(text);
const unreadableArchives = reportUnreadable('rollback-check', [...storeKeyRead.unreadable, ...verdictArchives.unreadable]);
const joined = joinDeliveries(verdictLines.join('\n').split('\n').filter(Boolean).map((line) => JSON.parse(line)), journalDeliveries(store.sessions), {
  contexts: Object.fromEntries(Object.entries(store.sessions).map(([id, session]) => [id, session.contexts ?? {}])), sessionOf: store.sessions });
const verdicts = joined.rows;
if (joined.copies.length || joined.duplicateRows.length || joined.discarded.length) console.error(`rollback-check: delivery join dropped ${joined.copies.length} copies, ${joined.duplicateRows.length} duplicate and ${joined.discarded.length} discarded in-hook rows`);
let legacyRowsSkipped = verdicts.filter((row) => !row.ruleIdentity).length;
const transcriptRows = (await Promise.all(options.verdictFiles.map(async (path) => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))))).flat();
const rateSummary = [];
const realOr = (path) => realpath(path).catch((error) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? resolve(path) : Promise.reject(error)));
// A recorded identity names the rules dir as the hook saw it; this check compares physical paths. Resolve each recorded
// directory once, so an alias of the same directory (macOS /var vs /private/var, a Windows 8.3 short name, a symlink)
// still names the same rule. An identity that does not parse is left as recorded and matches nothing.
const canonicalDirs = new Map();
async function canonicalIdentity(identity) {
  const parts = splitRuleIdentity(identity);
  if (!parts) return identity;
  if (!canonicalDirs.has(parts.dir)) canonicalDirs.set(parts.dir, await realOr(parts.dir));
  return `${parts.scope}:${canonicalDirs.get(parts.dir)}:${parts.name}`;
}
for (const row of verdicts) if (row.ruleIdentity) row.ruleIdentity = await canonicalIdentity(row.ruleIdentity);
for (const session of Object.values(store.sessions ?? {})) {
  for (const context of Object.values(session.contexts ?? {})) {
    legacyRowsSkipped += [...(context.governedActs ?? []), ...(context.complianceInjected ?? [])].filter((item) => !item?.ruleIdentity).length;
    for (const item of [...(context.governedActs ?? []), ...(context.complianceInjected ?? [])]) {
      if (item?.ruleIdentity) item.ruleIdentity = await canonicalIdentity(item.ruleIdentity);
    }
    for (const field of ['servedIdentity', 'suppressedIdentity']) {
      if (!context[field] || typeof context[field] !== 'object') continue;
      const merged = {};
      for (const [key, count] of Object.entries(context[field])) {
        const canonical = await canonicalIdentity(key);
        merged[canonical] = (merged[canonical] ?? 0) + (Number(count) || 0);
      }
      context[field] = merged;
    }
  }
}
if (legacyRowsSkipped) console.error(`rollback-check: legacy rows skipped: ${legacyRowsSkipped}`);
// Where this profile's on-demand files must physically live for a revert to be this profile's to make.
const ownDemandDir = join(await realOr(lifecycleRoot), scope === 'user' ? 'rules-on-demand' : DEMAND_DIR);
const realRulesDir = await realOr(rulesDir);
// Rows name the PHYSICAL rules dir (a discovered project is realpath'd): compare physical paths on both sides.
const physicalOf = new Map();
for (const row of transcriptRows) if (row.rulesDir && !physicalOf.has(row.rulesDir)) physicalOf.set(row.rulesDir, await realOr(row.rulesDir));
let refused = 0;
let failures = unreadableStores.length ? 1 : 0;
const exposureCache = new Map(), activityCache = new Map();
const results = [];
const log = (message) => { if (!options.json) console.log(message); };

function revertNotification(result) {
  return { ...result, action: 'reverted', at: new Date().toISOString(), ...(scope === 'user' ? { configDir } : { root: project }) };
}

async function journalRevert(notification, state) {
  if (options.journal) await appendFile(options.journal, JSON.stringify({ ...notification, state }) + '\n');
}

async function completeRevert(result, moved, notification, summary, summarize) {
  if (!moved.changed) { result.action = 'attention'; result.reason = moved.skipped ?? 'state changed'; return; }
  result.action = 'reverted';
  if (summarize) rateSummary.push({ rule: result.rule, reason: result.reason, ...summary });
  await journalRevert(notification, 'reverted');
  if (hasRecord) await recordRollback(project, moved.source, { reason: result.reason, ...summary });
}

async function reportRevertFailure(result, error) {
  failures += 1;
  if (result.action === 'reverted') result.reportingError = error.message;
  else {
    result.action = 'attention'; result.reason = `revert failed: ${error.message}`; result.restorationFailed = true;
    console.error(`rollback-check: ${result.rule}: ${result.reason}`);
    if (options.journal) await appendFile(options.journal, JSON.stringify({ ...result, state: 'restoration-failed', at: new Date().toISOString(), ...(scope === 'user' ? { configDir } : { root: project }) }) + '\n');
  }
}

async function moveRevert(name, reason, migration) {
  return migration
    ? revertIfStillProvisional(lifecycleRoot, name, migration.migratedAt, reason, { scope, mirrorDirs: options.mirrorDirs })
    : revertRule(lifecycleRoot, name, reason, { scope, mirrorDirs: options.mirrorDirs });
}

async function applyRevert(result, migration = null, summary = {}, summarize = true) {
  const name = result.rule, reason = result.reason;
  const realFile = await realOr(join(rulesDir, name));
  if (realRulesDir !== ownDemandDir || dirname(realFile) !== ownDemandDir) {
    refused += 1;
    result.action = options.dryRun ? 'would refuse' : 'refused';
    log(`refused to revert ${name}: ${reason}; ${realFile} belongs to another profile's directory`);
    return;
  }
  result.action = 'would revert';
  if (options.dryRun) return;
  try {
    const notification = revertNotification(result);
    await journalRevert(notification, 'pending');
    const moved = await moveRevert(name, reason, migration);
    await completeRevert(result, moved, notification, summary, summarize);
  } catch (error) {
    await reportRevertFailure(result, error);
    if (!migration) throw error;
  }
}

async function provisionalOutcome(name, migration) {
  const result = { rule: name, scope, action: 'none', reason: '' };
  if (!migration) return result;
  const evidence = await migrationEvidence(migration, name, { scope, configDir, root: project, profileDirs: options.profileDirs,
    stores: options.stores, archiveDir: options.storeArchiveDir, windowHours: options.serveWindowHours, exposureCache, activityCache });
  result.provisional = evidence.annotation;
  if (evidence.decision === 'confirm') {
    if (options.dryRun) result.wouldConfirm = true;
    else {
      try {
        const confirmed = await confirmMigration(lifecycleRoot, name, migration.migratedAt, evidence.annotation, { scope });
        if (confirmed.changed) result.confirmedNow = true;
        else { result.action = 'attention'; result.reason = confirmed.skipped; }
      } catch (error) { result.action = 'attention'; result.reason = `confirmation failed: ${error.message}`; }
    }
  } else if (evidence.decision === 'revert') {
    result.reason = evidence.reason;
    await applyRevert(result, migration);
  } else if (evidence.decision === 'attention') { result.action = 'attention'; result.reason = evidence.reason; }
  else if (options.provisionalOnly) result.reason = evidence.reason;
  return result;
}

for (const name of names) {
  const migration = provisionalMigration(ledgerText, name);
  if (options.provisionalOnly && !migration) continue;
  if (unreadableStores.length) {
    const result = { rule: name, scope, action: 'attention', reason: `store unreadable: ${unreadableStores[0].path}: ${unreadableStores[0].error}`, unreadableStores };
    results.push(result); log(`${name}: attention: ${result.reason}`); continue;
  }
  if (migration) {
    const present = await stat(join(rulesDir, name)).catch((error) => ['ENOENT', 'ENOTDIR'].includes(error.code) ? null : Promise.reject(error));
    if (!present?.isFile()) {
      failures += 1;
      const result = { rule: name, scope, action: 'attention', deliveryLoss: true, reason: `delivery loss: provisional on-demand rule missing: ${join(rulesDir, name)}` };
      results.push(result); log(`${name}: attention: ${result.reason}`); continue;
    }
  }
  const annotation = await provisionalOutcome(name, migration);
  const provisionalAttention = annotation.reason.startsWith('loaded but never served') ? annotation.reason : '';
  if (!options.provisionalOnly && provisionalAttention) { annotation.action = 'none'; annotation.reason = ''; }
  if (options.provisionalOnly || annotation.action !== 'none') {
    results.push(annotation); log(`${name}: ${annotation.action}: ${annotation.reason}`); continue;
  }
  // The rule's last migration or revert, read from this profile's ledger and from the ledger beside the directory the
  // files physically live in (a profile whose on-demand directory is a symlink ledgers nothing of its own). Sessions
  // and acts older than it ran under the rule's previous state and are ignored (HIGH 1).
  const ledgerRoots = [...new Set([lifecycleRoot, scope === 'user' ? dirname(realRulesDir) : lifecycleRoot])];
   const cutoff = (await Promise.all(ledgerRoots.map((root) => lastLifecycleTime(root, name, scope)))).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';
   const current = (time) => !!cutoff && Number.isFinite(Date.parse(time)) && Date.parse(time) > Date.parse(cutoff);
  const identity = `${scope}:${realRulesDir}:${name}`;
  const rows = transcriptRows.filter((row) => row.rule === name && row.scope === scope && row.rulesDir && physicalOf.get(row.rulesDir) === realRulesDir);
  // A scan that contains no rows for a rule is still the authoritative window when --verdicts is supplied.
  const kind = /^\s{4}kind:\s*['"]?([^'"\s]+)/m.exec(await readFile(join(rulesDir, name), 'utf8'))?.[1];
    // next-call is decided live, not reconstructed from transcripts, including when --verdicts is supplied.
    const measured = options.verdictFiles.length && ['check', 'bash-command', 'tool-input', 'turn-correlation'].includes(kind);
  // Only transcripts can establish non-delivery. In store-only mode, a governed act without
  // a delivery record for this identity in its context is unknown, regardless of other fields.
  // When transcript verdicts are supplied, the scan window decides independently of old sessions.
  let unprovenMiss = false;
  if (!options.verdictFiles.length) for (const session of Object.values(store.sessions ?? {})) {
    if (!current(session.last)) continue;
    for (const context of Object.values(session.contexts ?? {})) {
      const governed = (context.governedActs ?? []).some((act) => act.ruleIdentity === identity && current(act.last ?? act.at ?? session.last));
      const delivered = (context.complianceInjected ?? []).some((item) => item.ruleIdentity === identity) ||
        ['servedIdentity', 'suppressedIdentity'].some((field) => (context[field]?.[identity] ?? 0) > 0);
      if (governed && !delivered) unprovenMiss = true;
    }
  }
   const afterRows = rows.filter((row) => current(row.at));
   const scanRows = measured ? afterRows : verdicts.filter((row) => row.ruleIdentity === identity);
  const applicable = scanRows.filter((row) => row.rule === name && ['followed', 'not followed'].includes(row.verdict) && (measured || current(row.decidedAt)));
  const followed = applicable.filter((row) => row.verdict === 'followed').length;
  const { threshold, minimum } = policy(await readFile(join(rulesDir, name), 'utf8'));
   const evidence = afterRows.filter((row) => row.verdict === 'trigger miss').map((row) => `${row.file}:${row.line}`);
  const before = rows.filter((row) => row.phase === 'before' && ['followed', 'not followed'].includes(row.checkVerdict));
   const { reason, recommendation, rate, pValue, attention, revert } = rollbackDecision({ triggerMiss: false,
     triggerMissUnmatched: options.verdictFiles.length ? afterRows.filter((row) => row.verdict === 'trigger miss' && row.triggerMatched === false).length : 0,
     triggerMissMatched: options.verdictFiles.length ? afterRows.filter((row) => row.verdict === 'trigger miss' && row.triggerMatched !== false).length : 0,
     triggerMissEvidence: afterRows.filter((row) => row.verdict === 'trigger miss' && row.triggerMatched === false).map((row) => `${row.file}:${row.line}`),
    followed, applicable: applicable.length, beforeFollowed: before.filter((row) => row.checkVerdict === 'followed').length,
    beforeApplicable: before.length, threshold, minimum });
     const result = { ...annotation, reason: reason || provisionalAttention, recommendation, pValue, followed, applicable: applicable.length, triggerMissEvidence: evidence,
      ...(rows.length && rows[0].window ? { window: rows[0].window } : {}) };
    if (!cutoff) {
      result.action = 'attention'; result.reason = 'migration instant unknown; automatic rollback unavailable';
      results.push(result); log(`${name}: attention: ${result.reason}`); continue;
    }
   if (options.mechanicalOnly && !measured) {
     result.action = 'attention';
      result.reason = ['transcript check unavailable; store-only evidence cannot authorize automatic rollback', provisionalAttention].filter(Boolean).join('; ');
     results.push(result);
     log(`${name}: attention: ${result.reason}`);
     continue;
   }
    if (unprovenMiss) {
       result.reason = ['trigger miss unproven: store cannot show non-delivery', provisionalAttention].filter(Boolean).join('; ');
      result.action = 'attention';
      results.push(result);
      log(`${name}: attention: ${result.reason}`);
      continue;
   }
    if (!reason && !revert) {
     if (provisionalAttention) result.action = 'attention';
    log(`${name}: no rollback (${applicable.length} applicable verdicts; minimum ${minimum})`);
    results.push(result);
    continue;
  }
    if (attention) { result.action = 'attention'; results.push(result); log(`${name}: attention: ${reason}`); continue; }
    if (!revert) { results.push(result); log(`${name}: no rollback: ${reason}`); continue; }
   await applyRevert(result, null, { pValue, followed, applicable: applicable.length, rate, followRate: rate, threshold, minimum }, !(options.verdictFiles.length && evidence.length));
   results.push(result);
   log(`${result.action} ${name}: ${result.reason}`);
}

if (rateSummary.length && !options.dryRun) {
  const report = { generatedAt: new Date().toISOString(), dryRun: options.dryRun, defaults: { threshold: 0.8, minimumSamples: 5 }, reverted: rateSummary };
    const suffix = scope === 'user' ? 'user' : `project-${createHash('sha256').update(await realOr(project)).digest('hex').slice(0, 12)}`;
    const path = join(qualityDataDir(configDir), `rollback-${suffix}-latest.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  log(`summary ${path}`);
}

const pending = hasRecord ? await pendingRules(project) : [];
for (const row of pending) {
  const priorState = row.priorState ? `changed since ${row.priorState}` : 'new';
  console.error(`rollback-check: pending ${row.rule}: ${priorState}`);
}
if (options.json) console.log(JSON.stringify(results.map((result) => ({ ...result, unreadableArchives }))));

// A refused revert is not a clean run: the rollback it would have made did not happen.
if (refused && !options.dryRun) process.exitCode = 3;
else if (failures) process.exitCode = 1;
