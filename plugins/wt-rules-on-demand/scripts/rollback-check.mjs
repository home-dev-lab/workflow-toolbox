#!/usr/bin/env node
import { readFile, readdir, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEMAND_DIR, lastLifecycleTime, revertRule, rollbackDecision, qualityDataDir } from './rule-lifecycle-lib.mjs';
import { configDirectory, ruleDirectories } from '../paths.js';

const args = process.argv.slice(2);
const options = { project: process.cwd(), stores: [], verdictFiles: [], dryRun: false, json: false, user: false, configDir: '', mirrorDirs: [] };
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--project') options.project = args[++index] ?? '';
  else if (args[index] === '--store') options.stores.push(args[++index] ?? '');
  else if (args[index] === '--verdicts') options.verdictFiles.push(args[++index] ?? '');
  else if (args[index] === '--json') options.json = true;
  else if (args[index] === '--dry-run') options.dryRun = true;
  else if (args[index] === '--user') options.user = true;
  else if (args[index] === '--config-dir') options.configDir = args[++index] ?? '';
  else if (args[index] === '--mirror-dir') options.mirrorDirs = String(args[++index] ?? '').split(',').filter(Boolean).map((path) => resolve(path));
  else { console.error(`unknown option: ${args[index]}`); process.exit(2); }
}
if (!options.user && (options.configDir || options.mirrorDirs.length)) { console.error('--config-dir and --mirror-dir require --user'); process.exit(2); }
const project = resolve(options.project);
const scope = options.user ? 'user' : 'project';
const configDir = resolve(options.configDir || configDirectory(process.env) || (() => { throw new Error('HOME or USERPROFILE required'); })());
// User scope: the rules, ledger and default store live under the config dir.
// In-hook verdict archives are store keys; quality scan verdicts live under qualityDataDir(configDir).
const lifecycleRoot = scope === 'user' ? configDir : project;
const rulesDir = scope === 'user' ? ruleDirectories(project, configDir).user : ruleDirectories(project, configDir).project;

// Never report "nothing to roll back" over a directory that was never there: that exit 0 checked nothing.
let names;
try {
  names = (await readdir(rulesDir)).filter((name) => name.endsWith('.md'));
} catch (error) {
  if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  console.error(`rollback-check: on-demand rules directory does not exist: ${rulesDir} (${scope} scope${scope === 'user' ? '' : '; pass --user [--config-dir <dir>] for a config dir'}); refusing to report a scan that did not happen`);
  process.exit(1);
}

async function defaultStorePath() {
  const root = join(configDir, 'plugins', 'store');
  const names = (await readdir(root).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))).filter((name) => /^wt-rules-on-demand[_-].*\.json$/.test(name));
  if (!names.length) throw new Error(`no wt-rules-on-demand store found under ${root}`);
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
  if (options.stores.length) return options.stores;
  try { return [await defaultStorePath()]; } catch (error) {
    if (!options.verdictFiles.length) throw error;
    console.error(`rollback-check: ${error.message}; in-hook verdicts not read, transcript rows only`);
    return [];
  }
}
const stores = await Promise.all((await storePaths()).map(async (path) => JSON.parse(await readFile(resolve(path), 'utf8'))));
const store = { sessions: Object.assign({}, ...stores.map((item) => item.sessions ?? {})) };
const verdictLines = stores.map((item) => String(item['compliance-verdicts-jsonl'] ?? ''));
for (const item of stores) for (const [name, text] of Object.entries(item)) if (name.startsWith('compliance-verdicts-archive-')) verdictLines.push(String(text));
const verdicts = verdictLines.join('\n').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const transcriptRows = (await Promise.all(options.verdictFiles.map(async (path) => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))))).flat();
const rateSummary = [];
const realOr = (path) => realpath(path).catch((error) => (error.code === 'ENOENT' || error.code === 'ENOTDIR' ? resolve(path) : Promise.reject(error)));
// Where this profile's on-demand files must physically live for a revert to be this profile's to make.
const ownDemandDir = join(await realOr(lifecycleRoot), scope === 'user' ? 'rules-on-demand' : DEMAND_DIR);
const realRulesDir = await realOr(rulesDir);
// Rows name the PHYSICAL rules dir (a discovered project is realpath'd): compare physical paths on both sides.
const physicalOf = new Map();
for (const row of transcriptRows) if (row.rulesDir && !physicalOf.has(row.rulesDir)) physicalOf.set(row.rulesDir, await realOr(row.rulesDir));
let refused = 0;
const results = [];
const log = (message) => { if (!options.json) console.log(message); };

