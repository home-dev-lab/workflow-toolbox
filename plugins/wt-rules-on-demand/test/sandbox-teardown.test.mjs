// A sandbox is removed only once the hook waits on nothing. The hook runs work in the background without awaiting it
// (flight-recorder writes, the harvest of an older load's breadcrumbs), so a removal that does not wait for it races a
// write: ENOTEMPTY on rmdir, or a tree recreated after the removal. Each lock holds the racing work until an explicit
// teardown-entry signal, asserts it is pending at entry, and asserts it settled before filesystem removal. Deleting
// the drain reaches the pre-removal assertion synchronously, before the released work can resume, on any machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookFixture, hostStore, realFs, removeSandbox, sandboxRoot, settleHostOps, trackHostOp } from './store-host-fake.mjs';
import { sessionKey } from '../session-key.mjs';

const exists = (path) => lstat(path).then(() => true, () => false);
const turn = () => new Promise((resolve) => setImmediate(resolve));

function heldWork(t) {
  let release;
  const signal = new Promise((resolve) => { release = resolve; });
  let pending = 0;
  // Registered before scratch cleanup, so an early assertion failure cannot strand the host drain.
  t.after(() => release());
  return {
    hold: (work = () => {}) => {
      pending++;
      return signal.then(work).finally(() => { pending--; });
    },
    remove: (root) => removeSandbox(root, {
      beforeDrain: () => {
        assert.ok(pending > 0, 'teardown started without pending host work');
        release();
      },
      beforeRemove: () => assert.equal(pending, 0, 'sandbox removal started with held host work still pending'),
    }),
  };
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
  const gate = heldWork(t);
  const root = await scratch(t, 'rod-teardown-write-');
  const target = join(root, 'config', 'plugins', 'data', 'wt-rules-on-demand', 'inflight', 'late.json');
  const write = trackHostOp(gate.hold(() => realFs.write(target, '{}')));
  await gate.remove(root);
  await write;
  assert.equal(await exists(root), false, 'the write landed after the removal and recreated the sandbox');
});

test('a sandbox is removed only after the flight writes a hook call left running have settled', async (t) => {
  const gate = heldWork(t);
  const root = await scratch(t, 'rod-teardown-hook-');
  const held = [];
  let armed = false;
  const gatedDisk = { ...realFs, write: (path, text) => {
    if (!armed || !path.includes('/inflight/')) return realFs.write(path, text);
    const write = gate.hold(() => realFs.write(path, text));
    held.push(write);
    return write;
  } };
  const f = await hookFixture(root, hostStore(), { fs: gatedDisk });
  // The flight recorder arms in the background after the first call (hooks.js scheduleFlights); the second call writes
  // its breadcrumbs into inflight/ and returns without waiting for them.
  await f.call({ command: 'git push origin main' });
  await settleHostOps();
  armed = true;
  await f.call({ command: 'git push origin main' });
  assert.ok(held.length > 0, 'the second call left no flight write running: the lock would pass without exercising the race');
  await gate.remove(root);
  // Whatever the drain did, every held write has landed before the sandbox is read.
  await Promise.allSettled(held);
  assert.equal(await exists(root), false, 'a flight-recorder write outlived the removal and recreated the sandbox');
});

test('a sandbox is removed only after a harvest waiting on its log line has written its mark', async (t) => {
  const gate = heldWork(t);
  const root = await scratch(t, 'rod-teardown-harvest-');
  const inflight = join(root, 'config', 'plugins', 'data', 'wt-rules-on-demand', 'inflight');
  await mkdir(inflight, { recursive: true });
  // A breadcrumb an earlier load of the hooks module left unconfirmed: the next load announces it, then marks it.
  await writeFile(join(inflight, `${sessionKey('sample-session')}-0.json`), JSON.stringify({ work: 'tool.call', tool: 'Bash',
    inputChars: 1, phase: 'work', startedAt: new Date().toISOString(), sessionId: 'sample-session', loadToken: 'an-earlier-load' }));
  let announced = null;
  const log = (line) => {
    if (!line.includes('did not confirm completion')) return undefined;
    announced = gate.hold();
    return announced;
  };
  const f = await hookFixture(root, hostStore(), { log });
  await f.call({ command: 'git push origin main' });
  await waitUntil(() => announced !== null, 'the harvest announcing the earlier breadcrumb');
  await gate.remove(root);
  // Whatever the drain did, the log has returned and the mark it releases has been written before the sandbox is read.
  await announced;
  await settleHostOps();
  assert.equal(await exists(root), false, 'the harvest wrote its mark after the removal and recreated the sandbox');
});

