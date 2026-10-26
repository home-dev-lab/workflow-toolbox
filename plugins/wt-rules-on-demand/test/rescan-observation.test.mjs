import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const hooksURL = new URL('../hooks/hooks.js', import.meta.url).href;
const fakeURL = new URL('./store-host-fake.mjs', import.meta.url).href;
// Each probe imports a fresh module: no earlier test can have enabled selftest observation.
const probe = `
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register, resetForSelftest, rescanPlansSettledForSelftest } from ${JSON.stringify(hooksURL)};
import { hookFixture, hostStore, settleHostOps } from ${JSON.stringify(fakeURL)};
const observing = process.argv[1] === 'selftest';
const root = await mkdtemp(join(tmpdir(), 'rod-observation-'));
try {
  if (observing) resetForSelftest();
  const f = await hookFixture(root, hostStore(), { hooks: { register, resetForSelftest: () => {} } });
  await f.call({ command: 'git push origin main' });
  const sleeps = [];
  f.$.clock = { sleep: (ms) => { sleeps.push(ms); return new Promise(() => {}); } };
  await f.handlers.get('session.compact')(f.$, { cwd: f.project }, async () => ({}));
  assert.ok(sleeps.includes(100), 'a plan started and is held in host sleep');
  let settled = false;
  void rescanPlansSettledForSelftest().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, !observing, observing ? 'selftest records the pending plan' : 'production records no pending plan');
} finally { await settleHostOps(); await rm(root, { recursive: true, force: true }); }
`;

for (const mode of ['production', 'selftest']) {
  test(`rescan plan observation is opt-in: ${mode}`, { timeout: 90_000 }, () => {
    // Failure-only child bound; the assertion is decided by promise settlement at the next event-loop turn.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, mode], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
  });
}