for (const name of names) {
  // The rule's last migration or revert, read from this profile's ledger and from the ledger beside the directory the
  // files physically live in (a profile whose on-demand directory is a symlink ledgers nothing of its own). Sessions
  // and acts older than it ran under the rule's previous state and are ignored (HIGH 1).
  const ledgerRoots = [...new Set([lifecycleRoot, scope === 'user' ? dirname(realRulesDir) : lifecycleRoot])];
  const cutoff = (await Promise.all(ledgerRoots.map((root) => lastLifecycleTime(root, name, scope)))).filter(Boolean).sort().at(-1) ?? '';
  const current = (time) => !cutoff || (typeof time === 'string' && time >= cutoff);
  const identity = `${scope}:${realRulesDir}:${name}`;
  const rows = transcriptRows.filter((row) => row.rule === name && row.scope === scope && row.rulesDir && physicalOf.get(row.rulesDir) === realRulesDir);
  // A scan that contains no rows for a rule is still the authoritative window when --verdicts is supplied.
  const kind = /^\s{4}kind:\s*['"]?([^'"\s]+)/m.exec(await readFile(join(rulesDir, name), 'utf8'))?.[1];
  const measured = options.verdictFiles.length && ['check', 'bash-command'].includes(kind);
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
  const scanRows = measured ? rows : verdicts.filter((row) => row.ruleIdentity === identity);
  const applicable = scanRows.filter((row) => row.rule === name && ['followed', 'not followed'].includes(row.verdict) && (measured || current(row.decidedAt)));
  const followed = applicable.filter((row) => row.verdict === 'followed').length;
  const { threshold, minimum } = policy(await readFile(join(rulesDir, name), 'utf8'));
  const evidence = rows.filter((row) => row.verdict === 'trigger miss').map((row) => `${row.file}:${row.line}`);
  const before = rows.filter((row) => row.phase === 'before' && ['followed', 'not followed'].includes(row.checkVerdict));
  const { reason, recommendation, rate, attention } = rollbackDecision({ triggerMiss: false,
    triggerMissUnmatched: options.verdictFiles.length ? rows.filter((row) => row.verdict === 'trigger miss' && row.triggerMatched === false).length : 0,
    triggerMissMatched: options.verdictFiles.length ? rows.filter((row) => row.verdict === 'trigger miss' && row.triggerMatched !== false).length : 0,
    triggerMissEvidence: rows.filter((row) => row.verdict === 'trigger miss' && row.triggerMatched === false).map((row) => `${row.file}:${row.line}`),
    followed, applicable: applicable.length, beforeFollowed: before.filter((row) => row.checkVerdict === 'followed').length,
    beforeApplicable: before.length, threshold, minimum });
  const result = { rule: name, scope, action: 'none', reason, recommendation, followed, applicable: applicable.length, triggerMissEvidence: evidence,
    ...(rows.length && rows[0].window ? { window: rows[0].window } : {}) };
    if (unprovenMiss) {
      result.reason = 'trigger miss unproven: store cannot show non-delivery';
      result.action = 'attention';
      results.push(result);
      log(`${name}: attention: ${result.reason}`);
      continue;
   }
   if (!reason) {
    log(`${name}: no rollback (${applicable.length} applicable verdicts; minimum ${minimum})`);
    results.push(result);
    continue;
  }
   if (attention) { result.action = 'attention'; results.push(result); log(`${name}: attention: ${reason}`); continue; }
  // A file that physically lives in another profile's directory (a symlinked on-demand directory or file) is not this
  // profile's to revert: the revert would delete the file the other profile serves (HIGH 1).
  const realFile = await realOr(join(rulesDir, name));
  if (realRulesDir !== ownDemandDir || dirname(realFile) !== ownDemandDir) {
    refused += 1;
    result.action = options.dryRun ? 'would refuse' : 'refused';
    results.push(result);
    log(`${options.dryRun ? 'would refuse to revert' : 'refused to revert'} ${name}: ${reason}; but ${join(rulesDir, name)} resolves to ${realFile}, outside this profile's ${ownDemandDir}: it belongs to another profile's directory, whose rollback-check owns it`);
    continue;
  }
  result.action = options.dryRun ? 'would revert' : 'reverted';
  results.push(result);
  log(`${options.dryRun ? 'would revert' : 'reverted'} ${name}: ${reason}`);
   if (!(options.verdictFiles.length && evidence.length)) rateSummary.push({ rule: name, reason, followed, applicable: applicable.length, followRate: rate, threshold, minimum });
  if (!options.dryRun) await revertRule(lifecycleRoot, name, reason, { scope, mirrorDirs: options.mirrorDirs });
}

if (rateSummary.length && !options.dryRun) {
  const report = { generatedAt: new Date().toISOString(), dryRun: options.dryRun, defaults: { threshold: 0.8, minimumSamples: 5 }, reverted: rateSummary };
   const path = join(qualityDataDir(configDir), 'rollback-latest.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  log(`summary ${path}`);
}

if (options.json) console.log(JSON.stringify(results));

// A refused revert is not a clean run: the rollback it would have made did not happen.
if (refused && !options.dryRun) process.exitCode = 3;
