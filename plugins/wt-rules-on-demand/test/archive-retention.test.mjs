import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, writeFile, readFile, truncate, stat, readdir, rm, utimes, symlink, lstat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retainArchives } from '../scripts/archive-retention.mjs';
import { ARCHIVE_RETENTION_BYTES, VERDICT_ARCHIVE, STORE_ARCHIVE, archiveName } from '../hooks/store-budget.js';
import { readVerdictArchives } from '../scripts/store-archives.mjs';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const GRACE = 10 * 60_000;

async function scope(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'quality');
  await mkdir(directory);
  return { root, directory };
}

async function archive(directory, family, sequence, size = 0, age = 0) {
  const name = archiveName(family, sequence, 0), path = join(directory, name);
  await writeFile(path, '');
  await truncate(path, size);
  await utimes(path, new Date(NOW - age), new Date(NOW - age));
  return name;
}

async function verdictHistory(directory) {
  const names = [];
  for (let i = 1; i <= 60; i++) names.push(await archive(directory, VERDICT_ARCHIVE, i, 1024 * 1024));
  return names;
}

test('retention removes oldest verdict archives until the real bytes fit the cap', async (t) => {
  const { directory } = await scope(t);
  const names = await verdictHistory(directory);
  const removed = await retainArchives(directory, { now: NOW });
  const left = await readdir(directory);
  assert.deepEqual([...removed].sort(), names.slice(0, 14).sort(), 'oldest verdict archives must be removed');
  assert.deepEqual(left.sort(), names.slice(14).sort(), 'the newest verdict history stays');
  const bytes = (await Promise.all(left.map((name) => stat(join(directory, name))))).reduce((sum, info) => sum + info.size, 0);
  assert.ok(bytes <= ARCHIVE_RETENTION_BYTES, 'remaining verdict bytes must fit the retention cap');
});

test('retention always keeps the newest verdict archive even when it alone exceeds the cap', async (t) => {
  const { directory } = await scope(t);
  const old = await archive(directory, VERDICT_ARCHIVE, 1, 1024);
  const newest = await archive(directory, VERDICT_ARCHIVE, 2, 90_000_000);
  await retainArchives(directory, { now: NOW });
  assert.deepEqual(await readdir(directory), [newest], 'the newest oversized verdict archive is always kept');
  assert.equal(await stat(join(directory, old)).then(() => true, () => false), false);
});

test('retention never removes non-empty store archives regardless of their size', async (t) => {
  const { directory } = await scope(t);
  const stores = [await archive(directory, STORE_ARCHIVE, 1, 80_000_000), await archive(directory, STORE_ARCHIVE, 2, 1)];
  await verdictHistory(directory);
  const removed = await retainArchives(directory, { now: NOW });
  for (const name of stores) assert.ok((await readdir(directory)).includes(name), 'non-empty store archives must stay');
  assert.ok(stores.every((name) => !removed.includes(name)), 'removed results must exclude non-empty store archives');
});

test('retention removes old zero-byte archives of both families but honours the ten-minute grace', async (t) => {
  const { directory } = await scope(t);
  const old = [], fresh = [];
  for (const family of [VERDICT_ARCHIVE, STORE_ARCHIVE]) {
    old.push(await archive(directory, family, 1, 0, GRACE + 1));
    fresh.push(await archive(directory, family, 2, 0, GRACE), await archive(directory, family, 3));
  }
  assert.deepEqual((await retainArchives(directory, { now: NOW })).sort(), old.sort(), 'only neutralised archives older than the grace are removed');
  assert.deepEqual((await readdir(directory)).sort(), fresh.sort(), 'fresh and grace-boundary zero-byte archives stay');
  const result = await readVerdictArchives(directory);
  assert.equal(result.unreadable.length, 0);
  assert.deepEqual(result.texts, ['', ''], 'empty verdict archives contribute zero rows');
});

test('fresh empty verdict archives are not evicted by the byte-budget sweep', async (t) => {
  const { directory } = await scope(t);
  const fresh = await archive(directory, VERDICT_ARCHIVE, 0);
  await verdictHistory(directory);
  await retainArchives(directory, { now: NOW });
  assert.ok((await readdir(directory)).includes(fresh), 'fresh partials stay for the full grace even when the verdict budget is exceeded');
});

test('retention leaves unrelated files and malformed archive names untouched', async (t) => {
  const { directory } = await scope(t);
  const names = ['unrelated.json', 'measure-rows-1.jsonl', 'rod-store-archive-bad.json', 'compliance-verdicts-archive-bad.jsonl'];
  for (const name of names) {
    await writeFile(join(directory, name), '');
    await utimes(join(directory, name), new Date(0), new Date(0));
  }
  await retainArchives(directory, { now: NOW });
  assert.deepEqual((await readdir(directory)).sort(), names.sort(), 'only recognised archives may be removed');
});

