import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm, mkdir, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';
import { sessionKey } from '../session-key.mjs';
import { FIRST_SCAN_CAP, INCREMENTAL_CAP, scanPlan, scanTranscript, announcement } from '../scripts/unload-watch-lib.mjs';

const script = fileURLToPath(new URL('../hooks/unload-watch.mjs', import.meta.url));
const unloadTime = '2026-01-02T03:04:05.123Z';
const now = '2026-01-02T03:05:00.000Z';
const later = '2026-01-02T03:04:05.124Z';
const unloadContent = 'wt-rules-on-demand: wt-rules-on-demand was unloaded: it crashed the hooks worker';
const row = (content, timestamp = unloadTime, subtype = 'informational') =>
  JSON.stringify({ type: 'system', subtype, content, timestamp }) + '\n';
const unload = row(unloadContent);
const empty = { offset: 0, unloadedAt: null, aliveAt: null, warnedAt: null };

async function scope(t, text = unload) {
  const root = await mkdtemp(join(tmpdir(), 'rod-unload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, text);
  const config = join(root, 'config');
  const dir = join(config, 'plugins', 'data', 'wt-rules-on-demand', 'unload-watch');
  return { transcript, config, dir, state: join(dir, `${sessionKey('fixture-session')}.json`) };
}
function run(s, event = {}, clock = now, raw) {
  const input = { session_id: 'fixture-session', transcript_path: s.transcript,
    hook_event_name: 'UserPromptSubmit', ...event };
  const args = s.preload ? ['--import', `data:text/javascript,${encodeURIComponent(s.preload)}`, script] : [script];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000,
    input: raw ?? JSON.stringify(input), env: cleanEnv({ CLAUDE_CONFIG_DIR: s.config, WT_ROD_NOW: clock }) });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}
const stateOf = async (s) => JSON.parse(await readFile(s.state, 'utf8'));
function pure(text, state = null, event = {}, clock = now) {
  const bytes = Buffer.from(text);
  return announcement(scanTranscript(bytes, scanPlan(bytes.length, state)),
    { hook_event_name: 'UserPromptSubmit', ...event }, clock);
}

test('unload without later alive evidence announces delivery loss in both hook channels', async (t) => {
  const s = await scope(t);
  const stdout = run(s);
  assert.notEqual(stdout, '', 'host unload must produce a warning');
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(output.hookSpecificOutput.additionalContext, output.systemMessage);
  assert.ok(output.systemMessage.includes(unloadTime), 'announcement must retain the unload timestamp');
  assert.match(output.systemMessage, /unloaded by the host.*heartbeat/);
  assert.match(output.systemMessage, /no at-act rule is served or refused/);
  assert.match(output.systemMessage, /main session.*\/reload-plugins.*restart/);
  assert.match(output.systemMessage, /sub-agent.*main session/);
  assert.equal((await stateOf(s)).unloadedAt, unloadTime);
  assert.notEqual(pure(unload).output, null);
});

const aliveContents = [
  ['plugin reload', 'wt-rules-on-demand: plugin.json changed — reloaded', 'informational'],
  ['hooks reload', 'wt-rules-on-demand: hooks.json changed — reloaded', 'informational'],
  ['local reload command', '<local-command-stdout>Reloaded: 13 plugins · 26 skills · 50 agents · 106 hooks · 7 plugin MCP servers · 0 plugin LSP servers</local-command-stdout>', 'local_command'],
  ['engine serve', 'wt-rules-on-demand: wt-rules-on-demand: serving fixture rule', 'informational'],
  ['engine refusal', 'wt-rules-on-demand: wt-rules-on-demand: before-act refusal serving fixture rule', 'informational'],
];
for (const [label, content, subtype] of aliveContents) {
  test(`${label} ends the announcement, preserving millisecond ordering`, async (t) => {
    const text = unload + row(content, later, subtype);
    const s = await scope(t, text);
    assert.equal(run(s), '');
    assert.equal((await stateOf(s)).aliveAt, later);
    assert.equal(pure(text).output, null);
  });
}

