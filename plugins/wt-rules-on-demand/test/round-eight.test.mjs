import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRule } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const reason = 'trigger miss unproven: store cannot show non-delivery';
const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-eight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body\n');
  await migrateRule(root, 'sample.md', spec, {});
  const rulesDir = join(root, '.claude/rules-on-demand');
  const identity = `project:${rulesDir}:sample.md`;
  const at = new Date(Date.now() + 1000).toISOString();
  const store = join(root, 'store.json');
  const run = (...args) => spawnSync(process.execPath, [rollback, '--project', root, '--store', store, '--dry-run', ...args], { encoding: 'utf8', env: cleanEnv() });
  return { root, rulesDir, identity, at, store, run };
}

const otherIdentity = 'project:/other/rules-on-demand:other.md';
const cases = [
  ['exact legacy served entry', [{ served: { 'sample.md': 1 } }]],
  ['no delivery fields', [{}]],
  ['empty identity map', [{ servedIdentity: {} }]],
  ['other context has another rule identity', [{}, { servedIdentity: { [otherIdentity]: 1 } }]],
  ['legacy suppression and another identity', [{ suppressedCap: { 'sample.md': 1 } }, { servedIdentity: { [otherIdentity]: 1 } }]],
  ['normalized legacy served key and another identity', [{ served: { sample: 1 } }, { servedIdentity: { [otherIdentity]: 1 } }]],
  ['legacy injection and another identity', [{ complianceInjected: [{ rule: 'sample.md' }] }, { servedIdentity: { [otherIdentity]: 1 } }]],
];

for (const [label, contexts] of cases) test(`store-only governed act: ${label} requires attention`, async (t) => {
  const f = await fixture(t);
  const rows = contexts.map((context, index) => [String(index), { ...context, ...(index === 0 ? { governedActs: [{ ruleIdentity: f.identity, at: f.at }] } : {}) }]);
  await writeFile(f.store, JSON.stringify({ sessions: { session: { last: f.at, contexts: Object.fromEntries(rows) } } }));
  const result = f.run('--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(({ action, reason: why }) => ({ action, reason: why })), [{ action: 'attention', reason }], label);
});

test('transcript verdicts remain authoritative over old unproven store acts', async (t) => {
  const f = await fixture(t);
  const ledgerFile = join(f.root, '.claude/rules-on-demand-ledger.jsonl');
  const ledger = JSON.parse((await readFile(ledgerFile, 'utf8')).trim());
  await writeFile(ledgerFile, `${JSON.stringify({ ...ledger, time: '2026-01-01T00:00:00.000Z' })}\n`);
  await writeFile(f.store, JSON.stringify({ sessions: { old: { last: '2026-01-02T00:00:00.000Z', contexts: { '0': {
    served: { 'sample.md': 1 }, governedActs: [{ ruleIdentity: f.identity, at: '2026-01-02T00:00:00.000Z' }],
  } } } } }));
  const verdictFile = join(f.root, 'verdicts.jsonl');
  await writeFile(verdictFile, Array.from({ length: 5 }, () => JSON.stringify({ rule: 'sample.md', scope: 'project', rulesDir: f.rulesDir,
    verdict: 'not followed', window: '7d', decidedAt: '2026-09-26T00:00:00.000Z' })).join('\n') + '\n');
  const result = f.run('--verdicts', verdictFile, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].action, 'would revert');
});

test('store-only attention is visible on plain stdout', async (t) => {
  const f = await fixture(t);
  await writeFile(f.store, JSON.stringify({ sessions: { session: { last: f.at, contexts: { '0': {
    governedActs: [{ ruleIdentity: f.identity, at: f.at }],
  } } } } }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sample\.md: attention: trigger miss unproven: store cannot show non-delivery/);
});
