#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, realpath, writeFile, rm, rename } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { ruleDirectories, configDirectory } from '../paths.js';
import { fileURLToPath } from 'node:url';
import { assertSafeDataDir, qualityDataDir } from './rule-lifecycle-lib.mjs';
import { readFile } from 'node:fs/promises';
import { scanTranscripts, summarise } from './transcript-verdicts.mjs';

export async function qualityCheck({ configDirs, projectsDirs, project, followedRoots = [], dataDir, days = 7, since, verdictPath: privateVerdictPath }) {
  const target = await assertSafeDataDir(dataDir ?? qualityDataDir(configDirs[0]));
  await mkdir(target, { recursive: true });
  const latest = join(target, 'latest.json');
  try {
    const scopes = [];
    const physical = new Set();
    for (const configDir of configDirs) {
       const rulesDir = ruleDirectories(project, configDir).user;
      const resolved = await realpath(rulesDir).catch(() => null);
      if (!resolved) continue;
      // A config dir whose rules dir is another's (a symlinked mirror) shares that scope: its transcripts are the same
      // rules' transcripts, so it joins the scope's owners rather than being dropped.
      const shared = scopes.find((scope) => scope.rulesDir === resolved);
       if (shared) {
         if (!shared.configDirs.includes(configDir)) shared.configDirs.push(configDir);
         continue;
       }
      if (physical.has(resolved)) continue;
      physical.add(resolved);
      if ((await readdir(resolved)).some((name) => name.endsWith('.md')))
        scopes.push({ scope: 'user', rulesDir: resolved, configDir: resolve(resolved, '..'), configDirs: [...new Set([configDir, resolve(resolved, '..')])], ledgerRoots: [resolve(resolved, '..')] });
    }
    for (const root of new Set([project, ...followedRoots])) {
      const candidate = ruleDirectories(root, configDirs[0]).project;
      if ((await readdir(candidate).catch(() => [])).some((name) => name.endsWith('.md'))) {
        const resolved = await realpath(candidate);
        scopes.push({ scope: 'project', projectRoot: root, rulesDir: resolved, ledgerRoots: [root] });
      }
    }
      const initial = await scanTranscripts({ projectsDirs, scopes, days, since, discoverProjects: true, nonProofNames: process.env.WT_ROD_NON_PROOF_NAMES?.split(',').filter(Boolean) ?? [] });
    if (!initial.stats.filesRead) throw new Error(`0 transcript files read; skipped ${initial.stats.skipped.length}: ${initial.stats.skipped.join('; ')}`);
    const rows = initial.rows;
    const date = new Date().toISOString().slice(0, 10);
     const verdictPath = privateVerdictPath ?? join(target, `verdicts-${date}.jsonl`);
     if (privateVerdictPath && (resolve(privateVerdictPath) !== resolve(target, 'daily', privateVerdictPath.split(/[\\/]/).at(-1)))) throw new Error('private verdict path must be inside the daily quality directory');
    await writeFile(verdictPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
    const rollback = [], rollbackNotes = [];
    for (const scope of initial.scopes) {
      // The only invocation site of rollback-check: ALWAYS a dry-run, including on errors and all project scopes.
      const args = [fileURLToPath(new URL('./rollback-check.mjs', import.meta.url)), '--dry-run', '--json', '--verdicts', verdictPath,
          ...(scope.scope === 'user' ? ['--user', '--config-dir', resolve(scope.rulesDir, '..')] : ['--project', scope.projectRoot])];
      const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`rollback-check ${scope.rulesDir}: ${run.stderr || run.stdout}`);
      rollback.push(...JSON.parse(run.stdout));
      rollbackNotes.push(...run.stderr.split('\n').filter((line) => line.startsWith('rollback-check:')));
    }
      const latestMigration = new Map();
      let malformedLedgerLines = 0;
     for (const scope of initial.scopes) for (const root of scope.ledgerRoots ?? [scope.scope === 'user' ? resolve(scope.rulesDir, '..') : scope.projectRoot]) {
       const file = join(root, scope.scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
       const lines = (await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))).split('\n');
       for (const line of lines) if (line.trim()) {
          let row;
          try { row = JSON.parse(line); } catch { malformedLedgerLines++; continue; }
         const key = `${scope.scope}:${row.rule}`;
         if (row.action === 'migrate') latestMigration.set(key, row);
         if (row.action === 'revert' || row.action === 'retire') latestMigration.delete(key);
       }
     }
     const unproven = [...latestMigration.entries()].filter(([, row]) => row.unproven).map(([key, row]) => ({ scope: key.split(':')[0], rule: row.rule, reason: row.noProofReason }));
     const applicableSamples = rows.filter((row) => ['followed', 'not followed'].includes(row.verdict)).length;
       const report = { ok: true, complete: initial.complete && applicableSamples > 0 && !malformedLedgerLines, coverage: { ...initial.coverage, applicableSamples, malformedLedgerLines }, finishedAt: new Date().toISOString(), window: since ? `since ${since}` : `${days}d`, verdictPath, unproven,
       scopes: initial.scopes, table: summarise(rows), rollback, rollbackNotes, scan: initial.stats };
    await writeFile(join(target, `quality-${date}.json`), JSON.stringify(report, null, 2) + '\n');
     await atomicLatest(latest, report);
    const archives = (await readdir(target)).filter((name) => /^(?:quality-.*\.json|verdicts-.*\.jsonl)$/.test(name)).sort();
    for (const prefix of ['quality-', 'verdicts-']) for (const name of archives.filter((item) => item.startsWith(prefix)).slice(0, -14)) await rm(join(target, name));
    return report;
  } catch (error) {
     await atomicLatest(latest, { ok: false, finishedAt: new Date().toISOString(), error: error.message });
    throw error;
  }
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
       else if (arg === '--days') options.days = Number(process.argv[++i]);
       else if (arg === '--since') options.since = process.argv[++i];
      else throw new Error(`unknown option: ${arg}`);
    }
     if (!options.configDirs.length) options.configDirs = (process.env.WT_ROD_CONFIG_DIRS?.split(delimiter).filter(Boolean) ?? [configDirectory(process.env)]).map((dir) => {
       if (!dir) throw new Error('HOME or USERPROFILE required to locate config directory');
       return resolve(dir);
     });
     if (!options.projectsDirs.length) options.projectsDirs = options.configDirs.map((dir) => join(dir, 'projects'));
    console.log(JSON.stringify(await qualityCheck(options)));
  } catch (error) { console.error(`quality-check: ${error.message}`); process.exitCode = error.code === 'UNSAFE_DATA_DIR' ? 2 : 1; }
}