test('retention skips archive symlinks and never touches their outside targets', async (t) => {
  const { root, directory } = await scope(t);
  const outside = join(root, 'outside.jsonl');
  await writeFile(outside, 'outside data');
  const link = archiveName(VERDICT_ARCHIVE, 0, 0);
  await symlink(outside, join(directory, link));
  await archive(directory, VERDICT_ARCHIVE, 1, 30_000_000);
  await archive(directory, VERDICT_ARCHIVE, 2, 30_000_000);
  await retainArchives(directory, { now: NOW });
  assert.ok(await lstat(join(directory, link)).then((info) => info.isSymbolicLink(), () => false), 'archive symlinks must be skipped');
  assert.equal(await readFile(outside, 'utf8'), 'outside data', 'the outside target stays unchanged');
});

test('concurrent retention runs tolerate archives already removed by the other session', async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { directory } = await scope(t);
  await verdictHistory(directory);
  const original = fs.rm, selected = [];
  let releaseReady, releaseRemoved;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const removed = new Promise((resolve) => { releaseRemoved = resolve; });
  t.mock.method(fs, 'rm', async (path, options) => {
    if (selected.length >= 2) return original(path, options);
    selected.push(path);
    const order = selected.length;
    if (order === 2) releaseReady();
    await ready;
    // Both sessions selected the same still-present victim. The second rm starts after the first finished.
    if (order === 2) await removed;
    try { return await original(path, options); }
    finally { if (order === 1) releaseRemoved(); }
  });
  syncBuiltinESMExports();
  await assert.doesNotReject(Promise.all([retainArchives(directory, { now: NOW }), retainArchives(directory, { now: NOW })]),
    'concurrent sweeps must tolerate another session removing a victim');
  assert.equal(selected[0], selected[1], 'both sessions must select the same victim before it is removed');
  assert.equal((await readdir(directory)).length, 46, 'concurrent sweeps converge on the retained history without throwing');
});

test('an empty archive that gains content after the listing is kept', async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { directory } = await scope(t);
  const name = await archive(directory, STORE_ARCHIVE, 1, 0, GRACE + 1), path = join(directory, name);
  const original = fs.lstat;
  let completed = false;
  t.mock.method(fs, 'lstat', async (target, ...rest) => {
    const info = await original(target, ...rest);
    // The stalled writer finishes right after the sweep sampled the empty file.
    if (target === path && !completed) { completed = true; await writeFile(path, '{"format":2}'); }
    return info;
  });
  syncBuiltinESMExports();
  const removed = await retainArchives(directory, { now: NOW });
  assert.deepEqual(removed, [], 'a file that is no longer empty is not a partial');
  assert.equal(await readFile(path, 'utf8'), '{"format":2}', 'the completed archive stays');
});

test('one undeletable victim does not stop the others and is reported', async (t) => {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { directory } = await scope(t);
  const names = await verdictHistory(directory);
  const original = fs.rm, stuck = join(directory, names[0]);
  t.mock.method(fs, 'rm', async (path, options) => {
    if (path === stuck) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return original(path, options);
  });
  syncBuiltinESMExports();
  await assert.rejects(retainArchives(directory, { now: NOW }), (error) => error.message.includes(names[0]) && /EPERM|not permitted/.test(error.message));
  const left = await readdir(directory);
  assert.deepEqual(names.slice(1, 14).filter((name) => left.includes(name)), [], 'every other victim is still removed');
  assert.ok(left.includes(names[0]), 'the undeletable victim stays');
});

test('retention treats a missing directory as a no-op', async (t) => {
  const { root } = await scope(t);
  let result;
  await assert.doesNotReject(async () => { result = await retainArchives(join(root, 'missing'), { now: NOW }); }, 'missing archive directories must not throw');
  assert.deepEqual(result, [], 'missing archive directories are a no-op');
});

test('retention checks protected data directories before deleting any archive', async (t) => {
  const { root } = await scope(t);
  const directory = join(root, 'rules');
  await mkdir(directory);
  const old = await archive(directory, STORE_ARCHIVE, 1, 0, GRACE + 1);
  await assert.rejects(retainArchives(directory, { now: NOW }), { code: 'UNSAFE_DATA_DIR' }, 'unsafe data directories must be refused');
  assert.deepEqual(await readdir(directory), [old], 'refusal precedes deletion');
});
