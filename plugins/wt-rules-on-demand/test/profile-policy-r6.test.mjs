import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertProfiles } from '../scripts/profile-check.mjs';
import { enabledSettings, engineId, installFixture } from '../test-support/profile-fixture.mjs';
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rod-static-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const managedFile = join(root, 'managed-settings.json');
  await fs.writeFile(managedFile, '{}');
  const profile = join(root, 'primary');
  await addProfile(profile);
  const env = cleanEnv({ WT_ROD_TEST_MANAGED_SETTINGS: managedFile, CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EXECPATH: '/v/2.1.287' });
  const spec = join(root, 'spec.json');
  await fs.writeFile(spec, JSON.stringify({ 'on-demand': { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }] }, compliance: { kind: 'none', reason: 'fixture' } }));
  const check = () => assertProfiles(profile, [], [], env, { managedFile, warn: () => {} });
  const run = (mirrors = []) => spawnSync(process.execPath, [...managedPolicyArgs,
    fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url)), 'migrate', 'sample.md', '--user', '--config-dir', profile,
    '--spec', spec, '--no-proof', 'fixture', ...mirrors.flatMap((dir) => ['--mirror-dir', dir])], { encoding: 'utf8', env });
  return { root, managedFile, profile, check, run };
}

async function addProfile(profile) {
  await fs.mkdir(join(profile, 'rules'), { recursive: true });
  await fs.writeFile(join(profile, 'rules', 'sample.md'), 'Keep this rule.\n');
  await fs.writeFile(join(profile, 'settings.json'), JSON.stringify({ ...enabledSettings, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
  await installFixture(profile);
}

async function hiddenPolicy(p, base, hidden) {
  await fs.writeFile(p.managedFile, JSON.stringify(base));
  const drops = join(p.root, 'managed-settings.d');
  await fs.mkdir(drops);
  await fs.writeFile(join(drops, '.policy.json'), JSON.stringify(hidden));
}

// Managed-settings documentation: "Claude Code ignores hidden files and files that don't end in `.json`."
test('hidden managed permission cannot override a visible hook prohibition', async (t) => {
  const p = await fixture(t);
  await hiddenPolicy(p, { disableAllHooks: true }, { disableAllHooks: false });
  await assert.rejects(p.check(), /disableAllHooks/, 'hidden drop-in must not undo the managed base prohibition');
});

test('hidden managed prohibition cannot refuse an otherwise unrefused profile', async (t) => {
  const p = await fixture(t);
  await hiddenPolicy(p, {}, { disableAllHooks: true });
  await assert.doesNotReject(p.check(), 'hidden drop-in must not introduce a hook prohibition');
});

test('name-present but unloadable manifests migrate provisionally for every checked profile', async (t) => {
  const p = await fixture(t);
  const mirror = join(p.root, 'mirror');
  await addProfile(mirror);
  await fs.rm(join(mirror, 'rules', 'sample.md'));
  await fs.symlink(join(p.profile, 'rules', 'sample.md'), join(mirror, 'rules', 'sample.md'));
  for (const profile of [p.profile, mirror]) {
    const registry = JSON.parse(await fs.readFile(join(profile, 'plugins', 'installed_plugins.json'), 'utf8'));
    const manifest = join(registry.plugins[engineId][0].installPath, '.claude-plugin', 'plugin.json');
    // Plugins reference: "a `keywords` value that is a string instead of an array is a load error".
    await fs.writeFile(manifest, JSON.stringify({ name: 'wt-rules-on-demand', keywords: 'unloadable' }));
  }
  const run = p.run([mirror]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `migrated sample.md to ${join(p.profile, 'rules-on-demand', 'sample.md')}\n`);
  for (const profile of [p.profile, mirror]) {
    const line = run.stderr.split('\n').find((line) => line.startsWith(`rules: profile ${profile}:`));
    assert.ok(line, 'each checked profile must have a provisional migration diagnostic');
    assert.match(line, /not refused by static checks; migration is provisional until the engine is observed serving the rule/);
    assert.match(await fs.readFile(join(profile, 'rules-on-demand', 'sample.md'), 'utf8'), /Keep this rule/);
    await assert.rejects(fs.readFile(join(profile, 'rules', 'sample.md')), { code: 'ENOENT' });
  }
  // The existing launch-limit warning names --safe-mode; it is not a "safe" verdict.
  const output = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(output, /\bsafe\b(?!-mode)|\b(?:engine|plugin)\s+(?:loads|serves)\b/i);
});

test('no installed or inline engine manifest refuses migration and preserves the static rule', async (t) => {
  const p = await fixture(t);
  const registry = JSON.parse(await fs.readFile(join(p.profile, 'plugins', 'installed_plugins.json'), 'utf8'));
  await fs.rm(join(registry.plugins[engineId][0].installPath, '.claude-plugin', 'plugin.json'));
  const run = p.run();
  assert.notEqual(run.status, 0, 'missing engine manifest must refuse migration');
  assert.match(run.stderr, /installed or inline engine source cannot be established/);
  assert.doesNotMatch(run.stderr, /migration is provisional/);
  assert.equal(run.stdout, '');
  assert.equal(await fs.readFile(join(p.profile, 'rules', 'sample.md'), 'utf8'), 'Keep this rule.\n');
  await assert.rejects(fs.readFile(join(p.profile, 'rules-on-demand-ledger.jsonl')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(join(p.profile, 'rules-on-demand')).catch(() => []), []);
});

// Plugins reference: "If you symlink a development checkout into the cache as a plugin's version entry, Claude Code
// never marks the link as orphaned" -- a linked version entry inside this profile's cache is a supported install.
test('a version entry symlinked into the profile cache is not refused', async (t) => {
  const p = await fixture(t);
  const registryFile = join(p.profile, 'plugins', 'installed_plugins.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const checkout = join(p.root, 'checkout', 'wt-rules-on-demand');
  await fs.mkdir(join(checkout, '.claude-plugin'), { recursive: true });
  await fs.writeFile(join(checkout, '.claude-plugin', 'plugin.json'), '{"name":"wt-rules-on-demand"}');
  const linked = join(p.profile, 'plugins', 'cache', 'local', 'wt-rules-on-demand', 'dev');
  await fs.symlink(checkout, linked);
  registry.plugins[engineId] = [{ scope: 'user', installPath: linked }];
  await fs.writeFile(registryFile, JSON.stringify(registry));
  await assert.doesNotReject(p.check(), 'a linked cache entry is a documented installation mode');
});

test('an installation record outside the profile cache is still refused', async (t) => {
  const p = await fixture(t);
  const registryFile = join(p.profile, 'plugins', 'installed_plugins.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const elsewhere = join(p.root, 'elsewhere', 'wt-rules-on-demand');
  await fs.mkdir(join(elsewhere, '.claude-plugin'), { recursive: true });
  await fs.writeFile(join(elsewhere, '.claude-plugin', 'plugin.json'), '{"name":"wt-rules-on-demand"}');
  registry.plugins[engineId] = [{ scope: 'user', installPath: elsewhere }];
  await fs.writeFile(registryFile, JSON.stringify(registry));
  await assert.rejects(p.check(), /installed or inline engine source cannot be established/);
});
