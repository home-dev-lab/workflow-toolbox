import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { instructionContent, limitsFor, measureStaticPrefix, staticPrefix } from '../scripts/prefix-size.mjs';
import { dailyRollback } from '../scripts/daily-rollback.mjs';
import { qualityDataDir } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const cli = fileURLToPath(new URL('../scripts/prefix-size.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));

async function put(path, text) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

// A home holding the user configuration directory, an instruction file of its own and one project below it: the
// same shape as a real machine, where the home directory is an ancestor of every project.
async function machine(t) {
  const home = await mkdtemp(join(tmpdir(), 'rod-prefix-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = join(home, '.claude');
  const project = join(home, 'work', 'project');
  await put(join(config, 'CLAUDE.md'), '');
  await put(join(config, 'rules', 'a.md'), '<!-- adopted header -->\nAlpha\n');
  await put(join(config, 'rules', 'wt', 'b.md'), 'Beta');
  await put(join(config, 'rules', 'scoped.md'), "---\npaths:\n  - 'src/**'\n---\nScoped\n");
  await put(join(config, 'rules', 'fm.md'), '---\ndescription: x\n---\nGamma\n');
  await put(join(home, 'CLAUDE.md'), 'home rules\n');
  await put(join(project, 'CLAUDE.md'), 'Project\n');
  await put(join(project, 'CLAUDE.local.md'), 'Local\n');
  await put(join(project, 'AGENTS.md'), 'Agents\n');
  await put(join(project, '.claude', 'CLAUDE.md'), 'Dot\n');
  await put(join(project, '.claude', 'rules', 'p.md'), 'P rule\n');
  return { home, config, project };
}

test('instructionContent strips frontmatter and comment blocks the way the harness does', () => {
  // The harness removes the comment text and keeps the line end (calibrated on a real adopted header: +1 char per file).
  assert.deepEqual(instructionContent('<!-- header -->\nAlpha\n'), { content: '\nAlpha\n', conditional: false });
  assert.equal(instructionContent('<!-- a\nb -->\nX\n').content, '\nX\n', 'a multi-line comment block leaves one line end');
  assert.deepEqual(instructionContent('---\ndescription: x\n---\nGamma\n'), { content: 'Gamma\n', conditional: false });
  assert.equal(instructionContent("---\npaths:\n  - 'src/**'\n---\nScoped\n").conditional, true);
  assert.equal(instructionContent("---\npaths: '**'\n---\nAll\n").conditional, false, 'a paths list of only ** is unconditional');
  // A comment inside a fenced code block is content, not a comment.
  const fenced = '```\n<!-- kept -->\n```\n';
  assert.equal(instructionContent(fenced).content, fenced);
  // A comment that does not open its line stays: the harness strips only comment blocks.
  assert.equal(instructionContent('Text <!-- inline --> more\n').content, 'Text <!-- inline --> more\n');
  // Text after the comment on the same line survives.
  assert.equal(instructionContent('<!-- a --> tail\nNext\n').content, ' tail\nNext\n');
});

test('staticPrefix counts the user config, every ancestor and the project like the harness, once per file', async (t) => {
  const { home, config, project } = await machine(t);
  let linked = true;
  try { await symlink(join(config, 'rules', 'wt', 'b.md'), join(config, 'rules', 'link.md')); } catch { linked = false; }
  const result = await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 1000 });
  const names = result.files.map((file) => file.path.slice(home.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(names, ['.claude/rules/a.md', '.claude/rules/fm.md', '.claude/rules/wt/b.md', 'CLAUDE.md',
    'work/project/.claude/CLAUDE.md', 'work/project/.claude/rules/p.md', 'work/project/CLAUDE.local.md', 'work/project/CLAUDE.md']);
  assert.equal(result.fileCount, 8);
  // \nAlpha\n 7 + Beta 4 + Gamma\n 6 + home rules\n 11 + Project\n 8 + Dot\n 4 + P rule\n 7 + Local\n 6
  assert.equal(result.totalChars, 53);
  assert.equal(result.status, 'ok');
  assert.ok(linked || process.platform === 'win32', 'symlink fixture must exist off Windows');
});

test('AGENTS.md loads only when no CLAUDE.md sits at the working directory or above it', async (t) => {
  const { home, config, project } = await machine(t);
  await rm(join(project, 'CLAUDE.md'));
  await rm(join(project, 'CLAUDE.local.md'));
  await rm(join(project, '.claude', 'CLAUDE.md'));
  let result = await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 1000 });
  assert.ok(!result.files.some((file) => file.path.endsWith('AGENTS.md')), 'home CLAUDE.md above cwd blocks AGENTS.md');
  await rm(join(home, 'CLAUDE.md'));
  result = await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 1000 });
  assert.ok(result.files.some((file) => file.path.endsWith(join('project', 'AGENTS.md'))), 'the user config CLAUDE.md does not block AGENTS.md');
});

