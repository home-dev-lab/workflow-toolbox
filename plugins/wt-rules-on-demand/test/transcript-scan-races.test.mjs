import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { scanTranscripts } from '../scripts/transcript-verdicts.mjs';
import { qualityCheck } from '../scripts/quality-check.mjs';

async function fixture(t) {
  const root = await promises.mkdtemp(join(tmpdir(), 'scan-'));
  t.after(() => promises.rm(root, { recursive: true, force: true }));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const projects = join(root, 'projects'), rulesDir = join(root, 'rules');
  await promises.mkdir(projects); await promises.mkdir(rulesDir);
  await promises.writeFile(join(rulesDir, 'a.md'), `---
on-demand:
  triggers:
    - kind: 'tool'
      tool: '^Agent$'
      unconditional: 'true'
  compliance:
    kind: 'tool-input'
    tool: '^Agent$'
    require-input-regex: 'yes'
    window: '1'
    on-close: 'not applicable'
---
Follow.
`);
  const put = async (name) => {
    const path = join(projects, name);
    await promises.mkdir(join(path, '..'), { recursive: true });
    await promises.writeFile(path, JSON.stringify({ type: 'assistant', cwd: root, timestamp: new Date().toISOString(),
      message: { content: [{ type: 'tool_use', id: name, name: 'Agent', input: { prompt: 'yes' } }] } }) + '\n');
    return path;
  };
  const scan = () => scanTranscripts({ projectsDirs: [projects], scopes: [{ scope: 'user', rulesDir }],
    migrationDateOf: async () => '2020-01-01T00:00:00Z', lastChangeOf: async () => '2020-01-01T00:00:00Z' });
  return { root, projects, put, scan };
}

function intercept(t, target, name, replacement) {
  const original = target[name];
  t.mock.method(target, name, (...args) => replacement(original, ...args));
  syncBuiltinESMExports();
}

test('listed transcript removed before open fails closed and reports its path', async (t) => {
  const f = await fixture(t);
  await f.put('kept.jsonl'); const gone = await f.put('gone.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => {
    if (path === gone) fs.unlinkSync(path);
    return original(path, options);
  });
  const result = await f.scan();
  assert.equal(result.complete, false, 'a vanished listed transcript must invalidate remaining evidence');
  assert.equal(result.stats.filesFailed, 1);
  assert.equal(result.coverage.filesFailed, 1);
  assert.deepEqual(result.stats.errors, [`${gone}: ENOENT (open)`]);
});

test('listed transcript whose parent becomes a file before open fails closed', async (t) => {
  const f = await fixture(t);
  await f.put('kept.jsonl'); const gone = await f.put('session/gone.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => {
    if (path === gone) { fs.rmSync(join(f.projects, 'session'), { recursive: true }); fs.writeFileSync(join(f.projects, 'session'), 'replaced'); }
    return original(path, options);
  });
  const result = await f.scan();
  assert.equal(result.complete, false, 'ENOTDIR at open must fail closed');
  assert.equal(result.stats.filesFailed, 1);
  // Opening through a parent that is now a file is ENOTDIR on POSIX; Windows reports the path as not found.
  const code = process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR';
  assert.match(result.stats.errors[0], new RegExp(`${code} \\(open\\)`));
  assert.ok(result.stats.errors[0].startsWith(`${gone}: `));
});

for (const phase of ['listing stat', 'window stat']) test(`listed transcript removed at ${phase} fails closed`, async (t) => {
  const f = await fixture(t);
  await f.put('kept.jsonl'); const gone = await f.put('gone.jsonl'); let calls = 0;
  intercept(t, promises, 'stat', async (original, path, ...args) => {
    if (path === gone && ++calls === (phase === 'listing stat' ? 1 : 2)) await promises.unlink(path);
    return original(path, ...args);
  });
  const result = await f.scan();
  assert.equal(result.complete, false, 'ENOENT at stat of a listed file must fail closed');
  assert.equal(result.stats.filesFailed, 1);
  assert.deepEqual(result.stats.errors, [`${gone}: ENOENT (stat)`]);
});

