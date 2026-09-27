import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRule, splitRuleIdentity } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } };

// macOS hands out temp dirs under /var, whose real path is /private/var; Windows can hand out a short 8.3 name
// (RUNNER~1) whose real path is the long one. The hook records the path it saw; the CLI resolves real paths. Reproduce
// that difference on Linux by recording identities through a symlinked alias of the project root.
async function aliasedProject(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rod-alias-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const real = join(base, 'real');
  const alias = join(base, 'alias');
  await mkdir(join(real, '.claude/rules'), { recursive: true });
  await symlink(real, alias, 'dir');
  await writeFile(join(real, '.claude/rules/sample.md'), 'Body\n');
  await migrateRule(real, 'sample.md', spec, {});
  return { real, alias, aliasIdentity: `project:${join(alias, '.claude/rules-on-demand')}:sample.md` };
}

test('store-only attention holds when the store recorded the project through a path alias', async (t) => {
  const f = await aliasedProject(t);
  const store = join(f.real, 'store.json');
  const at = new Date(Date.now() + 1000).toISOString();
  await writeFile(store, JSON.stringify({ sessions: { s: { last: at, contexts: { '0': { governedActs: [{ ruleIdentity: f.aliasIdentity, at }] } } } } }));
  const result = spawnSync(process.execPath, [rollback, '--project', f.real, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map((row) => row.action), ['attention']);
});

test('aliased verdict identities still count toward a rollback decision', async (t) => {
  const f = await aliasedProject(t);
  const store = join(f.real, 'store.json');
  const line = () => JSON.stringify({ rule: 'sample.md', ruleIdentity: f.aliasIdentity, verdict: 'not followed', decidedAt: new Date(Date.now() + 1000).toISOString() });
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': Array.from({ length: 5 }, line).join('\n') }));
  const result = spawnSync(process.execPath, [rollback, '--project', f.real, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  // The aliased rows are counted; store-only evidence has no static baseline, so the rule is flagged, never reverted.
  const [row] = JSON.parse(result.stdout);
  assert.equal(row.applicable, 5);
  assert.equal(row.action, 'attention');
  assert.match(row.reason, /no static baseline/);
});

test('a Windows rule identity splits on its outer separators, not the drive colon', () => {
  const dir = win32.join('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p', '.claude', 'rules-on-demand');
  assert.deepEqual(splitRuleIdentity(`project:${dir}:sample.md`), { scope: 'project', dir, name: 'sample.md' });
  assert.deepEqual(splitRuleIdentity('user:/home/u/.claude/rules-on-demand:a.md'), { scope: 'user', dir: '/home/u/.claude/rules-on-demand', name: 'a.md' });
  assert.equal(splitRuleIdentity('no-separators'), null);
});