test('the status warns below the limit and fails above it; a file over the per-file limit is left out of the total', async (t) => {
  const { home, config, project } = await machine(t);
  assert.equal((await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 56 })).status, 'warn');
  const over = await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 51 });
  assert.equal(over.status, 'over');
  assert.equal(over.largest[0].chars, 11);
  await put(join(project, '.claude', 'rules', 'huge.md'), 'x'.repeat(200));
  const capped = await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 1000, perFileLimit: 100 });
  assert.equal(capped.totalChars, 53);
  assert.equal(capped.files.find((file) => file.path.endsWith('huge.md')).overFileLimit, true);
  // Left out of the harness's combined count, but still loaded: never a green check.
  assert.equal(capped.loadedChars, 253);
  assert.equal(capped.status, 'warn');
  assert.equal((await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 150, perFileLimit: 100 })).status, 'over');
});

test('limits follow the context window the harness assumes: 150000 on 1M tokens, 120000 and 40000 per file on 200k', async (t) => {
  assert.deepEqual(limitsFor(1000000), { contextTokens: 1000000, perFileLimit: 150000, totalLimit: 150000 });
  assert.deepEqual(limitsFor(200000), { contextTokens: 200000, perFileLimit: 40000, totalLimit: 120000 });
  const { home, config, project } = await machine(t);
  await put(join(project, '.claude', 'rules', 'sixty.md'), 'y'.repeat(60000));
  const wide = await staticPrefix({ configDir: config, cwd: project, top: home });
  assert.equal(wide.totalChars, 60053, 'a 60k file counts on the 1M window');
  assert.equal(wide.totalLimit, 150000);
  const narrow = await staticPrefix({ configDir: config, cwd: project, top: home, contextTokens: 200000 });
  assert.equal(narrow.totalChars, 53, 'the same file is over the 40k per-file limit on 200k and left out');
  assert.equal(narrow.totalLimit, 120000);
});

