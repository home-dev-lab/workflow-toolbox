import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRule } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };
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
  assert.equal(result.reason, 'trigger miss unproven: store cannot show non-delivery');
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
