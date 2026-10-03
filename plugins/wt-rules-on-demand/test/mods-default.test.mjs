import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';
import { claudeVersion, modsOnByDefault } from '../scripts/claude-version.mjs';
import { recentActivity } from '../scripts/engine-activity.mjs';

// Claude Code 2.1.287 loads mods (Function Hooks plugins) by default and ignores CLAUDE_CODE_ENABLE_FUNCTION_HOOKS.
// The profile check before a user-scope migration must accept that, and accept a plugin loaded with --plugin-dir
// (not listed in enabledPlugins) once the profile's own store shows the engine active there recently.

const cli = fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url));
const ruleName = 'sample-rule.md';
const spec = { 'on-demand': { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }] }, compliance: { kind: 'none', reason: 'fixture' } };
const OLD = { CLAUDE_CODE_EXECPATH: '/opt/claude/versions/2.1.286' };
const NEW = { CLAUDE_CODE_EXECPATH: '/opt/claude/versions/2.1.287' };
const DAY = 86400000;
const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const STORE = 'wt-rules-on-demand_inline-0123456789ab.json';

test('claudeVersion reads the running binary from CLAUDE_CODE_EXECPATH, then AI_AGENT, else unknown', () => {
  assert.deepEqual(claudeVersion({ CLAUDE_CODE_EXECPATH: '/home/u/.local/share/claude/versions/2.1.287' }), { version: '2.1.287', source: 'CLAUDE_CODE_EXECPATH' });
  assert.deepEqual(claudeVersion({ CLAUDE_CODE_EXECPATH: 'C:\\Users\\u\\.local\\share\\claude\\versions\\2.1.290.exe' }), { version: '2.1.290', source: 'CLAUDE_CODE_EXECPATH' });
  assert.deepEqual(claudeVersion({ CLAUDE_CODE_EXECPATH: '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', AI_AGENT: 'claude-code_2-1-288_agent' }), { version: '2.1.288', source: 'AI_AGENT' });
  assert.deepEqual(claudeVersion({ CLAUDE_CODE_EXECPATH: '/v/2.1.287', AI_AGENT: 'claude-code_2-1-287_agent' }), { version: '2.1.287', source: 'CLAUDE_CODE_EXECPATH' });
  assert.equal(claudeVersion({ CLAUDE_CODE_EXECPATH: '/v/2.1.287', AI_AGENT: 'claude-code_2-1-278_agent' }), null, 'two sources that disagree are unknown');
  assert.equal(claudeVersion({ AI_AGENT: 'claude-code_2-1-287_other' }), null);
  assert.equal(claudeVersion({ AI_AGENT: 'gh-copilot' }), null);
  assert.equal(claudeVersion({}), null);
});

test('modsOnByDefault: 2.1.287 and later are on, earlier builds are not, unknown stays unknown', () => {
  assert.equal(modsOnByDefault('2.1.286'), false);
  assert.equal(modsOnByDefault('2.1.287'), true);
  assert.equal(modsOnByDefault('2.1.1000'), true);
  assert.equal(modsOnByDefault('2.2.0'), true);
  assert.equal(modsOnByDefault('3.0.0'), true);
  assert.equal(modsOnByDefault('1.9.999'), false);
  assert.equal(modsOnByDefault(null), null);
  assert.equal(modsOnByDefault('not-a-version'), null);
});

async function profile(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-mods-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const storeDir = join(config, 'plugins', 'store');
  await mkdir(join(config, 'rules'), { recursive: true });
  await writeFile(join(config, 'rules', ruleName), 'Sample rule body.\n');
  const specPath = join(root, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec));
  const settings = (value) => writeFile(join(config, 'settings.json'), JSON.stringify(value));
  const storeRaw = async (days, name = STORE) => {
    await rm(storeDir, { recursive: true, force: true });
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, name), JSON.stringify({ served: {}, health: { days } }));
  };
  const store = (days, name) => storeRaw(Object.fromEntries(days.map((day) => [day, { calls: 1, errors: 0, totalMs: 1, slow: 0, maxMs: 1 }])), name);
  const migrate = (env) => spawnSync(process.execPath, [...managedPolicyArgs, cli, 'migrate', ruleName, '--user', '--config-dir', config, '--spec', specPath, '--no-proof', 'fixture'],
    { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config, ...env }) });
  const migrated = async () => (await readdir(join(config, 'rules-on-demand')).catch(() => [])).includes(ruleName);
  return { settings, store, storeRaw, migrate, migrated };
}
const enabled = { enabledPlugins: { 'wt-rules-on-demand@local': true }, pluginConfigs: { 'wt-rules-on-demand@local': { options: { enabled: true } } } };