test('a nested git worktree does not count the main repository ancestors above it', async (t) => {
  const { home, config } = await machine(t);
  const repo = join(home, 'repo');
  const tree = join(repo, '.claude', 'worktrees', 'lane');
  await put(join(repo, 'CLAUDE.md'), 'repo rules\n');
  await mkdir(join(repo, '.git', 'worktrees', 'lane'), { recursive: true });
  await writeFile(join(repo, '.git', 'worktrees', 'lane', 'commondir'), '../..\n');
  await put(join(tree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'lane')}\n`);
  await put(join(tree, 'CLAUDE.md'), 'lane\n');
  // The harness gates CLAUDE.md, .claude/CLAUDE.md and .claude/rules on the project test, never CLAUDE.local.md.
  await put(join(repo, 'CLAUDE.local.md'), 'mine\n');
  const result = await staticPrefix({ configDir: config, cwd: tree, top: home, totalLimit: 1000 });
  assert.ok(!result.files.some((file) => file.path === join(repo, 'CLAUDE.md')), 'repo CLAUDE.md sits inside the main checkout above the worktree');
  assert.ok(result.files.some((file) => file.path === join(tree, 'CLAUDE.md')));
  assert.ok(result.files.some((file) => file.path === join(repo, 'CLAUDE.local.md')), 'CLAUDE.local.md still loads above a nested worktree');
});

test('an unreadable rules directory makes the check unknown, never ok', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permission bits are not enforced here');
  const { home, config, project } = await machine(t);
  const locked = join(project, '.claude', 'rules');
  const { chmod } = await import('node:fs/promises');
  await chmod(locked, 0o000);
  const result = await staticPrefix({ configDir: config, cwd: project, top: home, totalLimit: 1000 });
  await chmod(locked, 0o755);
  assert.equal(result.status, 'unknown');
  assert.ok(result.errors.length > 0);
});

test('measureStaticPrefix checks each profile at home and at every known project root, worst status first', async (t) => {
  const { home, config, project } = await machine(t);
  const work = join(home, '.claude-second');
  await put(join(work, 'CLAUDE.md'), 'w\n');
  const other = join(home, 'work', 'other');
  await put(join(other, 'CLAUDE.md'), 'x'.repeat(40));
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await writeFile(join(config, 'rules-on-demand', 'followed-projects.json'), JSON.stringify([{ root: project, addedAt: '2026-01-01T00:00:00Z', by: 'test' }]));
  const transcript = join(config, 'projects', 'slug-other', 'session.jsonl');
  // The first records of a real transcript carry no cwd: the scan must read on until one does.
  await put(transcript, `${JSON.stringify({ type: 'mode' })}\n${JSON.stringify({ type: 'permission-mode' })}\n${JSON.stringify({ type: 'user', cwd: other })}\n`);
  await put(join(config, 'projects', 'slug-blind', 'session.jsonl'), `${JSON.stringify({ type: 'mode' })}\n`);
  const stale = join(config, 'projects', 'slug-gone', 'old.jsonl');
  await put(stale, `${JSON.stringify({ cwd: join(home, 'vanished') })}\n`);
  const old = join(work, 'projects', 'slug-old', 'old.jsonl');
  await put(old, `${JSON.stringify({ cwd: project })}\n`);
  const month = new Date(Date.now() - 30 * 86400000);
  await utimes(old, month, month);
  const report = await measureStaticPrefix({ configDirs: [config, work], home, top: home, days: 7, totalLimit: 60 });
  const key = (check) => `${check.configDir === config ? 'claude' : 'work'}:${check.root === home ? 'home' : check.root.slice(home.length + 1).replaceAll('\\', '/')}`;
  assert.deepEqual(report.checks.map(key).sort(), ['claude:home', 'claude:work/other', 'claude:work/project', 'work:home']);
  assert.equal(report.status, 'over');
  assert.equal(key(report.checks[0]), 'claude:work/other', 'worst check first');
  assert.equal(report.limit, 60);
  assert.ok(report.unresolved.some((path) => path.includes('slug-blind')), 'a project whose transcript names no cwd is listed, not dropped silently');
});

// macOS reaches the temporary directory through /var -> /private/var and Windows through 8.3 short names: a root
// found in a transcript must keep the spelling the session recorded, like every other root, or keys built from the
// home path land mid-segment. A symlinked home reproduces that spelling difference on Linux.
test('measureStaticPrefix reports a transcript root in the spelling the transcript recorded', async (t) => {
  if (process.platform === 'win32') return t.skip('directory symlinks need a privilege the runner may lack; the short-name spelling covers Windows');
  const real = await mkdtemp(join(tmpdir(), 'rod-prefix-real-'));
  const link = `${real}-link`;
  t.after(() => Promise.all([rm(real, { recursive: true, force: true }), rm(link, { force: true })]));
  await symlink(real, link, 'dir');
  const config = join(link, '.claude');
  const other = join(link, 'work', 'other');
  await put(join(other, 'CLAUDE.md'), 'x\n');
  await put(join(config, 'projects', 'slug-other', 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd: other })}\n`);
  const report = await measureStaticPrefix({ configDirs: [config], home: link, top: link, days: 7, totalLimit: 60 });
  assert.deepEqual(report.checks.map((check) => check.root).sort(), [link, other].sort());
});