test('all listed transcripts vanishing is visible and remains incomplete', async (t) => {
  const f = await fixture(t); const gone = await f.put('gone.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => { fs.unlinkSync(path); return original(path, options); });
  const result = await f.scan();
  assert.equal(result.stats.filesFailed, 1, 'zero-read scan must retain failed evidence');
  assert.deepEqual(result.stats.errors, [`${gone}: ENOENT (open)`]);
  assert.equal(result.stats.filesRead, 0);
  assert.equal(result.complete, false);
});

test('failed paths are bounded while the count includes every missing file', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl');
  for (let n = 0; n < 55; n++) await f.put(`gone-${n}.jsonl`);
  intercept(t, fs, 'createReadStream', (original, path, options) => {
    if (path.includes('gone-')) fs.unlinkSync(path);
    return original(path, options);
  });
  const result = await f.scan();
  assert.equal(result.stats.filesFailed, 55, 'failed count must not be capped with the path list');
  assert.equal(result.stats.errors.length, 50);
  assert.equal(result.complete, false, 'mass disappearance must invalidate biased evidence');
});

test('memory backup trees are excluded while main and subagent transcript layouts remain scanned', async (t) => {
  const f = await fixture(t);
  const kept = await Promise.all(['direct.jsonl', 'slug/session.jsonl', 'slug/session/subagents/agent.jsonl',
    'slug/memory.bak-session.jsonl'].map(f.put));
  await f.put('slug/memory.bak-20261003-0404/compaction-snapshots/events.jsonl');
  const opened = [];
  intercept(t, fs, 'createReadStream', (original, path, options) => { opened.push(path); return original(path, options); });
  const result = await f.scan();
  assert.deepEqual(opened.sort(), kept.sort(), 'memory-store backup copies must never be opened as session transcripts');
  assert.equal(result.stats.filesRead, 4);
  assert.equal(result.complete, true);
});

test('EACCES at transcript open still fails closed rather than becoming vanished', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl'); const denied = await f.put('denied.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => path === denied
    ? new Readable({ read() { this.destroy(Object.assign(new Error('permission denied'), { code: 'EACCES' })); } })
    : original(path, options));
  const result = await f.scan();
  assert.equal(result.complete, false, 'permission denied must fail closed');
  assert.equal(result.stats.filesFailed, 1, 'permission denied must be failed evidence');
  assert.match(result.stats.errors[0], /EACCES|permission denied/);
});

test('malformed transcript with no valid records still fails closed', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl'); const bad = await f.put('bad.jsonl');
  await promises.writeFile(bad, '{"timestamp": invalid JSON\n');
  const result = await f.scan();
  assert.equal(result.complete, false, 'malformed transcript must fail closed');
  assert.equal(result.stats.filesFailed, 1, 'malformed transcript must be failed evidence');
  assert.deepEqual(result.stats.errors, [`${bad}: no valid transcript records`]);
});

