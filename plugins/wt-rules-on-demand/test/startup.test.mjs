import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

const script = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
const watchdog = fileURLToPath(new URL('../scripts/quality-watchdog.mjs', import.meta.url));
const sample = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'sample'\n---\nSample\n`;
async function scope(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  return { root, config, project };
}
function start({ config, project }, env = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8', input: JSON.stringify({ source: 'startup', cwd: project }),
    env: cleanEnv({ CLAUDE_CONFIG_DIR: config, WT_ROD_QUALITY_SPAWN: '0', CLAUDE_PLUGIN_OPTION_ENABLED: 'false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', ...env }),
  });
}
test('empty scopes produce no output and no quality job', async (t) => {
  const s = await scope(t);
  const run = start(s);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.deepEqual(await readdir(s.config), ['rules-on-demand']);
});
test('disabled engine reports unserved rules and does not spawn', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  const run = start(s);
  assert.match(run.stdout, /engine disabled; 1 on-demand rules are neither static nor served/);
  assert.deepEqual(await readdir(s.config), ['rules-on-demand']);
});
test('cross-scope static duplicate named; enabled startup records correct quality arguments', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  await mkdir(join(s.project, '.claude/rules/wt'), { recursive: true });
   await writeFile(join(s.project, '.claude/rules/wt/sample.md'), 'Sample\n');
  const run = start(s, { WT_ROD_ENABLED: '0', CLAUDE_PLUGIN_OPTION_ENABLED: 'true' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /loaded twice: .*rules[\\/]wt[\\/]sample\.md and .*rules-on-demand[\\/]sample\.md; the on-demand copy is not served/);
  const record = JSON.parse(await readFile(join(s.config, 'plugins/data/wt-rules-on-demand/quality/spawn-record.json'), 'utf8'));
  assert.deepEqual(record.args.slice(1, 5), ['--project', s.project, '--config-dir', s.config]);
});
test('Function Hooks disabled notice appears even without rules', async (t) => {
  const s = await scope(t);
  assert.match(start(s, { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' }).stdout, /inactive: Function Hooks require/);
});
test('child that exits without a fresh report is failed, not mistaken for an old clean run', async (t) => {
  const s = await scope(t);
  const latest = join(s.config, 'latest.json');
  await writeFile(latest, JSON.stringify({ ok: true, finishedAt: '2020-01-01T00:00:00.000Z' }));
  const run = spawnSync(process.execPath, [watchdog, '99999999', latest], { encoding: 'utf8', timeout: 5000, env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(latest, 'utf8'));
  assert.equal(report.ok, false);
  assert.match(report.error, /exited without publishing/);
});
test('startup publishes failure when its daily child cannot run', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  const run = start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: '1', WT_ROD_QUALITY_SPAWN: '1', WT_ROD_QUALITY_SCRIPT: join(s.root, 'missing-script.mjs') });
  assert.equal(run.status, 0, run.stderr);
  const path = join(s.config, 'plugins/data/wt-rules-on-demand/quality/latest.json');
  let report;
  for (let i = 0; i < 30; i++) {
    report = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
    if (report?.ok === false) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(report?.ok, false);
  assert.match(report.error, /child exited without publishing|spawn:/);
});
test('zero applicable quality samples are labelled too few, never clean', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  const data = join(s.config, 'plugins/data/wt-rules-on-demand/quality');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'latest.json'), JSON.stringify({ ok: true, complete: false, coverage: { checkableRules: 1, applicableSamples: 0 }, finishedAt: new Date().toISOString(), rollback: [] }));
  const run = start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: 'true' });
  assert.match(run.stdout, /too few applicable samples/);
  assert.doesNotMatch(run.stdout, /quality: OK/);
});
test('plugin data environment selects quality directory for startup and its report', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  const data = join(s.root, 'wt-rules-on-demand-data');
   const run = start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: '1', CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: fileURLToPath(new URL('..', import.meta.url)) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'quality/spawn-record.json'), 'utf8')).args.at(-1), join(data, 'quality'));
  assert.deepEqual(await readdir(s.config), ['rules-on-demand']);
});
test('legacy startup switch alone cannot enable the engine', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  assert.match(start(s, { WT_ROD_ENABLED: '1' }).stdout, /engine disabled/);
});
test('hostile inherited plugin data cannot redirect startup writes', async (t) => {
  const s = await scope(t);
  const foreign = join(s.root, 'foreign-plugin');
  await mkdir(foreign);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  const inherited = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = foreign;
  let run;
  try {
    assert.equal(cleanEnv().CLAUDE_PLUGIN_DATA, undefined);
    run = start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: 'true' });
  }
  finally {
    if (inherited === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = inherited;
  }
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await readdir(foreign), []);
  assert.ok((await readdir(join(s.config, 'plugins/data/wt-rules-on-demand/quality'))).includes('spawn-record.json'));
});
test('first quality run is visible and missing scopes and causes are named', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  assert.match(start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: 'true' }).stdout, /last successful check never/);
  const data = join(s.config, 'plugins/data/wt-rules-on-demand/quality');
  await writeFile(join(data, 'latest.json'), JSON.stringify({ ok: true, complete: false, finishedAt: new Date().toISOString(), scopes: [], coverage: { applicableSamples: 2, unknownMigrationDates: ['project sample.md'] }, rollback: [] }));
  const output = start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: 'true' }).stdout;
  assert.match(output, /scopes not checked/);
  assert.match(output, /project sample.md/);
});
test('rollback warnings retain short reasons and fit the line budget', async (t) => {
  const s = await scope(t);
  await writeFile(join(s.config, 'rules-on-demand/sample.md'), sample);
  const data = join(s.config, 'plugins/data/wt-rules-on-demand/quality');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'latest.json'), JSON.stringify({ ok: true, complete: true, finishedAt: new Date().toISOString(), rollback: Array.from({ length: 20 }, (_, i) => ({ scope: 'user', rule: `rule-${i}.md`, action: 'would revert', reason: 'follow rate below threshold' })) }));
  const output = start(s, { CLAUDE_PLUGIN_OPTION_ENABLED: 'true' }).stdout;
  assert.match(output, /follow rate below threshold/);
  assert.match(output, /\+\d+ more/);
  assert.ok(output.split('\n')[0].length <= 400);
});