test('the CLI prints one line per check and exits 4 when a check is over the limit', async (t) => {
  const { home, config, project } = await machine(t);
  const run = spawnSync(process.execPath, [cli, '--config-dir', config, '--project', project, '--home', home, '--top', home, '--limit', '51'], { encoding: 'utf8' });
  assert.equal(run.status, 4, run.stderr);
  assert.match(run.stdout, /over: 53 chars in 8 files, limit 51/);
  const ok = spawnSync(process.execPath, [cli, '--config-dir', config, '--project', project, '--home', home, '--top', home, '--limit', '1000'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});


const cleanQuality = async () => ({ complete: true, scan: { filesFailed: 0, badLines: 0, linesRead: 1 }, coverage: { missingTimestamps: 0 }, scopes: [] });
const prefixFile = (config) => join(qualityDataDir(config, {}), 'static-prefix-latest.json');

test('daily rollback measures the prefix, records it per profile, notifies once and exits 4 when it is over the limit', async (t) => {
  const { home, config, project } = await machine(t);
  const output = join(home, 'received.jsonl');
  const options = { configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality,
    prefix: { home, top: home, totalLimit: 51 },
    notifyCommand: [process.execPath, '-e', 'require("node:fs").appendFileSync(process.argv[1],require("node:fs").readFileSync(0))', output] };
  const { result, code } = await dailyRollback(options);
  assert.equal(code, 4);
  assert.equal(result.staticPrefix.status, 'over');
  const saved = JSON.parse(await readFile(join(home, 'quality', 'daily-rollback-latest.json'), 'utf8'));
  assert.equal(saved.staticPrefix.status, 'over');
  // The env-less data dir is the one a session's hook reads, whatever CLAUDE_PLUGIN_DATA says in either process.
  const recorded = JSON.parse(await readFile(prefixFile(config), 'utf8'));
  assert.equal(recorded.status, 'over');
  assert.ok(Date.parse(recorded.finishedAt) > 0);
  const sent = (await readFile(output, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, 'static prefix over limit');
  assert.equal(sent[0].checks[0].totalChars, 53);
  assert.match(sent[0].day, /^\d{4}-\d\d-\d\d$/);
});

test('a failed prefix notification never lands in the revert notifications', async (t) => {
  const { home, config, project } = await machine(t);
  const { result } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality,
    prefix: { home, top: home, totalLimit: 51 }, notifyCommand: [process.execPath, '-e', 'process.exit(1)'] });
  assert.equal(result.prefixNotifyFailed.length, 1);
  await assert.rejects(readFile(join(home, 'quality', 'revert-notifications.jsonl'), 'utf8'), { code: 'ENOENT' });
});

test('a session-launched run measures the prefix but leaves the alert to the nightly', async (t) => {
  const { home, config, project } = await machine(t);
  const output = join(home, 'received.jsonl');
  const previous = process.env.WT_ROD_DAILY;
  process.env.WT_ROD_DAILY = '1';
  t.after(() => { if (previous === undefined) delete process.env.WT_ROD_DAILY; else process.env.WT_ROD_DAILY = previous; });
  const { result } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality,
    prefix: { home, top: home, totalLimit: 51 },
    notifyCommand: [process.execPath, '-e', 'require("node:fs").appendFileSync(process.argv[1],require("node:fs").readFileSync(0))', output] });
  assert.equal(result.staticPrefix.status, 'over');
  await assert.rejects(readFile(output, 'utf8'), { code: 'ENOENT' });
});

test('daily rollback still measures the prefix when the quality evidence is incomplete, and an error keeps exit 1', async (t) => {
  const { home, config, project } = await machine(t);
  const { result, code } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'),
    prefix: { home, top: home, totalLimit: 51 },
    checkQuality: async () => ({ complete: false, scan: { filesFailed: 1 }, coverage: {}, scopes: [] }) });
  assert.equal(code, 1);
  assert.match(result.error, /incomplete evidence/);
  assert.equal(result.staticPrefix.status, 'over');
});

test('a prefix measurement that throws is an error, never a green night', async (t) => {
  const { home, config, project } = await machine(t);
  const { result, code } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality,
    measurePrefix: async () => { throw new Error('boom'); } });
  assert.equal(code, 1);
  assert.equal(result.staticPrefix.status, 'error');
  assert.match(result.staticPrefix.error, /boom/);
  assert.equal(JSON.parse(await readFile(prefixFile(config), 'utf8')).status, 'error');
});

test('the library does not measure the real home unless asked: existing callers stay hermetic', async (t) => {
  const { home, config, project } = await machine(t);
  const { result, code } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality });
  assert.equal(code, 0);
  assert.equal(result.staticPrefix, undefined);
});

