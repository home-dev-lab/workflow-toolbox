import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';
import { enabledSettings, installFixture } from '../test-support/profile-fixture.mjs';

test('health never changes outcomes across the dynamically discovered existing profile fixture matrix', async () => {
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const files = (await fs.readdir(directory)).filter((name) => /^profile-(?:policy.*|safety)\.test\.mjs$/.test(name));
  assert.ok(files.length > 0, 'profile fixture matrix must not be empty');
  const preload = fileURLToPath(new URL('../test-support/profile-matrix-preload.mjs', import.meta.url));
  const env = cleanEnv();
  delete env.NODE_TEST_CONTEXT;
  // A batch deadline measures host scheduling, not health independence. Wait for the
  // discovered fixtures to exit, then require both success and an actual comparison.
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--test', ...files], { cwd: directory, encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `fixture matrix must be health-independent (status=${result.status}, signal=${result.signal}, error=${result.error?.code ?? 'none'}):\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('PROFILE-MATRIX-COMPARED'), 'the existing CLI fixtures must actually be compared');
});

function matrixChild(stub) {
  const preload = new URL('../test-support/profile-matrix-preload.mjs', import.meta.url).href;
  const source = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    const original = cp.spawnSync;
    cp.spawnSync = (exe, args, options) => args.includes(${JSON.stringify(preload)})
      ? (${stub})(exe, args, options, original) : original(exe, args, options);
    syncBuiltinESMExports();`;
  const env = cleanEnv();
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(source)}`,
    '--test', '--test-name-pattern=^health never changes outcomes', fileURLToPath(import.meta.url)],
  { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 });
}

test('a forced health difference names the fixture row and both outcomes and restores its store', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'rod-health-diagnostic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  await installFixture(profile);
  const store = join(profile, 'plugins', 'store');
  const sentinel = join(store, 'sentinel.json');
  await fs.mkdir(store);
  await fs.writeFile(sentinel, 'original store');
  const args = ['migrate', 'sample.md', '--user', '--config-dir', profile];
  // Introduce a real, synthetic IO dependence: the settings permit only the health-present half.
  const source = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFile;
    fs.readFile = async (file, ...args) => {
      if (file !== ${JSON.stringify(join(profile, 'settings.json'))}) return read(file, ...args);
      const health = await fs.stat(${JSON.stringify(store)}).then(() => true, () => false);
      return JSON.stringify({ ...${JSON.stringify(enabledSettings)}, disableAllHooks: !health });
    }; syncBuiltinESMExports();`;
  const run = spawnSync(process.execPath, [...managedPolicyArgs, '--import', `data:text/javascript,${encodeURIComponent(source)}`,
    fileURLToPath(new URL('../test-support/profile-outcome.mjs', import.meta.url)), JSON.stringify(args)],
  { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EXECPATH: '/v/2.1.287',
    WT_ROD_TEST_MANAGED_SETTINGS: join(root, 'managed-settings.json') }) });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stderr.includes(`row=${JSON.stringify(args)}`), `difference must identify its fixture row:\n${run.stderr}`);
  assert.match(run.stderr, /with health=ALLOW/);
  assert.match(run.stderr, /without health=REFUSE/);
  t.diagnostic(run.stderr.split('\n').filter((line) => /^(row=|with health=|without health=)/.test(line)).join('\n'));
  assert.deepEqual(await fs.readdir(store), ['sentinel.json']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'original store');
  await assert.rejects(fs.stat(`${store}.matrix-backup`), { code: 'ENOENT' });
});

test('matrix child failures name the spawn error, exit status and signal', () => {
  const run = matrixChild(`() => ({ status: null, signal: 'SIGTERM',
    error: Object.assign(new Error('forced deadline'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' })`);
  assert.notEqual(run.status, 0, 'the failed matrix child must fail the invariant');
  const output = run.stdout + run.stderr;
  assert.match(output, /error=ETIMEDOUT/);
  assert.match(output, /status=null/);
  assert.match(output, /signal=SIGTERM/);
});

test('matrix waits for child completion independently of an exhausted wall-clock budget', () => {
  // Model a worker scheduled beyond any finite batch deadline, without a real-time sleep.
  // A worker that can finish signals completion with stdin EOF, just as spawnSync waits for exit.
  const run = matrixChild(`(exe, args, options, original) => {
    if (options.timeout > 0) return { status: null, signal: 'SIGTERM',
      error: Object.assign(new Error('worker scheduled beyond the batch deadline'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
    return original(exe, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => console.log("PROFILE-MATRIX-COMPARED"))'],
      { ...options, input: 'worker may complete' });
  }`);
  assert.equal(run.status, 0, `child completion must decide the matrix result, not elapsed scheduling time:\n${run.stdout}\n${run.stderr}`);
});
