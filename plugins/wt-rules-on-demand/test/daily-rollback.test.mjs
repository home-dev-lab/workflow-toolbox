import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('daily rollback does not count the user config rules as a project at the home root', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'rod-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, '.claude'), projects = join(config, 'projects');
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await mkdir(projects);
  await writeFile(join(config, 'rules-on-demand', 'sample.md'), `---
on-demand:
  triggers:
    - kind: tool
      tool: '^Agent$'
      unconditional: true
  compliance:
    kind: tool-input
    tool: '^Agent$'
    require-input-regex: 'yes'
    window: 1
    on-close: not applicable
---
Body\n`);
  const migrated = new Date(Date.now() - 2 * 86400000).toISOString();
  const at = new Date(Date.now() - 86400000).toISOString();
  await writeFile(join(config, 'rules-on-demand-ledger.jsonl'), JSON.stringify({ action: 'migrate', rule: 'sample.md', time: migrated }) + '\n');
  const workspace = join(home, 'workspace');
  const records = [
    { type: 'attachment', cwd: workspace, timestamp: at, attachment: { type: 'hook_additional_context', content: '<rule name="sample.md">Body</rule>', toolUseID: 'call-context' } },
    { type: 'assistant', cwd: workspace, timestamp: at, message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { prompt: 'yes' } }] } },
    { type: 'system', subtype: 'compact_boundary', cwd: workspace, timestamp: at },
    { type: 'user', cwd: workspace, timestamp: at, message: { content: 'next turn' } },
  ];
  await writeFile(join(projects, 'session.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const { result, code } = await dailyRollback({ configDirs: [config], projectsDirs: [projects], project: home, dataDir: join(home, 'quality') });
  assert.equal(code, 0, result.error);
  assert.deepEqual(result.reverted, []);
});

test('daily rollback fails closed when a distinct project rules directory cannot be read', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'rod-unreadable-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.claude'));
  await symlink('rules-on-demand', join(home, '.claude', 'rules-on-demand'));
  const { result, code } = await dailyRollback({ configDirs: [join(home, 'config')], projectsDirs: [], project: home, dataDir: join(home, 'quality') });
  assert.equal(code, 1);
  assert.match(result.error, /ELOOP/);
});