test('quality report preserves failed count and paths when zero transcripts are read', async (t) => {
  const f = await fixture(t); const gone = await f.put('gone.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => { fs.unlinkSync(path); return original(path, options); });
  const dataDir = join(f.root, 'quality');
  await assert.rejects(qualityCheck({ configDirs: [f.root], projectsDirs: [f.projects], project: f.root, dataDir }),
    /0 transcript files read;.*files failed: 1;/, 'zero-read quality failure must name the failed count');
  const latest = JSON.parse(await promises.readFile(join(dataDir, 'latest.json'), 'utf8'));
  assert.equal(latest.ok, false);
  assert.ok(latest.error.includes(`${gone}: ENOENT`));
});

test('renamed transcript fails closed without retrying a changing tree', async (t) => {
  const f = await fixture(t); const kept = await f.put('slug/kept.jsonl');
  const old = await f.put('slug/session.jsonl'), renamed = join(f.projects, 'slug/renamed.jsonl');
  const opened = []; let enumerations = 0;
  intercept(t, promises, 'readdir', async (original, path, ...args) => {
    if (path === f.projects) enumerations++;
    return original(path, ...args);
  });
  intercept(t, fs, 'createReadStream', (original, path, options) => {
    opened.push(path);
    if (path === old) fs.renameSync(old, renamed);
    return original(path, options);
  });
  const result = await f.scan();
  assert.equal(result.complete, false, 'renamed evidence must fail closed');
  assert.equal(result.stats.filesRead, 1);
  assert.equal(result.rows.filter((row) => row.file === renamed).length, 0);
  assert.equal(opened.filter((path) => path === kept).length, 1);
  assert.equal(enumerations, 1, 'a changing tree must not be reconciled');
  assert.deepEqual(result.stats.errors, [`${old}: ENOENT (open)`]);
});

test('one of 56 transcripts gone fails closed and stays visible', async (t) => {
  const f = await fixture(t); const gone = await f.put('gone.jsonl');
  for (let n = 0; n < 55; n++) await f.put(`kept-${n}.jsonl`);
  intercept(t, fs, 'createReadStream', (original, path, options) => {
    if (path === gone) fs.unlinkSync(path);
    return original(path, options);
  });
  const result = await f.scan();
  assert.equal(result.complete, false, 'even one missing transcript must fail closed');
  assert.equal(result.stats.filesFailed, 1);
  assert.equal(result.stats.filesRead, 55);
  assert.deepEqual(result.stats.errors, [`${gone}: ENOENT (open)`]);
});

for (const change of ['renamed', 'deleted']) test(`${change} slug between stat and readdir fails closed`, async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl'); await f.put('slug/session.jsonl');
  const slug = join(f.projects, 'slug'); let changed = false;
  intercept(t, promises, 'readdir', async (original, path, ...args) => {
    if (path === slug && !changed) {
      changed = true;
      if (change === 'renamed') await promises.rename(slug, join(f.projects, 'renamed'));
      else await promises.rm(slug, { recursive: true });
    }
    return original(path, ...args);
  });
  const result = await f.scan();
  assert.equal(result.complete, false, 'lost subtree must fail closed');
  assert.equal(result.stats.filesRead, 1);
  assert.equal(result.stats.filesFailed, 1, 'unknown subtree must be failed evidence');
  assert.deepEqual(result.stats.errors, [`${slug}: ENOENT (scandir)`]);
});

test('genuine transcripts under backup-like names and at other depths remain scanned', async (t) => {
  const f = await fixture(t);
  const kept = await Promise.all(['memory.bak-imported/session.jsonl', 'slug/memory.bak-session/subagents/agent.jsonl',
    'slug/memory.bak-20261003/events.jsonl', 'memory.bak-20261003-0404/session.jsonl',
    'slug/session/memory.bak-20261003-0404/events.jsonl'].map(f.put));
  const result = await f.scan();
  assert.equal(result.stats.filesRead, kept.length, 'only timestamped snapshots directly under a slug are excluded');
  assert.deepEqual(result.rows.map((row) => row.file).sort(), kept.sort());
  assert.equal(result.complete, true);
});

test('ENOENT during read after successful open is failed evidence', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl'); const bad = await f.put('bad.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => original(path, path !== bad ? options : {
    ...options, fs: { open: fs.open, close: fs.close,
      read(fd, buffer, offset, length, position, callback) {
        callback(Object.assign(new Error('injected read failure'), { code: 'ENOENT', syscall: 'read' }));
      } },
  }));
  const result = await f.scan();
  assert.equal(result.complete, false, 'post-open ENOENT must fail closed');
  assert.equal(result.stats.filesFailed, 1);
  assert.deepEqual(result.stats.errors, [`${bad}: ENOENT (read)`]);
});

test('late close EIO after EOF is failed evidence', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl'); const bad = await f.put('bad.jsonl');
  intercept(t, fs, 'createReadStream', (original, path, options) => original(path, path !== bad ? options : {
    ...options, fs: { open: fs.open, read: fs.read,
      close(fd, callback) {
        fs.close(fd, () => callback(Object.assign(new Error('injected late close failure'), { code: 'EIO', syscall: 'close' })));
      } },
  }));
  const result = await f.scan();
  assert.equal(result.complete, false, 'late close error must fail closed');
  assert.equal(result.stats.filesFailed, 1);
  assert.equal(result.stats.filesRead, 1);
  assert.deepEqual(result.stats.errors, [`${bad}: EIO (close)`]);
});

