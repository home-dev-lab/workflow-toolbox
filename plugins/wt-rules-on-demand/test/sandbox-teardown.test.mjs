// A sandbox is removed only once nothing still writes into it. The hook dispatches its flight-recorder writes without
// awaiting them, so a removal that does not wait for them races the write: ENOTEMPTY on rmdir, or a tree recreated after
// the removal. Both locks fail when removeSandbox stops waiting for the pending host fs operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookFixture, hostStore, realFs, removeSandbox, settleHostOps, trackHostOp } from './store-host-fake.mjs';

const exists = (path) => lstat(path).then(() => true, () => false);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scratch(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await settleHostOps(); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('a sandbox is removed only after a host write still running inside it has settled', async (t) => {
  const root = await scratch(t, 'rod-teardown-write-');
  const target = join(root, 'config', 'plugins', 'data', 'wt-rules-on-demand', 'inflight', 'late.json');
  const write = trackHostOp(delay(50).then(() => realFs.write(target, '{}')));
  await removeSandbox(root);
  await write;
  assert.equal(await exists(root), false, 'the write landed after the removal and recreated the sandbox');
});

// A slow disk, as on a loaded macOS or Windows runner: each write lands 30 ms after the hook asked for it.
const slowDisk = { ...realFs, write: (path, text) => trackHostOp(delay(30).then(() => realFs.write(path, text))) };

test('a sandbox is removed only after the writes a hook call left running have settled', async (t) => {
  const root = await scratch(t, 'rod-teardown-hook-');
  const f = await hookFixture(root, hostStore(), { fs: slowDisk });
  // The flight recorder arms in the background after the first call (hooks.js scheduleFlights); the second call writes
  // its breadcrumbs into inflight/ and returns without waiting for them.
  await f.call({ command: 'git push origin main' });
  await settleHostOps();
  await f.call({ command: 'git push origin main' });
  await removeSandbox(root);
  await settleHostOps();
  assert.equal(await exists(root), false, 'a flight-recorder write outlived the removal and recreated the sandbox');
});
