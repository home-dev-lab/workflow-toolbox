import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dailyRollback } from '../scripts/daily-rollback.mjs';

test('daily rollback gates mutations on coverage and records a durable fallback notification', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rod-daily-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { configDirs: [dir], projectsDirs: [], project: dir, dataDir: join(dir, 'quality'), apply: true,
    checkQuality: async () => ({ complete: false, scan: { filesFailed: 1 }, coverage: {}, scopes: [] }) };
  let run = await dailyRollback(options);
  assert.match(run.result.error, /incomplete evidence: 1 transcript files failed/);
  assert.deepEqual(run.result.reverted, []);
  options.checkQuality = async () => ({ complete: true, scan: { filesFailed: 0, badLines: 0, linesRead: 1 }, coverage: { missingTimestamps: 0 }, scopes: [] });
  options.afterQualityCheck = async () => writeFile(join(options.dataDir, 'rollback-journal.jsonl'), JSON.stringify({ action: 'reverted', at: new Date(Date.now() + 1000).toISOString(), rule: 'example.md', scope: 'user' }) + '\n');
  run = await dailyRollback(options);
  assert.equal(run.code, 0);
  const notice = JSON.parse(await readFile(join(options.dataDir, 'revert-notifications.jsonl'), 'utf8'));
  assert.equal(notice.rule, 'example.md');
});

test('daily rollback invokes argv notification command with JSON on stdin', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rod-notify-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'received.json');
  const options = { configDirs: [dir], projectsDirs: [], project: dir, dataDir: join(dir, 'quality'), notifyCommand: [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],require("node:fs").readFileSync(0))', output],
    checkQuality: async () => ({ complete: true, scan: { filesFailed: 0, badLines: 0, linesRead: 1 }, coverage: { missingTimestamps: 0 }, scopes: [] }),
    afterQualityCheck: async () => writeFile(join(dir, 'quality', 'rollback-journal.jsonl'), JSON.stringify({ action: 'reverted', at: new Date(Date.now() + 1000).toISOString(), rule: 'example.md', scope: 'user' }) + '\n') };
  const { result } = await dailyRollback(options);
  assert.deepEqual(result.notificationsFailed, []);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).rule, 'example.md');
});
