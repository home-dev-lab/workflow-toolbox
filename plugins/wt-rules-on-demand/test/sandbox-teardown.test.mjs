// A sandbox is removed only once the hook waits on nothing. The hook runs work in the background without awaiting it
// (flight-recorder writes, the harvest of an older load's breadcrumbs), so a removal that does not wait for it races a
// write: ENOTEMPTY on rmdir, or a tree recreated after the removal. Each lock holds the racing write at a gate that
// opens as soon as the sandbox is gone, so without the drain the write lands after the removal on every run; with the
// drain the removal waits for the write, and the gate's fallback timer only bounds that wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookFixture, hostStore, realFs, removeSandbox, settleHostOps, trackHostOp } from './store-host-fake.mjs';
import { sessionKey } from '../session-key.mjs';

const exists = (path) => lstat(path).then(() => true, () => false);
const turn = () => new Promise((resolve) => setImmediate(resolve));

// Opens once `root` no longer exists, or after `fallbackMs` while the removal waits on the gated write.
async function sandboxGone(root, fallbackMs = 1_000) {
  const until = performance.now() + fallbackMs;
  while (await exists(root) && performance.now() < until) await turn();
}

async function scratch(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await settleHostOps(); await rm(root, { recursive: true, force: true }); });
  return root;
}

async function waitUntil(predicate, what) {
  const until = performance.now() + 5_000;
  while (!predicate()) {
    assert.ok(performance.now() < until, `never reached: ${what}`);
    await turn();
  }
}

test('a sandbox is removed only after a host write still running inside it has settled', async (t) => {
  const root = await scratch(t, 'rod-teardown-write-');
  const target = join(root, 'config', 'plugins', 'data', 'wt-rules-on-demand', 'inflight', 'late.json');
  const write = trackHostOp(sandboxGone(root).then(() => realFs.write(target, '{}')));
  await removeSandbox(root);
  await write;
  assert.equal(await exists(root), false, 'the write landed after the removal and recreated the sandbox');
});

test('a sandbox is removed only after the flight writes a hook call left running have settled', async (t) => {
  const root = await scratch(t, 'rod-teardown-hook-');
  let held = [];
  const gatedDisk = { ...realFs, write: (path, text) => {
    if (!path.includes('/inflight/')) return realFs.write(path, text);
    const write = sandboxGone(root).then(() => realFs.write(path, text));
    held.push(write);
    return write;
  } };
  const f = await hookFixture(root, hostStore(), { fs: gatedDisk });
  // The flight recorder arms in the background after the first call (hooks.js scheduleFlights); the second call writes
  // its breadcrumbs into inflight/ and returns without waiting for them.
  await f.call({ command: 'git push origin main' });
  await settleHostOps();
  held = [];
  await f.call({ command: 'git push origin main' });
  assert.ok(held.length > 0, 'the second call left no flight write running: the lock would pass without exercising the race');
  await removeSandbox(root);
  // Whatever the drain did, every held write has landed before the sandbox is read.
  await Promise.allSettled(held);
  assert.equal(await exists(root), false, 'a flight-recorder write outlived the removal and recreated the sandbox');
});

test('a sandbox is removed only after a harvest waiting on its log line has written its mark', async (t) => {
  const root = await scratch(t, 'rod-teardown-harvest-');
  const inflight = join(root, 'config', 'plugins', 'data', 'wt-rules-on-demand', 'inflight');
  await mkdir(inflight, { recursive: true });
  // A breadcrumb an earlier load of the hooks module left unconfirmed: the next load announces it, then marks it.
  await writeFile(join(inflight, `${sessionKey('sample-session')}-0.json`), JSON.stringify({ work: 'tool.call', tool: 'Bash',
    inputChars: 1, phase: 'work', startedAt: new Date().toISOString(), sessionId: 'sample-session', loadToken: 'an-earlier-load' }));
  let announced = null;
  const log = (line) => {
    if (!line.includes('did not confirm completion')) return undefined;
    announced = sandboxGone(root);
    return announced;
  };
  const f = await hookFixture(root, hostStore(), { log });
  await f.call({ command: 'git push origin main' });
  await waitUntil(() => announced !== null, 'the harvest announcing the earlier breadcrumb');
  await removeSandbox(root);
  // Whatever the drain did, the log has returned and the mark it releases has been written before the sandbox is read.
  await announced;
  await settleHostOps();
  assert.equal(await exists(root), false, 'the harvest wrote its mark after the removal and recreated the sandbox');
});

test('a host call that never settles fails the teardown at its bound instead of hanging it', { timeout: 5_000 }, async () => {
  let release;
  trackHostOp(new Promise((resolve) => { release = resolve; }));
  await assert.rejects(settleHostOps(50), /1 host call\(s\) still pending after 50 ms/);
  release();
  await settleHostOps();
});
