#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile, stat, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleDirectories, configDirectory } from '../paths.js';
import { assertSafeDataDir, qualityDataDir } from '../scripts/rule-lifecycle-lib.mjs';
import { atomicLatest } from '../scripts/quality-check.mjs';
import { launchQuality } from '../scripts/launch-quality.mjs';
import { discoverFiles } from '../scripts/discover-files.mjs';
import { sameRule } from '../duplicate-rule.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || '{}');
if (event.source && event.source !== 'startup') process.exit(0);
const cwd = resolve(event.cwd || process.cwd());
const config = configDirectory(process.env);
if (process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS !== '1') process.stdout.write('wt-rules-on-demand: inactive: Function Hooks require CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1.\n');
if (!config) { process.stdout.write('wt-rules-on-demand: HOME or USERPROFILE unavailable; config directory unknown.\n'); process.exit(0); }
const paths = ruleDirectories(cwd, resolve(config));
const dangling = [];
const demand = [...await discoverFiles(paths.project, { dangling }), ...await discoverFiles(paths.user, { dangling })];
const staticFiles = (await Promise.all([paths.projectStatic, paths.userStatic].map((root) => discoverFiles(root, { recursive: true, dangling })))).flat();
for (const path of dangling) process.stdout.write(`wt-rules-on-demand: dangling symlink ${path}\n`);
if (!demand.length) process.exit(0);
const suppressed = new Set();
for (const [name, path] of demand) for (const [staticName, staticPath] of staticFiles) if (name === staticName) {
  const equal = sameRule(await readFile(staticPath, 'utf8'), await readFile(path, 'utf8'));
  if (equal) suppressed.add(path);
  process.stdout.write(equal ? `loaded twice: ${staticPath} and ${path}; the on-demand copy is not served\n` : `same name, different rule: ${staticPath} and ${path}\n`);
}
const enabled = ['true', '1'].includes(process.env.CLAUDE_PLUGIN_OPTION_ENABLED);
if (!enabled) {
  const unserved = demand.filter(([, path]) => !suppressed.has(path)).length;
  if (unserved) process.stdout.write(`wt-rules-on-demand: engine disabled; ${unserved} on-demand rules are neither static nor served. Enable wt-rules-on-demand userConfig enabled=true.\n`);
  process.exit(0);
}

