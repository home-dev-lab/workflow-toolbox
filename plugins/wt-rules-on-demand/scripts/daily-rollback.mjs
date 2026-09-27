#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualityCheck } from './quality-check.mjs';
import { assertSafeDataDir, qualityDataDir } from './rule-lifecycle-lib.mjs';

export async function dailyRollback(options) {
  const startedAt = new Date().toISOString();
  const config = options.configDirs[0];
  const dataDir = await assertSafeDataDir(options.dataDir ?? qualityDataDir(config));
  await mkdir(dataDir, { recursive: true });
  const dailyDir = join(dataDir, 'daily');
  await mkdir(dailyDir, { recursive: true });
  const journalPath = join(dataDir, 'rollback-journal.jsonl');
  const result = { ok: false, reverted: [], refused: [], failed: [], attention: [], skipped: [], notificationsFailed: [] };
  let code = 0;
  try {
    let followed = [];
    try {
      followed = JSON.parse(await readFile(join(config, 'rules-on-demand', 'followed-projects.json'), 'utf8'));
      if (!Array.isArray(followed) || followed.some((item) => !item || typeof item.root !== 'string' || !isAbsolute(item.root)
        || typeof item.addedAt !== 'string' || typeof item.by !== 'string')) throw new Error('expected absolute roots with addedAt and by');
    } catch (error) {
      if (error.code !== 'ENOENT') result.attention.push({ reason: `followed-projects.json unreadable: ${error.message}; project rollback disabled` });
    }
    const active = [];
    for (const { root } of followed) {
      try { await readdir(join(root, '.claude', 'rules-on-demand')); active.push(root); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        result.skipped.push({ root, reason: 'on-demand rules directory missing' });
      }
    }
    const verdictPath = join(dailyDir, `verdicts-${new Date().toISOString().replace(/:/g, '-')}-${process.pid}.jsonl`);
     const report = await (options.checkQuality ?? qualityCheck)({ ...options, followedRoots: active, dataDir, verdictPath });
    const coverage = report.coverage ?? {};
    const scan = report.scan ?? {};
     let bad = scan.scopeErrors?.[0] ?? coverage.gitErrors?.[0] ?? coverage.unknownMigrationDates?.[0] ?? coverage.missingScopeEvidence?.[0] ?? null;
    if (scan.filesFailed) bad = `${scan.filesFailed} transcript files failed`;
    if (!bad && scan.badLines + coverage.missingTimestamps > scan.linesRead * 0.01) bad = 'malformed lines or missing timestamps exceed 1%';
    if (!bad && !report.complete) bad = 'coverage incomplete';
    if (bad) throw new Error(`incomplete evidence: ${bad}`);
    await options.afterQualityCheck?.(report);
     if (options.apply) for (const scope of report.scopes) {
       if (result.attention.some((item) => item.reason?.startsWith('followed-projects.json')) && scope.scope === 'project') continue;
      if (scope.scope === 'project' && !active.includes(scope.projectRoot)) continue;
      const args = [fileURLToPath(new URL('./rollback-check.mjs', import.meta.url)),
        ...(scope.scope === 'user' ? ['--user', '--config-dir', resolve(scope.rulesDir, '..')] : ['--project', scope.projectRoot]),
        '--json', '--verdicts', report.verdictPath, '--mechanical-only', '--journal', journalPath];
      if (scope.scope === 'user' && options.mirrorDirs?.length) args.push('--mirror-dir', options.mirrorDirs.join(','));
      const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
      let outcomes;
      try { outcomes = JSON.parse(run.stdout); } catch { throw new Error(`rollback-check ${scope.rulesDir}: ${run.stderr || run.stdout}`); }
      for (const item of outcomes) if (Object.hasOwn(result, item.action)) result[item.action].push(item);
      if (run.status !== 0) code = run.status === 3 ? Math.max(code, 3) : 1;
    }
    result.ok = code === 0;
    if (result.ok) {
      const files = (await readdir(dailyDir)).filter((name) => /^verdicts-.*\.jsonl$/.test(name)).sort();
      for (const name of files.slice(0, -14)) await rm(join(dailyDir, name));
    }
  } catch (error) { result.error = error.message; code = 1; }
  // Read back the journal: a child can revert and crash before returning its outcomes.
  try {
    const journal = await readFile(journalPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    const notify = options.notifyCommand ?? (process.env.WT_ROD_NOTIFY_COMMAND ? JSON.parse(process.env.WT_ROD_NOTIFY_COMMAND) : null);
    if (notify && (!Array.isArray(notify) || !notify.length || notify.some((arg) => typeof arg !== 'string' || !arg))) throw new Error('notify command must be a nonempty JSON argv array');
    const pending = new Map(), delivered = new Set(), fallback = new Set();
    const keyOf = (row) => JSON.stringify([row.scope, row.root ?? null, row.rule, row.at]);
    for (const line of journal.split('\n').filter(Boolean)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.action !== 'reverted' || !row.at) continue;
      const key = keyOf(row);
      if (row.state === 'delivered') delivered.add(key);
      else if (row.state === 'fallback') { fallback.add(key); pending.set(key, row); }
      else if (row.state || row.at >= startedAt) pending.set(key, row);
    }
    for (const [key, row] of pending) {
      if (delivered.has(key)) continue;
      if (row.state === 'pending') {
        const ledger = join(row.scope === 'user' ? config : row.root, row.scope === 'user' ? 'rules-on-demand-ledger.jsonl' : '.claude/rules-on-demand-ledger.jsonl');
        const text = await readFile(ledger, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
        const reverted = text.split('\n').some((line) => { try { const entry = JSON.parse(line); return entry.action === 'revert' && entry.rule === row.rule && Date.parse(entry.time) >= Date.parse(row.at); } catch { return false; } });
        if (!reverted) continue;
      }
      const payload = { event: 'rule reverted', scope: row.scope, root: row.root ?? null, rule: row.rule, reason: row.reason, at: row.at };
      if (notify) {
        const sent = spawnSync(notify[0], notify.slice(1), { input: JSON.stringify(payload) + '\n', encoding: 'utf8', shell: false });
        if (sent.error || sent.status !== 0) {
          result.notificationsFailed.push({ rule: row.rule, error: sent.error?.message ?? sent.stderr });
          if (!fallback.has(key)) {
            await appendFile(join(dataDir, 'revert-notifications.jsonl'), JSON.stringify(payload) + '\n');
            await appendFile(journalPath, JSON.stringify({ ...row, state: 'fallback' }) + '\n');
          }
          continue;
        }
      } else if (!fallback.has(key)) await appendFile(join(dataDir, 'revert-notifications.jsonl'), JSON.stringify(payload) + '\n');
      await appendFile(journalPath, JSON.stringify({ ...row, state: 'delivered' }) + '\n');
    }
  } catch (error) { result.notificationsFailed.push({ error: error.message }); }
  result.finishedAt = new Date().toISOString();
  await writeFile(join(dataDir, 'daily-rollback-latest.json'), JSON.stringify(result, null, 2) + '\n');
  return { result, code };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { configDirs: [], projectsDirs: [], mirrorDirs: [], project: process.cwd(), days: 7, apply: process.env.WT_ROD_REAL_REVERT === '1' };
  try {
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flag === '--config-dir') options.configDirs.push(resolve(process.argv[++i]));
      else if (flag === '--projects-dir') options.projectsDirs.push(resolve(process.argv[++i]));
      else if (flag === '--mirror-dir') options.mirrorDirs.push(resolve(process.argv[++i]));
      else if (flag === '--data-dir') options.dataDir = resolve(process.argv[++i]);
      else if (flag === '--project') options.project = resolve(process.argv[++i]);
      else if (flag === '--since') options.since = process.argv[++i];
      else if (flag === '--days') options.days = Number(process.argv[++i]);
      else if (flag === '--apply') options.apply = true;
      else if (flag === '--json') options.json = true;
      else throw new Error(`unknown option: ${flag}`);
    }
    if (!options.configDirs.length) options.configDirs = [resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))];
    if (!options.projectsDirs.length) options.projectsDirs = options.configDirs.map((dir) => join(dir, 'projects'));
    const { result, code } = await dailyRollback(options);
    if (options.json) console.log(JSON.stringify(result));
    else if (result.error) console.error(`daily-rollback: ${result.error}`);
    process.exitCode = code;
  } catch (error) { console.error(`daily-rollback: ${error.message}`); process.exitCode = 1; }
}