test('the nightly CLI measures the prefix by default, from the home it runs under', async (t) => {
  const { home, config } = await machine(t);
  const script = fileURLToPath(new URL('../scripts/daily-rollback.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--config-dir', config, '--data-dir', join(home, 'quality'), '--prefix-limit', '20', '--json'],
    { encoding: 'utf8', cwd: home, env: cleanEnv({ HOME: home, USERPROFILE: home }) });
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(result.staticPrefix.status, 'over', run.stderr);
  assert.equal(result.staticPrefix.limit, 20);
});

async function hookRun(config, project, extra = {}) {
  return spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify({ source: 'startup', cwd: project }),
    env: cleanEnv({ CLAUDE_CONFIG_DIR: config, WT_ROD_QUALITY_SPAWN: '0', CLAUDE_PLUGIN_OPTION_ENABLED: 'false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', ...extra }) });
}

test('SessionStart surfaces a prefix over the limit from the last nightly run, engine on or off, with no on-demand rule', async (t) => {
  const { home, config, project } = await machine(t);
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'over', limit: 150000,
    checks: [{ configDir: config, root: project, status: 'over', totalChars: 186591, fileCount: 41, largest: [{ path: join(config, 'rules', 'a.md'), chars: 22064 }] }] }));
  for (const enabled of ['false', 'true']) {
    const run = await hookRun(config, project, { CLAUDE_PLUGIN_OPTION_ENABLED: enabled, WT_ROD_QUALITY_DATA: join(home, 'elsewhere') });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /static instruction prefix over the limit: 186591 chars in 41 files \(limit 150000\)/);
    assert.match(run.stdout, /a\.md \(22064\)/);
  }
});

test('SessionStart says so when the prefix measurement failed, is stale, or is missing after a nightly run', async (t) => {
  const { config, project } = await machine(t);
  const silent = await hookRun(config, project);
  assert.doesNotMatch(silent.stdout, /static instruction prefix/, 'no nightly at all: silent');
  await put(join(qualityDataDir(config, {}), 'daily-rollback-latest.json'), JSON.stringify({ finishedAt: new Date().toISOString() }));
  assert.match((await hookRun(config, project)).stdout, /static instruction prefix: not measured by the last nightly run/);
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'error', error: 'boom', checks: [] }));
  assert.match((await hookRun(config, project)).stdout, /static instruction prefix: measurement failed: boom/);
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date(Date.now() - 48 * 3600000).toISOString(), status: 'ok', limit: 150000, checks: [] }));
  assert.match((await hookRun(config, project)).stdout, /static instruction prefix: last measured .* stale/);
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'ok', limit: 150000, checks: [] }));
  assert.doesNotMatch((await hookRun(config, project)).stdout, /static instruction prefix/, 'a fresh ok measurement is silent');
});

test('a prefix record that cannot be written fails the night but still writes the nightly report', async (t) => {
  const { home, config, project } = await machine(t);
  // The env-less data dir path is occupied by a file: the record cannot be written there.
  await put(join(config, 'plugins', 'data', 'wt-rules-on-demand'), 'not a directory');
  const { result, code } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality,
    prefix: { home, top: home, totalLimit: 1000 } });
  assert.equal(code, 1);
  assert.match(result.staticPrefix.recordError, /plugins/);
  assert.equal(JSON.parse(await readFile(join(home, 'quality', 'daily-rollback-latest.json'), 'utf8')).staticPrefix.status, 'ok');
});

test('SessionStart names the check of the session it starts in before the worst one elsewhere', async (t) => {
  const { home, config, project } = await machine(t);
  const elsewhere = join(home, 'work', 'other');
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'over', limit: 150000, checks: [
    { configDir: config, root: elsewhere, status: 'over', totalChars: 262141, fileCount: 49, largest: [] },
    { configDir: config, root: project, status: 'over', totalChars: 186591, fileCount: 41, largest: [] }] }));
  const run = await hookRun(config, project);
  assert.match(run.stdout, /over the limit: 186591 chars in 41 files/);
});

test('the nightly measures the prefix as the run leaves it, after its own reverts', async (t) => {
  const { home, config, project } = await machine(t);
  // A revert moves a rule back into the static rules directory during the run.
  const reverting = async () => { await put(join(config, 'rules', 'reverted.md'), 'x'.repeat(40)); return cleanQuality(); };
  const { result, code } = await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: reverting,
    prefix: { home, top: home, totalLimit: 80 } });
  assert.equal(result.staticPrefix.checks.find((check) => check.root === project).totalChars, 93);
  assert.equal(code, 4);
});