test('transcript order wins even when timestamps run backwards or use different timezones', () => {
  const text = row(aliveContents[0][1], '2026-01-02T04:04:05.122+01:00') + unload
    + row(unloadContent, '2026-01-02T03:04:04.999Z');
  const result = pure(text);
  assert.notEqual(result.output, null, 'last unload must beat preceding alive evidence');
  assert.equal(result.state.unloadedAt, '2026-01-02T03:04:04.999Z');
  assert.equal(pure(unload + row(aliveContents[0][1])).output, null, 'equal timestamps are not unloaded');
});

for (const kind of ['corrupt', 'oversized', 'unreadable']) {
  test(`${kind} watcher state resets and still announces`, async (t) => {
    const s = await scope(t);
    await mkdir(s.dir, { recursive: true });
    if (kind === 'unreadable') await mkdir(s.state);
    else await writeFile(s.state, kind === 'corrupt' ? '{bad json' : 'x'.repeat(16 * 1024 + 1));
    assert.notEqual(run(s), '', 'broken watcher state must not suppress the scan');
  });
}

function inject(s, op, condition) {
  s.preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const original = fs.${op}; fs.${op} = (...args) => {
      if (${condition}) throw new Error('injected ${op} failure');
      return original(...args);
    }; syncBuiltinESMExports();`;
}

test('stdout failure cannot commit warnedAt or consume a warning', async (t) => {
  const s = await scope(t, '');
  run(s);
  await appendFile(s.transcript, unload);
  inject(s, 'writeSync', 'args[0] === 1');
  assert.equal(run(s), '');
  assert.equal((await stateOf(s)).warnedAt, null, 'warnedAt must commit only after stdout succeeds');
  delete s.preload;
  assert.notEqual(run(s), '', 'failed stdout must leave a warning due');
});

test('pruning failure cannot consume the warning', async (t) => {
  const s = await scope(t);
  inject(s, 'readdirSync', `args[0] === ${JSON.stringify(s.dir)}`);
  assert.notEqual(run(s), '', 'a pruning failure must not suppress stdout');
  assert.equal((await stateOf(s)).warnedAt, now);
});

for (const recoveryLast of [true, false]) {
  test(`equal timestamp transcript order decides recovery (${recoveryLast ? 'recovery last' : 'unload last'})`, () => {
    const recovery = row(aliveContents[0][1], unloadTime);
    const result = pure(recoveryLast ? unload + recovery : recovery + unload);
    assert.equal(Boolean(result.output), !recoveryLast, 'last transcript evidence must decide unloaded state');
  });
}

// /reload-plugins prints one global summary ("Reloaded: 13 plugins · …") and never names a plugin,
// so any such summary reloads this one too; other local-command output is not recovery.
test('local-command output other than a plugin reload summary cannot prove recovery', () => {
  for (const content of ['<local-command-stdout>Reloaded: other-plugin</local-command-stdout>',
    '<local-command-stdout>Context usage: 13 plugins</local-command-stdout>']) {
    const text = unload + row(content, later, 'local_command');
    assert.notEqual(pure(text).output, null, 'only a reload summary proves recovery');
  }
});

test('watcher session aliases get distinct hashed state files', async (t) => {
  const s = await scope(t);
  assert.notEqual(run(s, { session_id: 'a/b' }), '');
  assert.notEqual(run(s, { session_id: 'a_b' }), '', 'sanitized aliases must not share warning state');
  const names = await readdir(s.dir);
  assert.equal(names.filter((name) => /^a_b-[0-9a-f]{32}\.json$/.test(name)).length, 2,
    'each session must have a distinct FNV-1a/128 filename');
});

test('watcher save failure still prunes expired recorder files', async (t) => {
  const s = await scope(t), dir = join(s.dir, '..', 'inflight');
  await mkdir(dir, { recursive: true });
  const old = join(dir, 'old.json');
  await writeFile(old, '{}');
  await utimes(old, new Date('2020-01-01'), new Date('2020-01-01'));
  inject(s, 'renameSync', `args[1] === ${JSON.stringify(s.state)}`);
  run(s);
  assert.deepEqual(await readdir(dir), [], 'state persistence failure must not skip retention');
});

for (const source of ['startup', 'resume']) {
  test(`SessionStart ${source} establishes a fresh process and remains silent afterwards`, async (t) => {
    const s = await scope(t);
    assert.notEqual(run(s), '');
    assert.equal(run(s, { hook_event_name: 'SessionStart', source }), '');
    assert.equal((await stateOf(s)).aliveAt, now);
    assert.equal(run(s, {}, '2026-01-02T03:20:00.000Z'), '');
    assert.equal(pure(unload, null, { hook_event_name: 'SessionStart', source }).output, null);
  });
}

test('incremental scan sees appended unload and leaves a UTF-8 partial line unconsumed', async (t) => {
  const prefix = row('unrelated fixture') + 'invalid JSON\n';
  const s = await scope(t, prefix);
  assert.equal(run(s), '');
  assert.equal((await stateOf(s)).offset, Buffer.byteLength(prefix));
  await appendFile(s.transcript, unload.slice(0, -1));
  assert.equal(run(s), '');
  assert.equal((await stateOf(s)).offset, Buffer.byteLength(prefix));
  await appendFile(s.transcript, '\n' + row('unrelated é fixture').slice(0, -1));
  assert.notEqual(run(s), '');
  assert.equal((await stateOf(s)).offset, Buffer.byteLength(prefix + unload));
  await appendFile(s.transcript, '\n');
  assert.equal(run(s), '');
  assert.equal((await stateOf(s)).offset, Buffer.byteLength(prefix + unload + row('unrelated é fixture')));
});

test('warning is rate limited for ten minutes, but compact always warns', async (t) => {
  const s = await scope(t);
  assert.notEqual(run(s), '');
  assert.equal(run(s, {}, '2026-01-02T03:14:59.999Z'), '');
  const compact = JSON.parse(run(s, { hook_event_name: 'SessionStart', source: 'compact' }));
  assert.equal(compact.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.notEqual(run(s, { hook_event_name: 'SessionStart', source: 'compact' }), '');
  assert.notEqual(run(s, {}, '2026-01-02T03:15:00.000Z'), '');
  assert.equal((await stateOf(s)).warnedAt, '2026-01-02T03:15:00.000Z');
});

test('first scan is bounded to the last 4 MiB: an older unload is outside observable history', async (t) => {
  const text = unload + 'x'.repeat(FIRST_SCAN_CAP) + '\n' + row('unrelated fixture');
  const s = await scope(t, text);
  const plan = scanPlan(Buffer.byteLength(text), null);
  assert.equal(plan.length, FIRST_SCAN_CAP);
  assert.ok(plan.start > Buffer.byteLength(unload));
  assert.equal(run(s), '');
  const state = await stateOf(s);
  assert.equal(state.unloadedAt, null);
  assert.equal(state.offset, Buffer.byteLength(text));
  await appendFile(s.transcript, row(unloadContent, later));
  assert.notEqual(run(s), '');
});

test('incremental scan caps a large append at 16 MiB and drops its boundary fragment', async (t) => {
  const s = await scope(t, '');
  assert.equal(run(s), '');
  const text = unload + 'x'.repeat(INCREMENTAL_CAP) + '\n' + row('unrelated fixture');
  await appendFile(s.transcript, text);
  assert.equal(scanPlan(Buffer.byteLength(text), empty).length, INCREMENTAL_CAP);
  assert.equal(run(s), '');
  assert.equal((await stateOf(s)).offset, Buffer.byteLength(text));
  assert.equal((await stateOf(s)).unloadedAt, null);
});

test('a capped boundary inside a long unfinished row never turns a JSON suffix into evidence', async (t) => {
  // Leading whitespace keeps the cut-off suffix valid JSON, so only the boundary alignment can reject it.
  const s = await scope(t, ' '.repeat(FIRST_SCAN_CAP + 100) + unload.slice(0, -1));
  assert.equal(run(s), '');
  await appendFile(s.transcript, '\n');
  assert.equal(run(s), '');
  assert.equal((await stateOf(s)).unloadedAt, null);
  await appendFile(s.transcript, unload);
  assert.notEqual(run(s), '');
});

test('malformed, non-system and unrelated rows cannot supply unload or alive evidence', () => {
  const forged = JSON.stringify({ type: 'user', subtype: 'informational', content: unloadContent, timestamp: unloadTime });
  assert.equal(pure('garbage\nnull\n' + forged + '\n' + row(unloadContent, 'invalid')).output, null);
  const text = unload + row('unrelated plugin: plugin.json changed — reloaded', later)
    + row(aliveContents[0][1], 'invalid') + row('Reloaded:', later, 'informational');
  assert.notEqual(pure(text).output, null);
});

test('garbage stdin, missing transcript and invalid input exit successfully without output', async (t) => {
  const s = await scope(t);
  for (const raw of ['garbage', 'null', '{}', JSON.stringify({ session_id: 'fixture-session' })]) {
    assert.equal(run(s, {}, now, raw), '');
  }
  assert.equal(run(s, { transcript_path: join(s.config, 'missing.jsonl') }), '');
});

test('state names hash session IDs and cleanup removes only old files above the threshold', async (t) => {
  const s = await scope(t);
  await mkdir(s.dir, { recursive: true });
  const old = join(s.dir, 'old.json'), fresh = join(s.dir, 'fresh.json');
  await writeFile(old, '{}');
  await writeFile(fresh, '{}');
  await utimes(old, new Date('2025-01-01'), new Date('2025-01-01'));
  for (let i = 0; i < 199; i++) await writeFile(join(s.dir, `fixture-${i}.json`), '{}');
  assert.notEqual(run(s, { session_id: '../fixture/session' }), '');
  const names = await readdir(s.dir);
  assert.ok(!names.includes('old.json'));
  assert.ok(names.includes('fresh.json'));
  assert.ok(names.includes(`${sessionKey('../fixture/session')}.json`));
});

test('hook registrations preserve startup and register all three watcher events exactly', async () => {
  const { modules, hooks } = JSON.parse(await readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const expected = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/unload-watch.mjs"', timeout: 10 };
  assert.deepEqual(modules, ['./hooks.js']);
  assert.deepEqual(hooks.SessionStart[0], { matcher: 'startup', hooks: [
    { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"', timeout: 10 },
  ] });
  assert.deepEqual(hooks.SessionStart[1], { hooks: [expected] });
  assert.deepEqual(hooks.UserPromptSubmit, [{ hooks: [expected] }]);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: 'Agent|Task|SendMessage', hooks: [expected] }]);
});

test('detector prunes inflight files by mtime after seven days, including a small directory', async (t) => {
  const s = await scope(t);
  const dir = join(s.config, 'plugins', 'data', 'wt-rules-on-demand', 'inflight');
  await mkdir(join(dir, 'nested'), { recursive: true });
  const times = { expired: '2025-12-26T03:04:59.999Z', boundary: '2025-12-26T03:05:00.000Z', fresh: now };
  for (const [name, time] of Object.entries(times)) {
    const path = join(dir, `${name}.json`);
    // Content start time deliberately disagrees with mtime: retention uses mtime only.
    await writeFile(path, JSON.stringify({ startedAt: name === 'expired' ? now : '2020-01-01' }));
    await utimes(path, new Date(time), new Date(time));
  }
  assert.notEqual(run(s), '');
  assert.deepEqual((await readdir(dir)).sort(), ['boundary.json', 'fresh.json', 'nested'], 'detector must prune expired inflight files by mtime');
});

test('inflight pruning visits at most 200 files and advances past fresh files on later hooks', async (t) => {
  const s = await scope(t);
  const dir = join(s.config, 'plugins', 'data', 'wt-rules-on-demand', 'inflight');
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < 200; index++) await writeFile(join(dir, `fresh-${String(index).padStart(3, '0')}.json`), '{}');
  const old = join(dir, 'z-old.json');
  await writeFile(old, '{}');
  await utimes(old, new Date('2020-01-01'), new Date('2020-01-01'));
  run(s);
  assert.ok((await readdir(dir)).includes('z-old.json'), 'a hook must inspect no more than 200 inflight files');
  run(s);
  assert.ok(!(await readdir(dir)).includes('z-old.json'), 'pruning must advance so old files cannot starve behind fresh ones');
  assert.equal((await readdir(dir)).length, 200);
});