test('zero-read quality failure preserves failed directory diagnostics', async (t) => {
  const f = await fixture(t); await f.put('slug/session.jsonl');
  const slug = join(f.projects, 'slug'); let changed = false;
  intercept(t, promises, 'readdir', async (original, path, ...args) => {
    if (path === slug && !changed) { changed = true; await promises.rm(slug, { recursive: true }); }
    return original(path, ...args);
  });
  const dataDir = join(f.root, 'quality');
  await assert.rejects(qualityCheck({ configDirs: [f.root], projectsDirs: [f.projects], project: f.root, dataDir }),
    /0 transcript files read;.*files failed: 1;/, 'zero-read failure must retain unknown-subtree diagnostics');
  const latest = JSON.parse(await promises.readFile(join(dataDir, 'latest.json'), 'utf8'));
  assert.equal(latest.ok, false);
  assert.ok(latest.error.includes(`${slug}: ENOENT`));
});

test('snapshot exclusion uses physical position even through shortened slug aliases', async (t) => {
  const f = await fixture(t);
  await f.put('z/session/memory.bak-20261003-0404/subagents/agent.jsonl');
  await f.put('z/memory.bak-20261003-0404/compaction-snapshots/events.jsonl');
  await promises.symlink(join(f.projects, 'z/session'), join(f.projects, 'a'), 'junction');
  await promises.symlink(join(f.projects, 'z'), join(f.projects, 'b'), 'junction');
  const opened = [];
  intercept(t, promises, 'readdir', async (original, path, ...args) => {
    const entries = await original(path, ...args);
    return path === f.projects ? entries.sort((a, b) => a.name.localeCompare(b.name)) : entries;
  });
  intercept(t, fs, 'createReadStream', (original, path, options) => { opened.push(path); return original(path, options); });
  const result = await f.scan();
  assert.equal(result.stats.filesRead, 1, 'alias depth must not hide genuine deeper evidence');
  assert.deepEqual(opened, [join(f.projects, 'a/memory.bak-20261003-0404/subagents/agent.jsonl')]);
  assert.equal(result.complete, true);
});

test('snapshot reached through a renamed directory alias remains excluded physically', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl');
  const snapshot = join(f.projects, 'slug/memory.bak-20261003-0404');
  await f.put('slug/memory.bak-20261003-0404/compaction-snapshots/events.jsonl');
  await promises.symlink(snapshot, join(f.projects, 'alias'), 'junction');
  const result = await f.scan();
  assert.equal(result.stats.filesRead, 1, 'physical snapshots must be excluded through any alias');
  assert.equal(result.complete, true);
});

test('cleanup close error after processing exception is included in diagnostics', async (t) => {
  const f = await fixture(t); await f.put('kept.jsonl'); const bad = await f.put('bad.jsonl');
  await promises.writeFile(bad, JSON.stringify({ type: 'assistant', cwd: {}, timestamp: new Date().toISOString() }) + '\n');
  let closed = false;
  intercept(t, fs, 'createReadStream', (original, path, options) => original(path, path !== bad ? options : {
    ...options, fs: { open: fs.open, read: fs.read,
      close(fd, callback) {
        fs.close(fd, () => setTimeout(() => {
          closed = true;
          callback(Object.assign(new Error('injected cleanup close failure'), { code: 'EIO', syscall: 'close' }));
        }, 10));
      } },
  }));
  const result = await f.scan();
  assert.equal(result.complete, false);
  assert.equal(closed, true, 'cleanup must finish before returning');
  assert.equal(result.stats.filesFailed, 1, 'one failed file may have multiple diagnostics');
  assert.ok(result.stats.errors.includes(`${bad}: ERR_INVALID_ARG_TYPE`), 'processing error must also remain diagnosed');
  assert.ok(result.stats.errors.includes(`${bad}: EIO (close)`), 'cleanup close error must be diagnosed alongside processing error');
});
