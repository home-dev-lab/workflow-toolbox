import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertProfiles, managedSettingsPath } from '../scripts/profile-check.mjs';
import { installFixture } from '../test-support/profile-fixture.mjs';

const id = 'wt-rules-on-demand@local';
const enabled = { enabledPlugins: { [id]: true }, pluginConfigs: { [id]: { options: { enabled: true } } } };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rod-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  await fs.mkdir(profile);
  await installFixture(profile);
  await fs.writeFile(join(profile, 'settings.json'), JSON.stringify(enabled));
  const managedFile = join(root, 'managed-settings.json');
  const drops = join(root, 'managed-settings.d');
  const env = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EXECPATH: '/v/2.1.287' };
  const check = (overrides = {}, io = {}) => assertProfiles(profile, [], [], { ...env, ...overrides }, { managedFile, ...io });
  return { root, profile, managedFile, drops, env, check };
}

test('sorted JSON policy drop-ins reconstruct the effective hook permission', async (t) => {
  const p = await fixture(t);
  await fs.mkdir(p.drops);
  await fs.writeFile(p.managedFile, '{}');
  await fs.writeFile(join(p.drops, '10-block.json'), JSON.stringify({ disableAllHooks: true }));
  await fs.writeFile(join(p.drops, '20-permit.json'), JSON.stringify({ disableAllHooks: false }));
  await fs.writeFile(join(p.drops, 'ignored.txt'), '{invalid');
  await p.check();
  await fs.writeFile(join(p.drops, '30-block.json'), JSON.stringify({ disableAllHooks: true }));
  await assert.rejects(p.check(), /30-block\.json.*disableAllHooks/, 'the effective prohibiting fragment must refuse');
});

test('absent base with nested guard drop-in refuses before assumptions', async (t) => {
  const p = await fixture(t);
  await fs.mkdir(p.drops);
  const file = join(p.drops, 'guard.json');
  await fs.writeFile(file, JSON.stringify({ pluginConfigs: { 'cc-plugin-sec-default@builtin': { options: { allowManagedModsOnly: true } } } }));
  await assert.rejects(assertProfiles(p.profile, [], [p.profile], p.env, { managedFile: p.managedFile }),
    /guard\.json.*pluginConfigs\["cc-plugin-sec-default@builtin"\]\.options\.allowManagedModsOnly/, 'nested guard fragment must refuse assumptions');
});

test('invalid policy drop-in refuses by its filename', async (t) => {
  const p = await fixture(t);
  await fs.mkdir(p.drops);
  await fs.writeFile(join(p.drops, 'broken.json'), '{invalid');
  await assert.rejects(p.check(), /broken\.json.*invalid JSON/, 'invalid fragment must refuse');
});

test('unreadable existing policy directory refuses by directory name', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(p.drops, 'not a directory');
  await assert.rejects(p.check(), /managed-settings\.d.*cannot read/, 'unreadable drop-in directory must refuse');
});

test('production platform lookup reads the real policy despite the old environment override', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const file = managedSettingsPath(platform);
    const reads = [];
    const io = { platform, fs: {
      readFile: async (path) => { reads.push(path); return JSON.stringify({ disableAllHooks: true }); },
      readdir: async () => [],
      lstat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    } };
    await assert.rejects(assertProfiles('/unused', [], ['/unused'], { WT_ROD_TEST_MANAGED_SETTINGS: '/absent/bypass.json' }, io),
      /disableAllHooks/, 'production policy must refuse despite environment override');
    assert.deepEqual(reads, [file], 'platform lookup must reach the policy read');
  }
});

test('CLI environment override alone cannot redirect production policy', async () => {
  const url = new URL('../scripts/profile-check.mjs', import.meta.url).href;
  const probe = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    const reads=[]; fs.readFile=async p=>{reads.push(p);return '{"disableAllHooks":true}'};
    fs.readdir=async()=>[]; syncBuiltinESMExports();
    const {assertProfiles,managedSettingsPath}=await import(${JSON.stringify(url)});
    try {await assertProfiles('/unused',[],['/unused']);process.exitCode=2} catch(e){console.log(e.message)}
    console.log(JSON.stringify({reads,expected:managedSettingsPath()}));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', WT_ROD_TEST_MANAGED_SETTINGS: '/absent/bypass.json' },
  });
  assert.equal(run.status, 0, run.stderr);
  const evidence = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.deepEqual(evidence.reads, [evidence.expected, join('/unused', 'settings.json')], 'CLI must ignore environment policy redirection while reconstructing user and managed settings');
});

for (const processEvidence of [
  { CLAUDE_CODE_EXECPATH: '/v/2.1.287' },
  { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
]) test(`foreign config-dir cannot borrow process ${Object.keys(processEvidence)[0]}`, async (t) => {
  const p = await fixture(t);
  const running = join(p.root, 'running');
  await fs.mkdir(running);
  await assert.rejects(p.check({ CLAUDE_CONFIG_DIR: running, CLAUDE_CODE_EXECPATH: '', ...processEvidence }),
    /launch version unknown/, 'foreign profile must refuse process evidence');
  await fs.writeFile(join(p.profile, 'settings.json'), JSON.stringify({ ...enabled, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
  await p.check({ CLAUDE_CONFIG_DIR: running, CLAUDE_CODE_EXECPATH: '', ...processEvidence });
});

test('running profile realpath alias and default HOME profile retain their own evidence', async (t) => {
  const p = await fixture(t);
  const alias = join(p.root, 'alias');
  await fs.symlink(p.profile, alias, 'junction');
  await p.check({ CLAUDE_CONFIG_DIR: alias });
  const home = join(p.root, 'home');
  await fs.mkdir(home);
  await fs.symlink(p.profile, join(home, '.claude'), 'junction');
  await p.check({ CLAUDE_CONFIG_DIR: '', HOME: home });
});

test('unresolvable process profile is named unknown and cannot donate evidence', async (t) => {
  const p = await fixture(t);
  await assert.rejects(p.check({ CLAUDE_CONFIG_DIR: join(p.root, 'missing') }), /launch version unknown/, 'missing running profile must not donate evidence');
});

test('unexamined MDM and registry sources are named in platform warnings', async (t) => {
  const p = await fixture(t);
  for (const [platform, source] of [['darwin', /MDM/], ['win32', /registry/]]) {
    const warnings = [];
    await p.check({}, { platform, warn: (message) => warnings.push(message) });
    assert.ok(warnings.some((message) => source.test(message) && /unexamined/.test(message)), 'unexamined platform policy must be named');
  }
});

test('the nested guard option in user settings is not managed policy', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(join(p.profile, 'settings.json'), JSON.stringify({ ...enabled,
    pluginConfigs: { ...enabled.pluginConfigs, 'cc-plugin-sec-default@builtin': { options: { allowManagedModsOnly: true } } },
  }));
  await p.check();
});

test('permission-denied drop-in enumeration is a named policy refusal', async (t) => {
  const p = await fixture(t);
  const io = { ...fs, readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  await assert.rejects(p.check({}, { fs: io }), /managed-settings\.d.*cannot read.*EACCES/);
});

for (const target of ['managedFile', 'drops']) test(`dangling ${target} policy link is not absent policy`, async (t) => {
  const p = await fixture(t);
  await fs.symlink(join(p.root, 'missing'), p[target], target === 'drops' ? 'junction' : 'file');
  await assert.rejects(p.check(), /exists but cannot be read.*dangling symlink/);
});