const now = process.env.WT_ROD_NOW ? Date.parse(process.env.WT_ROD_NOW) : Date.now();
const dataDir = resolve(process.env.WT_ROD_QUALITY_DATA || qualityDataDir(config));
try { await assertSafeDataDir(dataDir); } catch (error) {
  const label = error.code === 'UNSAFE_DATA_DIR' ? 'refused data directory' : 'error ' + (error.constructor?.name ?? 'Error') + ' at';
  process.stdout.write(`rules-on-demand quality: ${label} ${dataDir}: ${error.message}; no check started\n`);
  process.exit(0);
}
const latestPath = join(dataDir, 'latest.json');
const notifications = await readFile(join(dataDir, 'revert-notifications.jsonl'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
if (notifications.trim()) {
  const entries = notifications.trim().split('\n');
  const recent = entries.at(-1);
  try {
    const item = JSON.parse(recent);
    process.stdout.write(`rules-on-demand: ${entries.length} recorded revert notification(s); latest ${item.scope} ${item.rule}; ${join(dataDir, 'revert-notifications.jsonl')}\n`);
  } catch { process.stdout.write(`rules-on-demand: revert notifications available at ${join(dataDir, 'revert-notifications.jsonl')}\n`); }
}
let latest;
try { latest = JSON.parse(await readFile(latestPath, 'utf8')); } catch { /* No previous report yet. */ }
const stamp = join(dataDir, `run-started-${new Date(now).toISOString().slice(0, 10)}`);
const lastStarted = await stat(stamp).then((info) => info.mtimeMs).catch(() => 0);
const lastReport = latest?.finishedAt ? Date.parse(latest.finishedAt) : 0;
if ((!lastReport || now - lastReport >= 24 * 3600000) && !lastStarted) {
  await mkdir(dataDir, { recursive: true });
  for (const name of await readdir(dataDir)) if (/^run-started-\d{4}-\d\d-\d\d$/.test(name) && now - Date.parse(name.slice(12)) > 7 * 86400000) await rm(join(dataDir, name), { force: true });
  try {
    await writeFile(stamp, new Date(now).toISOString(), { flag: 'wx' });
    const script = process.env.WT_ROD_QUALITY_SCRIPT || fileURLToPath(new URL(process.env.WT_ROD_REAL_REVERT === '1' ? '../scripts/daily-rollback.mjs' : '../scripts/quality-check.mjs', import.meta.url));
    const profiles = process.env.WT_ROD_CONFIG_DIRS?.split(delimiter).filter(Boolean) ?? [config];
    const args = [script, '--project', cwd, ...profiles.flatMap((dir) => ['--config-dir', dir]), '--data-dir', dataDir];
    if (process.env.WT_ROD_QUALITY_SPAWN === '0') await writeFile(join(dataDir, 'spawn-record.json'), JSON.stringify({ script, args }));
    else {
      const startedAt = Date.now();
       // Watchdog lives in a separate process because SessionStart must return promptly.
       launchQuality({ spawn, executable: process.execPath, args,
         watchdogArgs: (pid) => [fileURLToPath(new URL('../scripts/quality-watchdog.mjs', import.meta.url)), String(pid), latestPath, String(startedAt)],
         env: { ...process.env, WT_ROD_DAILY: '1' }, latestPath, publish: atomicLatest });
    }
  } catch (error) { if (error.code !== 'EEXIST') await atomicLatest(latestPath, { ok: false, finishedAt: new Date().toISOString(), error: `start: ${error.message}` }); }
}
if (process.env.CLAUDE_CODE_ENTRYPOINT?.startsWith('sdk')) process.exit(0);
if (!latest || !latest.ok || now - lastReport >= 36 * 3600000) {
   const errorDetail = latest?.error ? ` (${latest.error})` : '';
   process.stdout.write(`rules-on-demand quality: last successful check ${latest?.finishedAt ?? 'never'}; stale or failed${errorDetail}; ${latestPath}\n`);
}
else if (latest?.ok) {
   const profiles = process.env.WT_ROD_CONFIG_DIRS?.split(delimiter).filter(Boolean) ?? [config];
   const checked = new Set(await Promise.all((latest.scopes ?? []).map((scope) => realpath(scope.rulesDir).catch(() => resolve(scope.rulesDir)))));
   const missing = [];
   for (const dir of [...profiles.map((profile) => ruleDirectories(cwd, profile).user), paths.project]) {
     if ((await discoverFiles(dir)).length && !checked.has(await realpath(dir).catch(() => resolve(dir)))) missing.push(dir);
   }
   if (latest.scopes && missing.length) process.stdout.write(`rules-on-demand quality: scopes not checked: ${missing.join(', ')}; ${latestPath}\n`);
   const warnings = latest.rollback?.filter((item) => ['would revert', 'attention'].includes(item.action)) ?? [];
   if (warnings.length) {
     const suffix = `; ${latestPath}; nothing was reverted.`;
     let line = 'rules-on-demand quality (dry run): ';
     let shown = 0;
     for (const item of warnings) {
       const clause = `${item.scope} ${item.rule} (${item.action}: ${String(item.reason ?? '').slice(0, 80)})`;
       if (line.length + clause.length + suffix.length + 20 > 400) break;
       line += `${shown ? ', ' : ''}${clause}`;
       shown++;
     }
     if (shown < warnings.length) line += `, +${warnings.length - shown} more`;
     process.stdout.write(`${line}${suffix}\n`);
   }
   if (latest.complete === false) {
     const coverage = latest.coverage ?? {};
     const cause = coverage.unknownMigrationDates?.[0] ?? coverage.gitErrors?.[0] ?? coverage.unownedProjectsDirs?.[0] ?? coverage.missingProjectsDirs?.[0]
       ?? (coverage.malformedLedgerLines ? `${coverage.malformedLedgerLines} malformed ledger lines` : null);
      const detail = cause ? `: ${cause}` : '';
      process.stdout.write(`rules-on-demand quality: ${coverage.applicableSamples === 0 ? 'too few applicable samples' : 'coverage incomplete'}${detail}; ${latestPath}\n`);
   }
}