test('old build (2.1.286) without the variable is refused; with it, accepted', async (t) => {
  const p = await profile(t);
  await p.settings(enabled);
  const refused = p.migrate(OLD);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Function Hooks not known to be on: Claude Code 2\.1\.286/);
  assert.equal(await p.migrated(), false);
  await p.settings({ ...enabled, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });
  const run = p.migrate(OLD);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await p.migrated(), true);
});

test('new build (2.1.287) without the variable is accepted', async (t) => {
  const p = await profile(t);
  await p.settings(enabled);
  const run = p.migrate(NEW);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await p.migrated(), true);
});

test('unknown version: refused without the variable and names the escape, accepted with it', async (t) => {
  const p = await profile(t);
  await p.settings(enabled);
  const run = p.migrate({});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /version unknown/);
  assert.match(run.stderr, /--assume-loaded/);
  const flagged = p.migrate({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' });
  assert.equal(flagged.status, 0, flagged.stderr);
});

test('listed in enabledPlugins but the engine option is not on: refused', async (t) => {
  const p = await profile(t);
  await p.settings({ enabledPlugins: enabled.enabledPlugins });
  const run = p.migrate(NEW);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /engine not enabled/);
  assert.equal(await p.migrated(), false);
});

test('a plugin loaded by --plugin-dir: accepted on a recent engine health day, refused without valid recent evidence', async (t) => {
  const p = await profile(t);
  await p.settings({});
  const none = p.migrate(NEW);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /plugin not enabled in settings\.json and no engine health day/);
  await p.store([utcDay(-7)]);
  assert.notEqual(p.migrate(NEW).status, 0, 'seven date keys back is outside the window');
  await p.store([utcDay(2), 'garbage']);
  assert.notEqual(p.migrate(NEW).status, 0, 'a future or malformed day is no evidence');
  await p.store(['2026-02-30', '2026-09-31']);
  assert.notEqual(p.migrate(NEW).status, 0, 'an impossible calendar date is no evidence');
  await p.store([utcDay(-1)], 'wt-rules-on-demand_inline.json');
  assert.notEqual(p.migrate(NEW).status, 0, 'a store name without the engine hash suffix is not read');
  await p.storeRaw({ [utcDay(0)]: null, [utcDay(-1)]: { calls: 0 } });
  assert.notEqual(p.migrate(NEW).status, 0, 'a day that counts no call is no evidence');
  assert.equal(await p.migrated(), false);
  await p.store([utcDay(-8), utcDay(-6), utcDay(-1), utcDay(-3)]);
  const fresh = p.migrate({});
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.ok(fresh.stderr.includes(`engine active on ${utcDay(-1)} (${STORE})`), `the newest day is named: ${fresh.stderr}`);
  assert.equal(await p.migrated(), true);
});

test('an explicit engine-off wins over recent activity', async (t) => {
  const p = await profile(t);
  await p.store([utcDay(0)]);
  await p.settings({ pluginConfigs: { 'wt-rules-on-demand@inline': { options: { enabled: false } } } });
  const run = p.migrate(NEW);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /engine switched off/);
  assert.equal(await p.migrated(), false);
});

test('health evidence from a plugin source disabled in enabledPlugins does not count; disableAllHooks always refuses', async (t) => {
  const p = await profile(t);
  await p.store([utcDay(0)], 'wt-rules-on-demand_my-market-0123456789ab.json');
  await p.settings({ enabledPlugins: { 'wt-rules-on-demand@my-market': false } });
  assert.match(p.migrate(NEW).stderr, /plugin not enabled in settings\.json/);
  await p.settings({ disableAllHooks: true });
  assert.match(p.migrate(NEW).stderr, /disableAllHooks/);
  assert.equal(await p.migrated(), false);
});

test('recentActivity at a fixed clock: window of seven date keys, impossible dates rejected, newest day wins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeDir = join(root, 'plugins', 'store');
  await mkdir(storeDir, { recursive: true });
  const now = Date.parse('2026-10-02T12:00:00Z');
  const write = (days) => writeFile(join(storeDir, STORE), JSON.stringify({ health: { days: Object.fromEntries(days.map((day) => [day, { calls: 1 }])) } }));
  await write(['2026-09-31']);
  assert.equal(await recentActivity(root, new Set(), now), null, '2026-09-31 is not a date, though Date.parse reads it as October 1');
  await write(['2026-09-25']);
  assert.equal(await recentActivity(root, new Set(), now), null, 'seven keys back is outside');
  await write(['2026-09-26', '2026-09-30', '2026-09-28']);
  assert.deepEqual(await recentActivity(root, new Set(), now), { day: '2026-09-30', store: STORE });
  assert.equal(await recentActivity(root, new Set(['inline']), now), null);
});