test('removes the sandbox even when the host drain expires with a call still pending', { timeout: 5_000 }, async (t) => {
  let release;
  let pending = true;
  const call = trackHostOp(new Promise((resolve) => { release = resolve; }).finally(() => { pending = false; }));
  t.after(() => release());
  const root = await scratch(t, 'rod-teardown-timeout-');
  await writeFile(join(root, 'sentinel'), 'sandbox exists');
  try {
    await assert.rejects(removeSandbox(root, { limitMs: 50 }), /1 host call\(s\) still pending after 50 ms/);
    assert.equal(pending, true, 'the host call must still be pending after the bound expires');
    assert.equal(await exists(root), false, 'the sandbox survived the drain timeout');
  } finally { release(); await call; }
});

test('a host call that never settles fails the teardown at its bound instead of hanging it', { timeout: 5_000 }, async () => {
  let release;
  trackHostOp(new Promise((resolve) => { release = resolve; }));
  await assert.rejects(settleHostOps(50), /1 host call\(s\) still pending after 50 ms/);
  release();
  await settleHostOps();
});

async function hostChild(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'rod-teardown-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'proof.mjs');
  const moduleUrl = new URL('./store-host-fake.mjs', import.meta.url).href;
  await writeFile(script, `import { trackHostOp, settleHostOps } from ${JSON.stringify(moduleUrl)};\n${source}\n`);
  return spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } });
}

// Release on actual disappearance OR on the drain's entry event. Disappearance alone would deadlock a correct drain.
function sandboxGone(root) {
  let release;
  let released = false;
  const signal = new Promise((resolve) => { release = () => { released = true; resolve(); }; });
  const watch = (async () => {
    while (!released && await exists(root)) await turn();
    release();
  })();
  return { signal, release, watch };
}

test("sandboxRoot's after-callback drains before removing", async (t) => {
  let captured;
  const root = await sandboxRoot({ after: (fn) => { captured = fn; } }, 'rod-teardown-root-');
  const gone = sandboxGone(root);
  t.after(async () => { gone.release(); await gone.watch; await settleHostOps(); await rm(root, { recursive: true, force: true }); });
  const target = join(root, 'late.json');
  let landed = false;
  const write = trackHostOp(gone.signal.then(async () => { await realFs.write(target, '{}'); landed = true; }));
  assert.equal(landed, false, 'the gated write landed before teardown entry');
  // Only observe resources created synchronously by the callback: the drain schedules its first full turn here.
  const entry = createHook({ init: (_id, type) => { if (type === 'Immediate') gone.release(); } });
  entry.enable();
  let removal;
  try { removal = captured(); } finally { entry.disable(); }
  await removal;
  await write;
  await gone.watch;
  assert.equal(await exists(root), false, 'the write landed after the removal and recreated the sandbox');
});

test('a host rejection nobody handles still surfaces as an unhandled rejection', async (t) => {
  const child = await hostChild(t, `trackHostOp(Promise.reject(new Error('host-boom')));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));`);
  assert.ifError(child.error);
  assert.notEqual(child.status, 0, 'an unhandled host rejection let the child exit successfully');
  assert.match(child.stderr, /host-boom/);
});

test('removeSandbox removes with retries so a transient Windows refusal is waited out', async () => {
  const calls = [];
  const root = 'recorded-sandbox';
  await removeSandbox(root, { remove: async (...args) => { calls.push(args); } });
  assert.equal(calls.length, 1);
  const [received, options] = calls[0];
  assert.equal(received, root);
  assert.equal(options.recursive, true);
  assert.equal(options.force, true);
  assert.ok(options.maxRetries >= 1, 'sandbox removal must retry transient refusals');
  assert.ok(options.retryDelay >= 1, 'sandbox removal must wait between retries');
});

test('a hung drain with nothing else alive fails with the bounded message', async (t) => {
  const child = await hostChild(t, 'trackHostOp(new Promise(() => {}));\nawait settleHostOps(50);');
  assert.ifError(child.error);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /1 host call\(s\) still pending after 50 ms/);
});

test('settleHostOps leaves no timer behind once the calls have settled', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timers();
  trackHostOp(turn().then(turn));
  await settleHostOps(10_000);
  assert.equal(timers(), before, 'the settled drain left its expiry timer alive');
});

test('a continuous stream of host calls cannot hold the drain past its bound', { timeout: 5_000 }, async (t) => {
  t.mock.method(performance, 'now', () => 0);
  // Hold expiry races inactive: only the total-deadline check can bound a stream whose calls keep settling.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let running = true;
  const produce = () => { if (running) trackHostOp(turn().then(produce)); };
  t.after(() => { running = false; });
  produce();
  try { await assert.rejects(settleHostOps(100), /host call\(s\) still pending after 100 ms/); }
  finally { running = false; await settleHostOps(); }
});

test('a drain that timed out does not fail the next teardown', { timeout: 5_000 }, async () => {
  trackHostOp(new Promise(() => {}));
  await assert.rejects(settleHostOps(50), /still pending after 50 ms/);
  await settleHostOps(50);
});