test('a limit that is not a positive number, or a missing config dir, never reads as ok', async (t) => {
  const { home, config, project } = await machine(t);
  for (const totalLimit of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY])
    await assert.rejects(staticPrefix({ configDir: config, cwd: project, top: home, totalLimit }), /limit/);
  await assert.rejects(staticPrefix({ configDir: config, cwd: project, top: home, contextTokens: Number.NaN }), /context/);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/daily-rollback.mjs', import.meta.url)), '--config-dir', config, '--project', project, '--prefix-limit', 'abc'],
    { encoding: 'utf8', env: { ...cleanEnv(), HOME: home } });
  assert.notEqual(cli.status, 0);
  const typo = await staticPrefix({ configDir: join(home, '.claudee'), cwd: project, top: home });
  assert.equal(typo.status, 'unknown');
  assert.match(typo.errors.join('\n'), /config/);
});

test('a symlinked rules subdirectory is followed like the harness follows it, and imports resolve under a symlinked cwd', async (t) => {
  const { home, config, project } = await machine(t);
  const shared = join(home, 'shared-rules');
  await put(join(shared, 'linked.md'), 'Linked\n');
  await symlink(shared, join(config, 'rules', 'linked-dir'));
  const linked = await staticPrefix({ configDir: config, cwd: project, top: home });
  assert.ok(linked.files.some((file) => file.path.endsWith('linked.md')), 'the symlinked directory is walked');
  assert.equal(linked.totalChars, 60);
  const alias = join(home, 'alias');
  await symlink(project, alias);
  await put(join(project, 'docs', 'more.md'), 'More\n');
  await writeFile(join(project, 'CLAUDE.md'), 'Project\n@docs/more.md\n');
  const viaAlias = await staticPrefix({ configDir: config, cwd: alias, top: home });
  assert.ok(viaAlias.files.some((file) => file.path.endsWith('more.md')), 'an import inside the project is loaded under a symlinked cwd');
});

test('SessionStart words the line on the session own check, names files over the per-file limit, and still reports an over-limit check elsewhere', async (t) => {
  const { home, config, project } = await machine(t);
  const elsewhere = join(home, 'work', 'other');
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'over', limit: 150000, checks: [
    { configDir: config, root: elsewhere, status: 'over', totalChars: 262141, loadedChars: 262141, fileCount: 49, largest: [] },
    { configDir: config, root: project, status: 'warn', totalChars: 1000, loadedChars: 51000, fileCount: 3, totalLimit: 120000, perFileLimit: 40000, largest: [],
      files: [{ path: join(project, 'CLAUDE.md'), chars: 50000, overFileLimit: true }] }] }));
  const run = await hookRun(config, project);
  assert.match(run.stdout, /near the limit: 1000 chars in 3 files/);
  assert.match(run.stdout, /51000 chars loaded; over the per-file limit: CLAUDE\.md \(50000\)/);
  assert.doesNotMatch(run.stdout, /over the limit: 1000/);
  assert.match(run.stdout, /over the limit elsewhere: 262141 chars in 49 files .* at .*other/);
});

test('the elsewhere line and the CLI give the loaded figure when a file over the per-file limit makes a check over', async (t) => {
  const { home, config, project } = await machine(t);
  await put(join(home, 'work', 'other', 'CLAUDE.md'), 'x'.repeat(200));
  const measured = await measureStaticPrefix({ configDirs: [config], roots: [project, join(home, 'work', 'other')], home, top: home, totalLimit: 150, perFileLimit: 100 });
  const worst = measured.checks[0];
  assert.equal(worst.status, 'over');
  assert.ok(worst.loadedChars > worst.totalLimit && worst.totalChars < worst.totalLimit);
  await put(prefixFile(config), JSON.stringify({ ...measured, finishedAt: new Date().toISOString() }));
  const run = await hookRun(config, project);
  assert.match(run.stdout, new RegExp(`over the limit elsewhere: .*${worst.loadedChars} chars loaded`));
  const cliRun = spawnSync(process.execPath, [cli, '--config-dir', config, '--home', home, '--top', home, '--project', join(home, 'work', 'other'), '--limit', '150', '--per-file-limit', '100'],
    { encoding: 'utf8', env: cleanEnv({ HOME: home }) });
  assert.match(cliRun.stdout, /over: .*chars loaded/);
});

