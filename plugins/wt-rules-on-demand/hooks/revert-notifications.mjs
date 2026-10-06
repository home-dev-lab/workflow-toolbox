import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertSafeDataDir, qualityDataDir } from '../scripts/rule-lifecycle-lib.mjs';
import { rollbackOutcomeLines } from '../scripts/rollback-output.mjs';

export async function dailyRollbackLines(config, dataDir) {
  const lines = new Set();
  for (const dir of new Set([resolve(dataDir), qualityDataDir(config, {})])) {
    const path = join(dir, 'daily-rollback-latest.json');
    let exists = false;
    try {
      await lstat(path);
      exists = true;
      await assertSafeDataDir(dir);
      const result = JSON.parse(await readFile(path, 'utf8'));
      // Restorations already use the unchanged revert-notification channel at SessionStart.
      for (const line of rollbackOutcomeLines({ ...result, reverted: [] })) lines.add(line);
    } catch (error) {
      if (exists || !['ENOENT', 'ENOTDIR'].includes(error.code)) lines.add(`rules-on-demand rollback: daily report ${path}: unreadable: ${error.message}`);
    }
  }
  return lines.size ? [...lines].join('\n') + '\n' : '';
}

function collectNotificationEntries(text, entries) {
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      entries.set(JSON.stringify([row.scope, row.root ?? row.configDir ?? null, row.rule, row.at]), row);
    } catch { /* A partial line does not hide other notifications. */ }
  }
}

function latestNotificationLine(latest, count, files) {
  const failed = latest.event === 'rule restoration failed' ? 'restoration failed: ' : '';
  const reason = latest.reason ? ` (${String(latest.reason).slice(0, 160)})` : '';
  return `rules-on-demand: ${count} recorded revert notification(s); latest ${failed}${latest.scope} ${latest.rule}${reason}; ${files.join(', ')}\n`;
}

export async function revertNotificationLine(config, dataDir) {
  const entries = new Map(), files = [];
  for (const dir of new Set([resolve(dataDir), qualityDataDir(config, {})])) {
    try {
      await assertSafeDataDir(dir);
      const file = join(dir, 'revert-notifications.jsonl');
      const text = await readFile(file, 'utf8');
      if (!text.trim()) continue;
      files.push(file);
      collectNotificationEntries(text, entries);
    } catch { /* Missing or inaccessible reports do not abort startup. */ }
  }
  if (!files.length) return '';
  const latest = [...entries.values()].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? ''))).at(-1);
  if (!latest) return `rules-on-demand: revert notifications available at ${files.join(', ')}\n`;
  return latestNotificationLine(latest, entries.size, files);
}
