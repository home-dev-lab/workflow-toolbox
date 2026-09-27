import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, link } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRule } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };
const moduleUrl = new URL('../scripts/rule-lifecycle-lib.mjs', import.meta.url).href;
const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-seven-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  return root;
}

test('legacy unattributed deliveries cannot turn a governed act into revert evidence', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body\n');
  await migrateRule(root, 'sample.md', spec, {});
  const identity = `project:${join(root, '.claude/rules-on-demand')}:sample.md`;
  const store = join(root, 'store.json');
  const at = new Date(Date.now() + 1000).toISOString();
  await writeFile(store, JSON.stringify({ sessions: { legacy: { last: at, contexts: { '0': {
    served: { 'sample.md': 1 }, governedActs: [{ rule: 'sample.md', ruleIdentity: identity, at }],
  } } } } }));
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [rollback, '--project', root, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const [result] = JSON.parse(run.stdout);
  assert.equal(result.action, 'attention');
  assert.equal(result.reason, 'delivery evidence unattributed');
});

test('competing destination arriving at publish survives failed ledger append', async (t) => {
  const root = await fixture(t);
  const source = join(root, '.claude/rules/sample.md');
  const destination = join(root, '.claude/rules-on-demand/sample.md');
  await writeFile(source, 'Body\n');
  await assert.rejects(() => migrateRule(root, 'sample.md', spec, {}, { io: {
    linkDestination: async (temp, target) => {
      await writeFile(target, 'OTHER WRITER', { flag: 'wx' });
      return link(temp, target);
    },
    appendLedger: async () => { throw new Error('ledger unavailable'); },
  } }), /destination exists/);
  assert.equal(await readFile(destination, 'utf8'), 'OTHER WRITER');
  assert.equal(await readFile(source, 'utf8'), 'Body\n');
});

test('unsupported hard link falls back to exclusive destination create', async (t) => {
  const root = await fixture(t);
  const source = join(root, '.claude/rules/sample.md');
  const destination = join(root, '.claude/rules-on-demand/sample.md');
  await writeFile(source, 'Body\n');
  await migrateRule(root, 'sample.md', spec, {}, { io: {
    linkDestination: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); },
  } });
  assert.match(await readFile(destination, 'utf8'), /Body\n$/);
  assert.equal(await readFile(source, 'utf8').catch(() => null), null);
});

test('unsupported hard link still refuses an existing destination', async (t) => {
  const root = await fixture(t);
  const source = join(root, '.claude/rules/sample.md');
  const destination = join(root, '.claude/rules-on-demand/sample.md');
  await writeFile(source, 'Body\n');
  await assert.rejects(() => migrateRule(root, 'sample.md', spec, {}, { io: {
    linkDestination: async (_temp, target) => {
      await writeFile(target, 'OTHER WRITER', { flag: 'wx' });
      throw Object.assign(new Error('unsupported'), { code: 'EPERM' });
    },
  } }), /destination exists/);
  assert.equal(await readFile(destination, 'utf8'), 'OTHER WRITER');
  assert.equal(await readFile(source, 'utf8'), 'Body\n');
});

test('two real processes reclaim dead owner with crashed reclaimer sibling and never run unlocked', async (t) => {
  // A shared start marker releases each pair simultaneously; repeat on the actual temporary filesystem.
  for (let round = 0; round < 6; round++) {
    const root = await fixture(t);
    for (const name of ['first', 'second']) await writeFile(join(root, `.claude/rules/${name}.md`), 'Body\n');
    const lock = join(root, '.claude/rules-on-demand.lock');
    await writeFile(lock, JSON.stringify({ pid: 99999999, hostname: hostname(), startedAt: Date.now() - 360000 }));
    await writeFile(`${lock}.reclaim`, 'abandoned reclaimer');
    const start = join(root, 'start');
    const active = join(root, 'active');
    const childCode = `import { readFile, writeFile, rm, open } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { migrateRule } from ${JSON.stringify(moduleUrl)};
const [root, name, start, active] = process.argv.slice(1);
while (!(await readFile(start).catch(() => null))) await sleep(5);
try {
  await migrateRule(root, name + '.md', ${JSON.stringify(spec)}, {}, { io: { appendLedger: async () => {
    const owner = JSON.parse(await readFile(join(root, '.claude/rules-on-demand.lock'), 'utf8'));
    if (owner.pid !== process.pid) throw new Error('body ran without owned lock');
    let handle;
    try { handle = await open(active, 'wx'); } catch (error) { throw new Error('overlapping bodies: ' + error.message); }
    try { await sleep(80); } finally { await handle.close(); await rm(active); }
  } } });
  console.log('body completed');
} catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const children = ['first', 'second'].map((name) => spawn(process.execPath, ['--input-type=module', '-e', childCode, root, name, start, active], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
    const done = children.map((child) => new Promise((resolve) => {
      let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('exit', (code) => resolve({ code, out, err }));
    }));
    await writeFile(start, 'go');
    const results = await Promise.all(done);
    assert.deepEqual(results.map((result) => result.code), [0, 0], `round ${round}: ${JSON.stringify(results)}`);
    assert.equal((await readdir(join(root, '.claude/rules-on-demand'))).length, 2);
  }
});