test('SessionStart marks a figure that is not the session own, and reports an incomplete check elsewhere', async (t) => {
  const { home, config, project } = await machine(t);
  const elsewhere = join(home, 'work', 'other');
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'over', limit: 150000, checks: [
    { configDir: config, root: elsewhere, status: 'over', totalChars: 262141, fileCount: 49, largest: [] }] }));
  const unmeasured = await hookRun(config, join(home, 'elsewhere-entirely'));
  assert.match(unmeasured.stdout, /no measurement for this session's directory/);
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'unknown', limit: 150000, checks: [
    { configDir: join(home, '.second'), root: elsewhere, status: 'unknown', totalChars: 10, fileCount: 1, errors: ['config dir missing'], largest: [] },
    { configDir: config, root: project, status: 'ok', totalChars: 10, fileCount: 1, largest: [] }] }));
  const incomplete = await hookRun(config, project);
  assert.match(incomplete.stdout, /measurement incomplete elsewhere: config dir missing/);
});

test('a malformed prefix record never stops the rest of SessionStart', async (t) => {
  const { config, project } = await machine(t);
  await put(prefixFile(config), JSON.stringify({ finishedAt: new Date().toISOString(), status: 'over', limit: 1, checks: [
    { configDir: config, root: project, status: 'over', totalChars: 5, fileCount: 1, largest: [{ chars: 1 }], files: [null] }] }));
  const run = await hookRun(config, project);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /TypeError/);
});

test('the nightly never reads a missing config dir as ok and never creates it', async (t) => {
  const { home, config, project } = await machine(t);
  const typo = join(home, '.claudee');
  const { result, code } = await dailyRollback({ configDirs: [config, typo], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality,
    prefix: { home, top: home } });
  assert.equal(code, 1);
  assert.ok(result.staticPrefix.checks.some((check) => check.configDir === typo && check.status === 'unknown'));
  await assert.rejects(readFile(join(typo, 'plugins', 'data', 'wt-rules-on-demand', 'quality', 'static-prefix-latest.json')));
  const first = await dailyRollback({ configDirs: [typo], projectsDirs: [], project, checkQuality: cleanQuality, prefix: { home, top: home } }).catch((error) => ({ error }));
  assert.ok(first.error || first.result.staticPrefix.checks.every((check) => check.status === 'unknown'), 'the default data dir must not hide the missing profile');
});

const historyFile = (config) => join(qualityDataDir(config, {}), 'static-prefix-history.jsonl');

test('each daily run appends one history line beside the latest file and leaves the latest shape unchanged', async (t) => {
  const { home, config, project } = await machine(t);
  const options = { configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality, prefix: { home, top: home, totalLimit: 51 } };
  await dailyRollback(options);
  await dailyRollback(options);
  const lines = (await readFile(historyFile(config), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const latest = JSON.parse(await readFile(prefixFile(config), 'utf8'));
  assert.equal(lines.length, 2);
  assert.match(lines[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?[+-]\d\d:\d\d$/);
  assert.equal(lines[0].status, 'over');
  assert.equal(lines[0].floorChars, Math.min(...latest.checks.map((check) => check.totalChars)));
  assert.deepEqual(lines[0].totals, latest.checks.map(({ configDir, root, totalChars, loadedChars, fileCount, status }) => ({ configDir, root, totalChars, loadedChars, fileCount, status })));
  assert.deepEqual(Object.keys(latest).sort(), ['checks', 'contextTokens', 'finishedAt', 'limit', 'status', 'unresolved', 'warnAt']);
});

test('the history keeps at most 400 lines and drops the oldest on write', async (t) => {
  const { home, config, project } = await machine(t);
  const file = historyFile(config);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, Array.from({ length: 400 }, (_, i) => JSON.stringify({ seed: i })).join('\n') + '\n');
  await dailyRollback({ configDirs: [config], projectsDirs: [], project, dataDir: join(home, 'quality'), checkQuality: cleanQuality, prefix: { home, top: home, totalLimit: 51 } });
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 400);
  assert.equal(lines[0].seed, 1);
  assert.equal(lines[398].seed, 399);
  assert.equal(lines[399].status, 'over');
});
