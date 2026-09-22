import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detections, optionalDetections } from './detector.js';
import { configure, register, testState, tokenize } from './hooks.js';
import { sha256 } from './sha256.js';
import { resolveReference } from './hooks.js';
import { opReadArgv, opReferencesIn, opValueFrom } from './op-resolve.js';
import { appendEvent, buildEvent, deriveAggregates, journalSnapshot, promotionStatus, recordDisposition } from './journal.js';
import { locateReplacements } from './prompt-storage.js';
import { rewriteReferences } from './reference-runtime.js';
import { verdictForBash, verdictForPath } from './secret-read-policy.js';
import { classifyOutbound } from './outbound-tools.js';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/secret-guard-corpus.json', import.meta.url), 'utf8'));

const hooks = []; const logs = []; const calls = [];
const configDir = '/tmp/wt-secret-guard-config';
const projectDir = '/tmp/wt-secret-guard-project';
const sessionId = 'session-fixture';
const historyPath = `${configDir}/history.jsonl`;
const transcriptPath = `${configDir}/projects/-tmp-wt-secret-guard-project/${sessionId}.jsonl`;
let nextInode = 1;
const files = new Map([
  ['/tmp/wt-secret-guard-file', { text: "file-secret value with ' quote\nsecond-file-secret", mode: 0o600, inode: nextInode++ }],
]);
const journalFiles = new Map();
// Claude Code's own environment as the host reports it through $.env.get. An environment reference
// is resolved from here - measured 2026-09-22 in a real `claude -p` session: $.env.get returns an
// arbitrary variable of the claude process - so a test sets what its command references.
const testEnv = new Map([['GH_TOKEN', 'fixture-gh-token-value'], ['QUOTE_SECRET', "quote ' secret"]]);
const setFile = (path, text, mode = 0o600) => files.set(path, { text, mode, inode: nextInode++ });
const getFile = (path) => files.get(path);
let onSleep;
let onBeforeCompare;
let onBeforeWrite;
let onBeforeWindowsWrite;
const readFile = async (path) => {
  if (typeof path !== 'string') throw new Error('fs.read takes a path string (positional)');
  if (!files.has(path)) throw new Error('ENOENT');
  if (Buffer.byteLength(files.get(path).text) > 4 * 1024 * 1024) throw new Error('fs.read rejects files above 4 MiB');
  return files.get(path).text;
};
const $ = {
  ui: { log: async (line) => logs.push(line) },
  fs: {
    read: readFile,
    readFile,
    write: async (path, text) => {
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('fs.write rejects files above 4 MiB');
      journalFiles.set(path, text); calls.push({ capability: 'fs.write', path, value: text });
    },
    stat: async (path) => {
      if (!files.has(path)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return { kind: 'file', size: Buffer.byteLength(files.get(path).text), mtimeMs: 0, ino: files.get(path).inode, realPath: path };
    },
  },
  store: { get: async () => ({}), set: async (key, value) => calls.push({ capability: 'store.set', key, value }) },
  process: { run: async (argv, init) => {
    calls.push({ capability: 'process.run', argv });
    if (argv[0] === 'dd') {
      const option = (name) => argv.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
      const inputPath = option('if');
      const outputPath = option('of');
      const offset = Number(option(inputPath ? 'skip' : 'seek'));
      const length = Number(option('count'));
      if (inputPath) {
        if (onBeforeCompare) await onBeforeCompare(inputPath, offset, length);
        return { exitCode: 0, stdout: Buffer.from(getFile(inputPath).text).subarray(offset, offset + length).toString() };
      }
      if (onBeforeWrite) await onBeforeWrite(outputPath, offset, init.stdin);
      const file = getFile(outputPath);
      const before = Buffer.from(file.text);
      const replacement = Buffer.from(init.stdin);
      const afterLength = argv.includes('conv=notrunc') ? Math.max(before.length, offset + replacement.length) : offset + replacement.length;
      const after = Buffer.alloc(afterLength);
      before.copy(after, 0, 0, Math.min(before.length, afterLength));
      replacement.copy(after, offset);
      file.text = after.toString();
      return { exitCode: 0, stdout: '' };
    }
    if (/powershell/i.test(argv[0])) {
      assert.equal(argv[3], '-File', 'PowerShell repair must use -File argv semantics');
      const path = argv[5];
      const offset = Number(argv[6]);
      const length = Number(argv[7]);
      const mode = argv[8];
      const file = getFile(path);
      if (mode === 'read') return { exitCode: 0, stdout: Buffer.from(file.text).subarray(offset, offset + length).toString('base64') };
      if (onBeforeWindowsWrite) await onBeforeWindowsWrite(path, offset);
      const before = Buffer.from(file.text);
      const expected = argv[10] ? Buffer.from(argv[10], 'base64') : null;
      const expectedSize = argv[11] === undefined ? null : Number(argv[11]);
      const expectedPrefix = argv[12] ? Buffer.from(argv[12], 'base64') : null;
      let recordMatches = true;
      if (argv[15]) {
        const recordOffset = Number(argv[13]); const recordLength = Number(argv[14]);
        try {
          const record = JSON.parse(before.subarray(recordOffset, recordOffset + recordLength).toString());
          const carries = (value) => value && typeof value === 'object' && ((value.type === 'tool_use' && value.id === argv[15]) || Object.values(value).some(carries));
          recordMatches = carries(record)
            && (recordOffset === 0 || before[recordOffset - 1] === 10)
            && (recordOffset + recordLength === before.length || before[recordOffset + recordLength] === 10);
        } catch { recordMatches = false; }
      }
      if ((expectedSize !== null && before.length !== expectedSize)
        || (expectedPrefix && !before.subarray(0, expectedPrefix.length).equals(expectedPrefix))
        || (expected && !before.subarray(offset, offset + length).equals(expected)) || !recordMatches) return { exitCode: 3, stdout: '' };
      const replacement = Buffer.from(argv[9], 'base64');
      const after = Buffer.alloc(Math.max(before.length, offset + replacement.length));
      before.copy(after); replacement.copy(after, offset); file.text = after.toString();
      return { exitCode: 0, stdout: '' };
    }
    if (argv[0] === 'node' && /prompt-storage-range\.mjs$/.test(argv[1])) {
      const path = argv[2]; const offset = Number(argv[3]); const length = Number(argv[4]); const inode = argv[5];
      if (argv[6] === 'read') {
        if (onBeforeCompare) await onBeforeCompare(path, offset, length);
        return { exitCode: 0, stdout: Buffer.from(getFile(path).text).subarray(offset, offset + length).toString('base64') };
      }
      if (onBeforeWrite) await onBeforeWrite(path, offset, init.stdin);
      const file = getFile(path); const payload = JSON.parse(init.stdin);
      const expected = Buffer.from(payload.expected, 'base64'); const replacement = Buffer.from(payload.replacement, 'base64');
      const before = Buffer.from(file.text);
      const prefix = payload.prefix ? Buffer.from(payload.prefix, 'base64') : null;
      let recordMatches = true;
      if (payload.toolUseId) {
        try {
          const record = JSON.parse(before.subarray(payload.recordOffset, payload.recordOffset + payload.recordLength).toString());
          const carries = (value) => value && typeof value === 'object' && ((value.type === 'tool_use' && value.id === payload.toolUseId) || Object.values(value).some(carries));
          recordMatches = carries(record)
            && (payload.recordOffset === 0 || before[payload.recordOffset - 1] === 10)
            && (payload.recordOffset + payload.recordLength === before.length || before[payload.recordOffset + payload.recordLength] === 10);
        } catch { recordMatches = false; }
      }
      if (inode && String(file.inode) !== inode) return { exitCode: 2, stdout: '' };
      if (payload.size !== undefined && before.length !== payload.size) return { exitCode: 6, stdout: '' };
      if ((prefix && !before.subarray(0, prefix.length).equals(prefix))
        || !before.subarray(offset, offset + length).equals(expected) || !recordMatches) return { exitCode: 3, stdout: '' };
      const after = Buffer.alloc(Math.max(before.length, offset + replacement.length));
      before.copy(after); replacement.copy(after, offset); file.text = after.toString();
      return { exitCode: 0, stdout: '' };
    }
    if (argv[0] === 'node' && /journal-append\.mjs$/.test(argv[1])) {
      const path = argv[2];
      journalFiles.set(path, `${journalFiles.get(path) ?? ''}${init.stdin}`);
      return { exitCode: 0, stdout: path };
    }
    return { exitCode: 0, stdout: /^op(?:\.exe)?$/.test(argv[0]) ? 'op-fake-value\n' : '' };
  } },
  env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: configDir, HOME: '/tmp/home' })[name] ?? testEnv.get(name) },
  session: { cwd: async () => projectDir, id: async () => sessionId },
  clock: { sleep: async () => { if (onSleep) await onSleep(); }, now: () => 0 },
  plugin: { root: '/opt/wt-secret-guard' },
};
const journalHostFor = (runtime) => ({
  getSalt: () => runtime.store.get('salt'), setSalt: (value) => runtime.store.set('salt', value),
  setDetections: (value) => runtime.store.set('detections', value), getStats: () => runtime.store.get('stats'),
  setStats: (value) => runtime.store.set('stats', value), setLastPublishedAt: (value) => runtime.store.set('lastpublishedat', value),
  fsRead: (path) => runtime.fs.read(path), fsWrite: (path, text) => runtime.fs.write(path, text), fsStat: (path) => runtime.fs.stat(path), processRun: (argv, init) => runtime.process.run(argv, init), pluginRoot: () => runtime.plugin.root, configDir: () => runtime.env.get('CLAUDE_CONFIG_DIR'), home: () => runtime.env.get('HOME'),
  sessionId: () => runtime.session.id(), sessionCwd: () => runtime.session.cwd(), uiLog: (text) => runtime.ui.log(text),
});
const referenceHostFor = (runtime) => ({
  envGet: (name) => runtime.env.get(name),
  processRun: (argv) => runtime.process.run(argv), fsRead: (path) => runtime.fs.read(path), uiLog: (text) => runtime.ui.log(text),
});
register((event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }));
const bash = hooks.find((hook) => hook.event === 'tool.call').hook;
const prompt = hooks.find((hook) => hook.event === 'prompt.submit').hook;
const receive = hooks.find((hook) => hook.event === 'session.receive')?.hook;
const context = hooks.find((hook) => hook.event === 'prompt.context')?.hook;
const read = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === 'Read').hook;
const notebookRead = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === 'NotebookRead').hook;
const mcp = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool instanceof RegExp).hook;
const hookForTool = (name) => hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === name)?.hook;
const turnStep = hooks.find((hook) => hook.event === 'turn.step')?.hook;
const assistantRender = hooks.find((hook) => hook.event === 'ui.render' && hook.matcher?.component === 'AssistantMessage')?.hook;
const attachment = hooks.find((hook) => hook.event === 'prompt.attachment')?.hook;
const call = (command, output) => bash($, { tool: 'Bash', command }, async (event) => ({ result: { stdout: output ?? event.command, stderr: '' }, text: output ?? event.command }));
let failures = 0;
class SkipTest extends Error {}
async function test(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (error) { if (error instanceof SkipTest) console.log(`SKIP ${name}: ${error.message}`); else { failures += 1; console.log(`FAIL ${name}: ${error.message}`); } } }

const github = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const aws = 'AKIA1234567890ABCDEF';
const opFake = 'FAKEKEYFAKEKEYFAKEKEY0123456789';
const exa = '123e4567-e89b-12d3-a456-426614174000';
const brave = `BSA${'a1B_'.repeat(7)}`;
await test('inbound known-vendor credential is withheld with a visible revocation notice', async () => {
  assert(receive, 'session.receive hook was not registered');
  const input = { origin: { kind: 'peer' }, text: `please inspect ${github}` };
  const received = [];
  const beforeLogs = logs.length;
  const result = await receive($, input, async (event) => { received.push(event); return { queued: true }; });
  assert.equal(result.queued, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].origin, input.origin);
  assert.equal(received[0].text.includes(github), false, 'raw inbound credential reached the session');
  assert.match(received[0].text, /secret:github-classic#/);
  assert.match(received[0].text, /only remedy is revocation/i);
  assert.match(received[0].text, /https:\/\/github\.com\/settings\/tokens/);
  assert.match(received[0].text, /cannot unsend/i);
  assert.equal(logs.slice(beforeLogs).some((line) => line.includes(github)), false);
  assert(logs.slice(beforeLogs).some((line) => /credential.*revocation/i.test(line)));
});
await test('ordinary inbound message mentioning key is unchanged and answerable', async () => {
  assert(receive, 'session.receive hook was not registered');
  const input = { origin: { kind: 'bridge' }, text: 'Which key opens the storage room?' };
  const received = [];
  const beforeLogs = logs.length;
  const outcome = { queued: true };
  const result = await receive($, input, async (event) => { received.push(event); return outcome; });
  assert.deepEqual(received, [input]);
  assert.equal(result, outcome);
  assert.equal(logs.length, beforeLogs);
});
await test('does not register an inert user-tier prompt.context guard', async () => { assert.equal(context, undefined); });
await test('sha256 known answer', async () => { assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
await test('shared corpus contains the 47 SR Cloud verdicts plus review locks and no local workspace path', async () => {
  assert.equal(corpus.denyCommands.length, 52);
  assert.equal(JSON.stringify(corpus).includes('/home/'), false);
});
await test('shared detector corpus characterizes built-in and optional cases', async () => {
  for (const fixture of corpus.detections) assert.equal(detections(fixture.text)[0]?.kind ?? null, fixture.kind, fixture.name);
  for (const fixture of corpus.optionalDetections) assert.equal(optionalDetections(fixture.text, fixture.options)[0]?.kind ?? null, fixture.kind, fixture.name);
});
await test('token format is stable for a repeated value', async () => {
  const value = 'fixture-token-format-value';
  const first = tokenize('fixture', value);
  assert.match(first, /^secret:fixture#[a-f0-9]{6}$/);
  assert.equal(tokenize('another-kind', value), first);
});
await test('op resolver pure helpers cover defaults, account selection, deduplication and empty output', async () => {
  assert.deepEqual(opReadArgv('op://vault/item/field'), ['op', 'read', 'op://vault/item/field']);
  assert.deepEqual(opReadArgv('op://vault/item/field', 'team', ''), ['op', 'read', '--account', 'team', 'op://vault/item/field']);
  assert.deepEqual(opReferencesIn('echo op://vault/item/field op://vault/item/field secret:1p:other/item/password'), [
    'op://vault/item/field',
    'op://other/item/password',
  ]);
  assert.deepEqual(opReferencesIn(null), []);
  assert.equal(opValueFrom({ stdout: 'value\r\n' }), 'value');
  assert.equal(opValueFrom(), '');
});
await test('output scrub and distinct tokens', async () => { const result = await call('x', `${github}\n${aws}`); assert(!JSON.stringify(result).includes(github)); assert(!JSON.stringify(result).includes(aws)); const entries = [...testState().values()]; assert(entries.some((entry) => entry.kind === 'github-classic')); assert(entries.some((entry) => entry.kind === 'aws-access-key')); });
await test('plain-line op credential output is scrubbed', async () => { const result = await call('op item get example --fields credential', `credential: ${opFake}`); assert.equal(JSON.stringify(result).includes(opFake), false); assert.match(result.text, /secret:op-output#/); });
const concealedJson = (value) => JSON.stringify({ id: 'credential', label: 'credential', type: 'CONCEALED', value, padding: 'x'.repeat(100) }, null, 2);
await test('complete concealed JSON output is scrubbed', async () => {
  const concealed = concealedJson(opFake);
  const result = await call('op item get example --fields credential --format json', concealed);
  assert.equal(JSON.stringify(result).includes(opFake), false, 'concealed JSON value reached the tool result');
  assert.match(result.text, /secret:op-json-concealed#/);
});
await test('truncated concealed JSON output is scrubbed', async () => {
  const value = 'TRUNCATEDFAKEKEYFAKEKEY0123456789';
  const concealed = concealedJson(value);
  const truncated = concealed.slice(0, concealed.indexOf(value) + value.length + 1);
  const result = await call('op.exe item get example --fields label=credential --format json 2>&1 | head -c 120', truncated);
  assert.equal(JSON.stringify(result).includes(value), false, 'truncated concealed JSON value reached the tool result');
});
await test('stderr-prefixed concealed JSON output is scrubbed', async () => {
  const value = 'PREFIXEDFAKEKEYFAKEKEY0123456789';
  const concealed = concealedJson(value);
  const result = await call('op.exe item get example --fields label=credential --format json 2>&1', `warning: fake diagnostic\n${concealed}`);
  assert.equal(JSON.stringify(result).includes(value), false, 'stderr-prefixed concealed JSON value reached the tool result');
});
await test('trailing-line concealed JSON output is scrubbed', async () => {
  const value = 'TRAILINGFAKEKEYFAKEKEY0123456789';
  const concealed = concealedJson(value);
  const result = await call('op.exe item get example --fields label=credential --format json; echo EXIT=$?', `${concealed}\nEXIT=0`);
  assert.equal(JSON.stringify(result).includes(value), false, 'trailing-line concealed JSON value reached the tool result');
});
await test('concealed JSON escaped values are decoded while serialized bytes are scrubbed', async () => {
  const escapedFake = 'ESCAPEDFAKEESCAPEDFAKE0123456789"\\suffix';
  const escaped = await call('op item get example --format json', JSON.stringify({ type: 'CONCEALED', value: escapedFake }, null, 2));
  assert.equal(escaped.text.includes(JSON.stringify(escapedFake).slice(1, -1)), false, 'escaped concealed JSON value reached the tool result');
  assert([...testState().values()].some((entry) => entry.kind === 'op-json-concealed' && entry.value === escapedFake));
});
await test('ordinary JSON values are not scrubbed', async () => {
  const ordinary = '{"label":"status","value":"ready"}';
  assert.equal((await call('tool --json', ordinary)).text, ordinary);
});
await test('malformed concealed JSON does not throw and scrubs its value', async () => {
  const malformed = '{"type":"CONCEALED","value":"MALFORMEDFAKEKEY0123456789"';
  const result = await call('op item get example --format json', malformed);
  assert.equal(result.text.includes('MALFORMEDFAKEKEY0123456789'), false, 'malformed concealed JSON value reached the tool result');
  const imprecise = '{"type":"CONCEALED","value":IMPRECISEFAKEKEY0123456789';
  const failSafe = await call('op item get example --format json', imprecise);
  assert.equal(failSafe.text.includes('IMPRECISEFAKEKEY0123456789'), false, 'imprecise concealed JSON fragment reached the tool result');
});
await test('token round-trip binds decoded data without inserting raw shell source', async () => { const [token, entry] = [...testState()][0]; let received; await bash($, { tool: 'Bash', command: `printf %s ${token}` }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received.includes(entry.value), false); assert.match(received, /base64 --decode/); assert.equal(spawnSync('bash', ['-c', received], { encoding: 'utf8' }).stdout, entry.value); });
await test('op reference rewrite with shell quoting', async () => { let received; const result = await bash($, { tool: 'Bash', command: 'echo "op://Private/O\'Brien/token"' }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, "echo \"$(op read 'op://Private/O'\"'\"'Brien/token')\""); assert.equal((result.text.match(/wt-secret-guard: rewrote/g) ?? []).length, 1); });
await test('op reference rewrite carries --account when the opAccount option is set', async () => { const { configure } = await import('./hooks.js'); configure({ opAccount: "my.1password.com" }); let received; await bash($, { tool: 'Bash', command: 'echo op://Private/item/field' }, async (event) => { received = event.command; return { text: 'ok' }; }); configure({}); assert.equal(received, "echo \"$(op read --account 'my.1password.com' 'op://Private/item/field')\""); let plain; await bash($, { tool: 'Bash', command: 'echo op://Private/item/field' }, async (event) => { plain = event.command; return { text: 'ok' }; }); assert.equal(plain, "echo \"$(op read 'op://Private/item/field')\""); });
await test('a value resolved through op:// is scrubbed from the result even when it matches no pattern', async () => { const result = await bash($, { tool: 'Bash', command: 'echo op://Private/item/pw' }, async () => ({ result: { stdout: 'op-fake-value\n', stderr: '' }, text: 'op-fake-value\n' })); assert(!JSON.stringify(result).includes('op-fake-value')); assert(/secret:onepassword#/.test(result.text)); assert(calls.some((call) => call.capability === 'process.run' && call.argv[0] === 'op' && call.argv[1] === 'read')); });
await test('double-quoted op reference rewrites with exactly one level of quoting', async () => { let received; await bash($, { tool: 'Bash', command: 'export K="op://Private/item/field"' }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, 'export K="$(op read \'op://Private/item/field\')"'); });
await test('single-quoted op reference rewrites with exactly one level of quoting', async () => { let received; await bash($, { tool: 'Bash', command: "echo 'op://Private/item/field'" }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, 'echo "$(op read \'op://Private/item/field\')"'); });
const assertSkippedWhilePlainRewrites = async (command) => {
  let skipped; let plain;
  await bash($, { tool: 'Bash', command }, async (event) => { skipped = event.command; return { text: 'ok' }; });
  await bash($, { tool: 'Bash', command: 'echo op://Private/item/field' }, async (event) => { plain = event.command; return { text: 'ok' }; });
  assert.equal(skipped, command);
  assert.equal(plain, 'echo "$(op read \'op://Private/item/field\')"');
};
await test('op reference written to a tpl file is left literal', async () => { let executed = false; const result = await bash($, { tool: 'Bash', command: "printf '%s\\n' 'op://Private/item/field' > /tmp/profile.tpl" }, async () => { executed = true; return {}; }); assert.equal(executed, false); assert.match(result.deny, /refused/i); });
await test('V30 a heredoc that MENTIONS a reference triggers no op call and passes untouched', async () => {
  // Decision (round 8 addendum): a heredoc body is not a context the guard expands. It cannot tell
  // "inject this secret into a file" from "write a doc, a test or a brief that mentions a
  // reference" - three real 1Password prompts in one night came from the second - and the first is
  // exactly the path that writes a secret to disk. Injection into files belongs to `op inject`.
  const token = tokenize('fixture', 'heredoc-token-value');
  const references = ['op://Private/heredoc/field', 'secret:env:GH_TOKEN', 'secret:file:/tmp/wt-secret-guard-file', token];
  const shapes = [];
  for (const reference of references) {
    shapes.push(`cat <<EOF\n${reference}\nEOF`, `cat <<'EOF'\n${reference}\nEOF`, `cat <<"EOF"\n${reference}\nEOF`, `cat > /tmp/brief.md <<EOF\nSee ${reference} for details.\nEOF`);
  }
  shapes.push('cat <<EOF\nop read op://Private/heredoc/field\nEOF');
  for (const command of shapes) {
    const spawned = [];
    const runtime = { ...$, process: { run: async (argv, init) => { if (/^op(?:\.exe)?$/.test(argv[0])) spawned.push(argv); return $.process.run(argv, init); } } };
    let received;
    const result = await bash(runtime, { tool: 'Bash', command }, async (event) => { received = event.command; return { text: 'ok' }; });
    assert.equal(result?.deny, undefined, `a heredoc mentioning a reference was refused: ${JSON.stringify(command)} -> ${result?.deny}`);
    assert.equal(received, command, `a heredoc mentioning a reference was rewritten: ${JSON.stringify(command)}`);
    assert.equal(spawned.length, 0, `a heredoc mentioning a reference spawned op: ${JSON.stringify(command)}`);
  }
  // The same reference OUTSIDE the heredoc, on the command line, is still ours.
  const mixed = "printf %s 'op://Private/heredoc/field'; cat <<EOF\nop://Private/heredoc/field\nEOF";
  let rewritten;
  await bash($, { tool: 'Bash', command: mixed }, async (event) => { rewritten = event.command; return { text: 'ok' }; });
  assert.match(rewritten, /^printf %s "\$\(op read 'op:\/\/Private\/heredoc\/field'\)"; cat <<EOF\nop:\/\/Private\/heredoc\/field\nEOF$/, 'the command-line reference was not expanded, or the heredoc one was');
});
await test('op reference in a sed search pattern is left literal', async () => { await assertSkippedWhilePlainRewrites("sed -n '/op:\\/\\/Private\\/item\\/field/p' /tmp/input"); });
await test('op reference inside a larger quoted string is left literal', async () => { let executed = false; const result = await bash($, { tool: 'Bash', command: "printf '%s\\n' 'prefix op://Private/item/field suffix'" }, async () => { executed = true; return {}; }); assert.equal(executed, false); assert.match(result.deny, /refused/i); });
await test('already substituted op reference is not rewritten again', async () => { await assertSkippedWhilePlainRewrites("echo \"$(op read 'op://Private/item/field')\""); });
await test('env reference rewrite binds the value the guard read, never the raw shell variable', async () => {
  let received;
  await bash($, { tool: 'Bash', command: 'echo secret:env:GH_TOKEN' }, async (event) => { received = event.command; return { text: 'ok' }; });
  assert.equal(received.includes('fixture-gh-token-value'), false, 'the raw value appears in the rewritten command');
  assert.equal(received.includes('${GH_TOKEN}'), false, 'the shell variable is expanded by the shell instead of the value the guard knows');
  assert.match(received, /base64 --decode/);
  assert.equal(spawnSync('bash', ['-c', received], { encoding: 'utf8', env: { PATH: process.env.PATH } }).stdout, 'fixture-gh-token-value\n');
});
await test('file reference rewrite binds encoded data and tokenises its content before Bash runs', async () => { const value = "file-secret value with ' quote\nsecond-file-secret"; let received; const result = await bash($, { tool: 'Bash', command: 'echo secret:file:/tmp/wt-secret-guard-file' }, async (event) => { received = event.command; return { text: value }; }); assert.equal(received.includes(value), false); assert.match(received, /base64 --decode/); assert(!JSON.stringify(result).includes(value)); assert.match(result.text, /secret:file#/); });
await test('file reference line selection binds and tokenises only that line', async () => { let received; const result = await bash($, { tool: 'Bash', command: 'echo secret:file:/tmp/wt-secret-guard-file#2' }, async (event) => { received = event.command; return { text: 'second-file-secret' }; }); assert.equal(received.includes('second-file-secret'), false); assert.match(received, /base64 --decode/); assert(!JSON.stringify(result).includes('second-file-secret')); assert.match(result.text, /secret:file#/); });
await test('missing file reference is refused and logs no path or value', async () => { let executed = false; const result = await bash($, { tool: 'Bash', command: 'cat secret:file:/tmp/wt-secret-guard-missing' }, async () => { executed = true; return { text: 'failed' }; }); assert.equal(executed, false); assert.match(result.deny, /refused/i); assert(logs.some((line) => line === 'wt-secret-guard: file reference unavailable (1 reference)')); assert(logs.every((line) => !line.includes('/tmp/wt-secret-guard-missing'))); });
await test('Read result scrub publishes tokens without treating its path as a secret', async () => { const value = 'read-result-secret'; const result = await read($, { tool: 'Read', file_path: '/tmp/not-a-secret' }, async (event) => ({ ...event, text: `password = ${value}` })); assert(!JSON.stringify(result).includes(value)); assert.equal(result.file_path, '/tmp/not-a-secret'); assert.match(result.text, /secret:assignment#/); });
await test('MCP result scrub tokenises inbound sensitive text without rewriting its input', async () => { const value = 'mcp-result-secret'; const event = { tool: 'mcp__atrium__read_message', query: 'clean control' }; const result = await mcp($, event, async (received) => ({ ...received, text: `token = ${value}` })); assert(!JSON.stringify(result).includes(value)); assert.equal(result.tool, event.tool); assert.equal(result.query, event.query); assert.match(result.text, /secret:assignment#/); });
await test('Bash secret-file reads warn and execute in measurement mode', async () => {
  const command = corpus.denyCommands.find((fixture) => fixture.verdict)?.command;
  let received;
  const result = await bash($, { tool: 'Bash', command }, async (event) => { received = event; return { text: 'fixture file contents' }; });
  assert.equal(received.command, command);
  assert.equal(result.deny, undefined);
  assert.match(result.text, /WOULD BLOCK; executed in measurement mode/);
});
await test('all SR Cloud and review rows retain their recorded verdicts', async () => {
  for (const fixture of corpus.denyCommands) assert.equal(verdictForBash(fixture.command).verdict, fixture.verdict, fixture.command);
});
await test('Bash policy evaluates the byte-identical original before reference rewrites', async () => {
  const command = 'cat ~/.npmrc && echo op://Private/item/field';
  let received;
  const result = await bash($, { tool: 'Bash', command, tool_use_id: 'tool-order' }, async (event) => { received = event.command; return { text: 'ok' }; });
  assert.equal(received.includes('op read'), true);
  assert.match(result.text, /WOULD BLOCK; executed in measurement mode/);
});
await test('Read and NotebookRead guarded paths warn but still execute', async () => {
  for (const [hook, event] of [[read, { tool: 'Read', file_path: '/tmp/.env' }], [notebookRead, { tool: 'NotebookRead', notebook_path: '/tmp/.aws/credentials' }]]) {
    let executed = false;
    const result = await hook($, event, async () => { executed = true; return { text: 'contents' }; });
    assert.equal(executed, true);
    assert.match(result.text, /WOULD BLOCK; executed in measurement mode/);
  }
});
await test('malformed read events fail open after a value-free evaluation', async () => {
  const result = await read($, { tool: 'Read', file_path: { unexpected: true } }, async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
});
await test('prose mentions pass and journal mention-allowed without command text', async () => {
  const command = 'echo "the .npmrc file is documented in the README"';
  const result = await bash($, { tool: 'Bash', command }, async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
  const journal = [...journalSnapshot().values()].join('\n');
  assert(journal.includes('mention-allowed'));
  assert.equal(journal.includes(command) || journal.includes('.npmrc'), false);
});
await test('secret-file warning option off remains fail-open and journals policy-disabled', async () => {
  configure({ secretFileReadWarnings: false });
  const before = calls.length;
  const result = await bash($, { tool: 'Bash', command: 'cat ~/.npmrc' }, async () => ({ text: 'ok' }));
  assert.equal(result.text, 'ok');
  assert([...journalSnapshot().values()].some((value) => value.includes('policy-disabled')));
  configure({});
});
await test('journal builder permits fixed enums and identifiers only', async () => {
  const event = await buildEvent(journalHostFor($), { surface: 'bash', action: 'would-block', ruleId: 'guarded-path-read', pathClass: 'npm-config', commandClass: 'bash', toolUseId: 'tool-safe', command: 'cat fixture-secret-path', arbitrarySecretKey: 'fixture-secret-value' });
  assert.deepEqual(Object.keys(event).sort(), ['action', 'at', 'commandClass', 'count', 'pathClass', 'project', 'ruleId', 'sessionId', 'surface', 'toolUseId', 'version'].sort());
  assert.equal(JSON.stringify(event).includes('fixture-secret'), false);
});
await test('journal uses distinct append-only session files for concurrent sessions', async () => {
  const runtime = (id) => ({ ...$, session: { ...$.session, id: async () => id } });
  await Promise.all([
    appendEvent(journalHostFor(runtime('session-a')), { surface: 'bash', action: 'evaluated', ruleId: 'guarded-path-read', commandClass: 'bash' }),
    appendEvent(journalHostFor(runtime('session-b')), { surface: 'read', action: 'evaluated', ruleId: 'guarded-path-read', commandClass: 'read' }),
  ]);
  const paths = [...journalSnapshot().keys()].filter((path) => /session-[ab]\.ndjson$/.test(path));
  assert.equal(paths.length, 2);
  assert(paths.every((path) => journalSnapshot().get(path).trim().split('\n').length === 1));
});
await test('journal deduplicates correlated hits and a write failure stays fail-open', async () => {
  const journalPath = `/tmp/home/.local/state/wt-secret-guard/journal/${sessionId}.ndjson`;
  const before = journalSnapshot().get(journalPath)?.split('\n').length ?? 0;
  const fields = { surface: 'bash', action: 'would-block', ruleId: 'guarded-path-read', commandClass: 'bash', dedupeKey: 'same-hit' };
  assert.equal(await appendEvent(journalHostFor($), fields), true);
  assert.equal(await appendEvent(journalHostFor($), fields), false);
  const after = journalSnapshot().get(journalPath).split('\n').length;
  assert.equal(after, before + 1);
  const failing = { ...$, process: { run: async () => { throw new Error('fixture write failure'); } } };
  assert.equal(await appendEvent(journalHostFor(failing), { surface: 'read', action: 'evaluated', ruleId: 'guarded-path-read', commandClass: 'read' }), false);
});
await test('disposition ledger and aggregates make promotion queries measurable', async () => {
  await recordDisposition(journalHostFor($), { toolUseId: 'tool-safe' }, 'true-positive');
  const events = [
    { action: 'evaluated', project: 'one', at: '2026-08-01T00:00:00.000Z' },
    { action: 'would-block', project: 'one', at: '2026-08-01T00:00:00.000Z' },
  ];
  const dispositions = [{ disposition: 'true-positive' }];
  assert.deepEqual(deriveAggregates(events, dispositions), { evaluations: 1, hits: 1, reviewed: 1, falsePositives: 0, projects: 1, falsePositiveRate: 0 });
  assert.equal(promotionStatus(events, dispositions, Date.parse('2026-09-22T00:00:00.000Z')).measurable, false);
  assert([...journalSnapshot().entries()].some(([path, text]) => path.includes('.dispositions.ndjson') && text.includes('true-positive')));
});
await test('mechanical journal scan contains no fixture values, paths, commands, argument keys, or tool names', async () => {
  const journal = [...journalSnapshot().values()].join('\n');
  for (const forbidden of ['fixture-secret-value', '/tmp/.env', 'cat ~/.npmrc', 'file_path', 'notebook_path', 'Bash', 'Read', 'NotebookRead']) assert.equal(journal.includes(forbidden), false, forbidden);
});
await test('journal rejects open enums and invalid dispositions and supports HOME fallback', async () => {
  await assert.rejects(buildEvent(journalHostFor($), { surface: 'raw-tool-name', action: 'evaluated' }), /invalid journal event/);
  await assert.rejects(recordDisposition(journalHostFor($), {}, 'maybe'), /invalid disposition/);
  const homeOnly = { ...$, env: { get: async (name) => name === 'HOME' ? '/tmp/home' : undefined }, session: { ...$.session, id: async () => 'home-session' } };
  assert.equal(await appendEvent(journalHostFor(homeOnly), { surface: 'bash', action: 'evaluated', kinds: ['github-classic', 4, 'NOT VALID'], count: 2, ruleId: 'guarded-path-read', commandClass: 'bash' }), true);
  assert([...journalSnapshot().keys()].some((path) => path === '/tmp/home/.local/state/wt-secret-guard/journal/home-session.ndjson'));
  assert.equal(deriveAggregates([{ action: 'evaluated', project: 'one' }]).falsePositiveRate, 0);
});
await test('promotion query requires duration, volume, projects, all governed tools and zero recent false positives', async () => {
  const started = '2026-08-01T00:00:00.000Z';
  const events = Array.from({ length: 200 }, (_, index) => ({ action: 'evaluated', surface: ['bash', 'read', 'notebook-read'][index % 3], project: ['one', 'two', 'three'][index % 3], at: started }));
  events.push({ action: 'would-block', surface: 'bash', project: 'one', at: started });
  const now = Date.parse('2026-09-22T00:00:00.000Z');
  const status = promotionStatus(events, [{ disposition: 'true-positive', at: '2026-09-01T00:00:00.000Z' }], now);
  assert.equal(status.measurable, true);
  assert.equal(status.allGovernedTools, true);
  assert.equal(promotionStatus(events, [{ disposition: 'false-positive', at: '2026-09-20T00:00:00.000Z' }], now).measurable, false);
});
await test('prompt planner covers CRLF, primitive JSON, malformed JSON and long-token masking', async () => {
  const text = `${JSON.stringify({ display: 'raw', count: 1, active: true })}\r\n`;
  const changes = locateReplacements(text, [{ raw: 'raw', token: 'secret:fixture#toolong' }], 'history');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].replacement, '***');
  assert.throws(() => locateReplacements('{"display":"unterminated}', [{ raw: 'x', token: 'y' }], 'history'), /unterminated/i);
  assert.throws(() => locateReplacements('{"display" "x"}', [], 'history'), /property name|invalid JSON object/);
});
await test('reference runtime handles host text objects, invalid text and empty resolver output', async () => {
  const objectRuntime = { ...$, fs: { ...$.fs, read: async () => ({ text: 'object-file-secret' }) } };
  assert.match((await rewriteReferences(referenceHostFor(objectRuntime), 'echo secret:file:/tmp/object')).command, /base64 --decode/);
  const invalidRuntime = { ...$, fs: { ...$.fs, read: async () => ({ bytes: true }) } };
  assert.equal((await rewriteReferences(referenceHostFor(invalidRuntime), 'echo secret:file:/tmp/object')).command, 'echo secret:file:/tmp/object');
  assert.equal((await rewriteReferences(referenceHostFor(objectRuntime), 'echo secret:file:/tmp/object#9')).command, 'echo secret:file:/tmp/object#9');
  const emptyResolver = { ...$, process: { run: async () => ({ exitCode: 7, stdout: '' }) } };
  // Its own item: a failed prefetch is remembered for the session (V19), so a shared reference would
  // make the next test's SUCCESS assertion read a cached failure instead of calling the resolver.
  assert.equal((await resolveReference(emptyResolver, 'op://vault/empty-resolver/field')).token, null);
});
await test('destructuring defaults named like credentials pass through tool results', async () => {
  const source = 'const { kind, value, secret = value } = result;';
  assert.equal((await call('git diff', source)).text, source);
});
await test('object literal assignment expressions named like credentials pass through tool results', async () => {
  const source = 'const options = { token: token = fallback };';
  assert.equal((await call('cat options.js', source)).text, source);
});
await test('function parameter defaults named like credentials pass through tool results', async () => {
  const source = 'function connect(password = fallback) { return password; }';
  assert.equal((await call('git diff', source)).text, source);
});
await test('short genuine credential assignments in command output remain scrubbed', async () => {
  const result = await call('print-config', 'password = hunter2');
  assert.equal(result.text.includes('hunter2'), false, 'genuine short password reached the tool result');
  assert.match(result.text, /secret:assignment#/);
});
await test('an assignment nested in shell quotes is scrubbed without consuming its closing quote', async () => {
  const value = 'synthetic-fixture-value-quote-lock';
  const input = `printf "%s" "password=${value}"`;
  const result = await call('print-command', input);
  assert.equal(result.text.includes(value), false);
  assert.match(result.text, /printf "%s" "secret:assignment#[a-f0-9]{6}"/);
});
await test('source-looking prefixes do not exempt a later credential assignment on the same line', async () => {
  const credentialValue = 'hunter2realcredential';
  const mixedLines = [
    `const harmless = true; secret=${credentialValue}`,
    `let harmless = true; secret=${credentialValue}`,
    `var harmless = true; secret=${credentialValue}`,
    `type Harmless = string; secret=${credentialValue}`,
    `interface Harmless {}; secret=${credentialValue}`,
    `function harmless() {}; secret=${credentialValue}`,
    `class Harmless {}; secret=${credentialValue}`,
    `import harmless from 'harmless'; secret=${credentialValue}`,
    `export const harmless = true; secret=${credentialValue}`,
    `default function harmless() {}; secret=${credentialValue}`,
    `+ const harmless = true; secret=${credentialValue}`,
    `log(harmless); (secret=${credentialValue})`,
    `log({ harmless: true }); { secret=${credentialValue} }`,
  ];
  for (const line of mixedLines) {
    const result = await call('git diff', line);
    assert.equal(result.text.includes(credentialValue), false, `credential survived mixed source line: ${line}`);
  }
});
const exportedCredentials = [
  ['NAME_SECRET', 'export-secret-value'],
  ['NAME_TOKEN', 'export-token-value'],
  ['NAME_KEY', 'export-key-value'],
];
const exportedCredentialLine = ([name, value], prefix = '') => `${prefix}export ${name}=${value}`;
await test('exported credential assignments are scrubbed from tool results', async () => {
  const output = exportedCredentials.map((credential) => exportedCredentialLine(credential)).join('\n');
  const result = await call('print-config', output);
  for (const [, value] of exportedCredentials) assert.equal(result.text.includes(value), false, `${value} reached the tool result`);
  assert.match(result.text, /secret:environment-dump#/);
});
await test('exported credential assignments are scrubbed from inbound messages', async () => {
  assert(receive, 'session.receive hook was not registered');
  const input = { origin: { kind: 'peer' }, text: exportedCredentials.map((credential) => exportedCredentialLine(credential)).join('\n') };
  const received = [];
  await receive($, input, async (event) => { received.push(event); return { queued: true }; });
  for (const [, value] of exportedCredentials) assert.equal(received[0].text.includes(value), false, `${value} reached the session`);
});
await test('indented and diff-prefixed exported credentials are scrubbed', async () => {
  const prefixes = ['  ', '+'];
  const output = prefixes.flatMap((prefix) => exportedCredentials.map((credential) => exportedCredentialLine(credential, prefix))).join('\n');
  const result = await call('git diff', output);
  for (const [, value] of exportedCredentials) assert.equal(result.text.includes(value), false, `${value} survived an indented or diff-prefixed export`);
});
await test('exported source declarations pass while an exported credential is scrubbed', async () => {
  const source = 'export const SECRET_KEY = x\nexport let API_TOKEN = y';
  const credentialValue = 'control-secret-value';
  const result = await call('git diff', `${source}\nexport NAME_SECRET=${credentialValue}`);
  assert.equal(result.text.includes(credentialValue), false, 'exported credential control did not match');
  assert.equal(result.text.includes(source), true, 'exported source declaration control matched');
});
await test('allow-list', async () => { const input = '0123456789abcdef0123456789abcdef01234567 123e4567-e89b-12d3-a456-426614174000 secret:github#abcdef'; const result = await call('cat fixture.txt', input); assert.equal(result.text, input); });
await test('UUID Exa API key in a provider client constructor is scrubbed', async () => { const result = await call('node app.mjs', `const client = new Exa("${exa}");`); assert.equal(result.text.includes(exa), false, 'Exa UUID API key reached the tool result'); assert.match(result.text, /secret:credential-uuid#/); });
await test('bare UUID in a plain log line stays untouched', async () => { const input = `run id ${exa} completed`; const result = await call('cat run.log', input); assert.equal(result.text, input); });
await test('Brave API key shape is scrubbed', async () => { const result = await call('env', `BRAVE_API_KEY=${brave}`); assert.equal(result.text.includes(brave), false, 'Brave API key reached the tool result'); assert.match(result.text, /secret:brave-api-key#/); });
await test('logs contain no secret value', async () => { for (const value of [github, aws, "file-secret value with ' quote", 'second-file-secret', 'read-result-secret', 'mcp-result-secret']) assert(logs.every((line) => !line.includes(value))); });
await test('detection table in the store carries tokens, kinds and salted hashes, never values', async () => { const publication = calls.filter((call) => call.capability === 'store.set' && call.key === 'detections').at(-1); assert(publication); const table = publication.value; const text = JSON.stringify(table); assert.equal(table.version, 1); assert(table.entries.length >= 2); assert(table.entries.every((entry) => entry.kind && /^secret:/.test(entry.token) && /^[a-f0-9]{64}$/.test(entry.sha256))); assert(!text.includes(github) && !text.includes(aws)); const saltWrite = calls.find((call) => call.capability === 'store.set' && call.key === 'salt'); assert(saltWrite); assert.equal(sha256(`${saltWrite.value}:${github}`), table.entries.find((entry) => entry.kind === 'github-classic').sha256); assert.notEqual(sha256(github), table.entries.find((entry) => entry.kind === 'github-classic').sha256); });
await test('persistent store never carries a value; tokens only under the detections key', async () => { const writes = calls.filter((call) => call.capability === 'store.set'); assert(writes.length >= 3); for (const value of [github, aws, "file-secret value with ' quote", 'second-file-secret', 'read-result-secret', 'mcp-result-secret']) assert(writes.every((call) => !JSON.stringify(call.value).includes(value))); assert(writes.filter((call) => call.key !== 'detections').every((call) => !JSON.stringify(call.value).includes('secret:'))); });
await test('op resolver runs the configured binary and logs a fixed counts-only line when it fails', async () => { const { configure } = await import('./hooks.js'); configure({ opBinary: 'op.exe' }); const before = calls.length; await bash($, { tool: 'Bash', command: 'echo op://Private/item/pw2' }, async () => ({ text: 'x' })); const run = calls.slice(before).find((call) => call.capability === 'process.run' && call.argv[0] === 'op.exe'); assert(run); const failing = { ...$, process: { run: async () => { const e = new Error('spawn op ENOENT'); e.code = 'ENOENT'; throw e; } } }; const r = await resolveReference(failing, 'op://v/i/f'); assert.equal(r.token, null); assert(logs.some((line) => line === 'wt-secret-guard: op resolve failed to start (1 reference)')); assert(logs.every((line) => !line.includes('op-fake-value'))); configure({}); });
await test('op resolver returns a token, never its value', async () => { const result = await resolveReference($, 'op://vault/item/field'); assert.match(result.token, /^secret:onepassword#/); assert(!JSON.stringify(result).includes('op-fake-value')); assert.equal(testState().get(result.token).value, 'op-fake-value'); });
await test('a scrubbed prompt carries the redaction note as context and keeps its text free of the note', async () => {
  const value = 'pass' + 'word=' + 'Zq81' + 'wLx9' + 'Pm42';
  let received;
  await prompt($, { text: `login with ${value}`, source: 'user' }, async (event) => { received = event; return {}; });
  assert(!received.text.includes(value));
  assert(!received.text.includes('REDACTION TOKEN'));
  assert.deepEqual(received.context, [(await import('./hooks.js')).REDACTION_NOTE]);
});
await test('a scrubbed tool result explains its tokens; an untouched one gets no note', async () => {
  const value = 'tok' + 'en=' + 'Hy72' + 'kQp1' + 'Vn38';
  const scrubbed = await call('x', `out ${value}`);
  assert.match(scrubbed.text, /REDACTION TOKEN/);
  const clean = await call('x', 'nothing sensitive here');
  assert.doesNotMatch(clean.text, /REDACTION TOKEN/);
});
await test('plain prompt reaches next exactly once and preserves its outcome', async () => {
  const input = { text: 'continue', source: 'user' };
  const outcome = { context: ['downstream context'] };
  const received = [];
  const result = await prompt($, input, async (event) => { received.push(event); return outcome; });
  assert.deepEqual(received, [input]);
  assert.equal(result, outcome);
});
await test('prompt secrets are scrubbed before forwarding and downstream drops survive', async () => {
  const input = { text: `paste ${github}`, source: 'user' };
  const outcome = { drop: 'downstream policy' };
  const received = [];
  const result = await prompt($, input, async (event) => { received.push(event); return outcome; });
  assert.equal(received.length, 1);
  assert(!JSON.stringify(received[0]).includes(github));
  assert.match(received[0].text, /secret:github-classic#/);
  assert.equal(received[0].source, 'user');
  assert.equal(input.text, `paste ${github}`);
  assert.equal(result, outcome);
});
await test('email masking is off by default in prompts and tool results', async () => {
  configure({});
  const email = 'alice@internal.test';
  let received;
  await prompt($, { text: `contact ${email}` }, async (event) => { received = event; return {}; });
  const result = await read($, { tool: 'Read' }, async () => ({ text: `owner ${email}` }));
  assert(received.text.includes(email));
  assert(result.text.includes(email));
});
await test('email masking option covers prompts and tool results', async () => {
  configure({ maskEmails: true });
  const email = 'bob@internal.test';
  let received;
  await prompt($, { text: `contact ${email}` }, async (event) => { received = event; return {}; });
  const result = await read($, { tool: 'Read' }, async () => ({ text: `owner ${email}` }));
  assert(!received.text.includes(email));
  assert.match(received.text, /secret:email#/);
  assert(!result.text.includes(email));
  assert.match(result.text, /secret:email#/);
  configure({});
  let unmasked;
  await prompt($, { text: `contact ${email}` }, async (event) => { unmasked = event; return {}; });
  assert(unmasked.text.includes(email));
});
await test('IP masking is off by default in prompts and tool results', async () => {
  configure({});
  const ip = '8.8.4.4';
  const ipv6 = '2001:4860:4860::8888';
  let received;
  await prompt($, { text: `connect to ${ip}` }, async (event) => { received = event; return {}; });
  const result = await read($, { tool: 'Read' }, async () => ({ text: `peers ${ip} and ${ipv6}` }));
  assert(received.text.includes(ip));
  assert(result.text.includes(ip));
  assert(result.text.includes(ipv6));
});
await test('IP masking option covers prompts and tool results', async () => {
  configure({ maskIpAddresses: true });
  const ip = '8.8.4.4';
  const ipv6 = '2001:4860:4860::8888';
  let received;
  await prompt($, { text: `connect to ${ip}` }, async (event) => { received = event; return {}; });
  const result = await read($, { tool: 'Read' }, async () => ({ text: `peers ${ip} and ${ipv6}` }));
  assert(!received.text.includes(ip));
  assert.match(received.text, /secret:ip-address#/);
  assert(!result.text.includes(ip));
  assert(!result.text.includes(ipv6));
  assert.match(result.text, /secret:ip-address#/);
  configure({});
  let unmasked;
  await prompt($, { text: `connect to ${ip}` }, async (event) => { unmasked = event; return {}; });
  assert(unmasked.text.includes(ip));
});
await test('prompt storage rewrites history display and nested pasted contents without changing unrelated lines or mode', async () => {
  const raw = `ghp_${'h'.repeat(36)}`;
  const unrelated = '{"display":"leave this byte-for-byte","pastedContents":{},"timestamp":1}';
  setFile(historyPath, `${unrelated}\n${JSON.stringify({ display: `paste ${raw}`, pastedContents: { one: raw, nested: [raw] }, timestamp: 2 })}\n`);
  const original = { ...getFile(historyPath) };
  let received;
  await prompt($, { text: `paste ${raw}`, origin: { kind: 'composer' }, wait: false }, async (event) => { received = event; return {}; });
  const stored = getFile(historyPath);
  const lines = stored.text.trimEnd().split('\n');
  assert.equal(lines[0], unrelated);
  assert.equal(stored.text.includes(raw), false);
  assert.equal(stored.mode, 0o600);
  assert.equal(stored.inode, original.inode);
  assert.equal(Buffer.byteLength(stored.text), Buffer.byteLength(original.text));
  const token = received.text.match(/secret:github-classic#[a-f0-9]+/)[0];
  assert.equal((stored.text.match(new RegExp(token, 'g')) ?? []).length, 3);
  const masked = original.text.split(raw).join(token.padEnd(raw.length, '*'));
  assert.equal(stored.text, masked);
});
await test('concurrent history appends survive every in-place overwrite byte-identical', async () => {
  const raw = `ghp_${'c'.repeat(36)}`;
  const original = `${JSON.stringify({ display: raw, pastedContents: { again: raw } })}\n`;
  const appended = '{"display":"concurrent one","timestamp":11}\n{"display":"concurrent two","timestamp":12}\n';
  setFile(historyPath, original);
  onBeforeWrite = async (path) => { getFile(path).text += appended; onBeforeWrite = undefined; };
  await prompt($, { text: raw, origin: { kind: 'composer' }, wait: false }, async () => ({}));
  const stored = getFile(historyPath).text;
  assert.equal(stored.endsWith(appended), true);
  assert.equal(stored.includes(raw), false);
  assert.equal(Buffer.byteLength(stored), Buffer.byteLength(original) + Buffer.byteLength(appended));
});
await test('prompt storage locates the JSON-escaped secret and leaves valid same-length JSON', async () => {
  const raw = '-----BEGIN PRIVATE KEY-----\nline-one\nline-two\n-----END PRIVATE KEY-----';
  const original = `${JSON.stringify({ display: raw, pastedContents: {} })}\n`;
  setFile(historyPath, original);
  await prompt($, { text: raw, origin: { kind: 'composer' }, wait: false }, async () => ({}));
  const stored = getFile(historyPath).text;
  assert.equal(Buffer.byteLength(stored), Buffer.byteLength(original));
  assert.equal(stored.includes(JSON.stringify(raw).slice(1, -1)), false);
  assert.doesNotThrow(() => JSON.parse(stored.trimEnd()));
});
await test('not-found prompt storage warns exactly once without revealing the secret', async () => {
  const raw = `ghp_${'n'.repeat(36)}`;
  files.delete(historyPath);
  files.delete(transcriptPath);
  const beforeLogs = logs.length;
  await prompt($, { text: raw, origin: { kind: 'sdk' }, wait: false }, async () => ({}));
  await prompt($, { text: raw, origin: { kind: 'sdk' }, wait: false }, async () => ({}));
  const notices = logs.slice(beforeLogs).filter((line) => line.includes('prompt storage'));
  assert.equal(notices.length, 1);
  assert.equal(notices.some((line) => line.includes(raw)), false);
});
await test('malformed prompt history is left untouched and does not repeat the storage notice', async () => {
  const raw = `ghp_${'m'.repeat(36)}`;
  const original = `${JSON.stringify({ display: raw, pastedContents: {} })}\nnot-json\n`;
  setFile(historyPath, original);
  const beforeLogs = logs.length;
  await prompt($, { text: raw, origin: { kind: 'composer' }, wait: false }, async () => ({}));
  assert.equal(getFile(historyPath).text, original);
  const notices = logs.slice(beforeLogs).filter((line) => line.includes('prompt storage'));
  assert.equal(notices.length, 0);
});
await test('compare-then-write mismatch writes nothing and keeps one secret-free notice', async () => {
  const raw = `ghp_${'x'.repeat(36)}`;
  const changed = `ghp_${'y'.repeat(36)}`;
  setFile(historyPath, `${JSON.stringify({ display: raw, pastedContents: {} })}\n`);
  const writesBefore = calls.filter((call) => call.capability === 'process.run' && call.argv.some((part) => String(part).startsWith('of='))).length;
  onBeforeCompare = async (path) => { getFile(path).text = getFile(path).text.replace(raw, changed); onBeforeCompare = undefined; };
  await prompt($, { text: raw, origin: { kind: 'composer' }, wait: false }, async () => ({}));
  const writesAfter = calls.filter((call) => call.capability === 'process.run' && call.argv.some((part) => String(part).startsWith('of='))).length;
  assert.equal(writesAfter, writesBefore);
  assert.equal(getFile(historyPath).text.includes(changed), true);
  const notices = logs.filter((line) => line.includes('prompt storage'));
  assert.equal(notices.length, 1);
  assert.equal(notices.some((line) => line.includes(raw) || line.includes(changed)), false);
});
await test('history rewrite retries inside a bounded clock window when the record is initially absent', async () => {
  const raw = `ghp_${'r'.repeat(36)}`;
  files.delete(historyPath);
  let sleeps = 0;
  onSleep = async () => { sleeps += 1; setFile(historyPath, `${JSON.stringify({ display: raw, pastedContents: {} })}\n`); onSleep = undefined; };
  await prompt($, { text: raw, origin: { kind: 'composer' }, wait: false }, async () => ({}));
  assert.equal(sleeps, 1);
  assert.equal(getFile(historyPath).text.includes(raw), false);
});
await test('prompt storage falls back from CLAUDE_CONFIG_DIR to HOME dot-claude', async () => {
  const raw = `ghp_${'d'.repeat(36)}`;
  const defaultHistory = '/tmp/home/.claude/history.jsonl';
  setFile(defaultHistory, `${JSON.stringify({ display: raw, pastedContents: {} })}\n`);
  const homeOnly = { ...$, env: { get: async (name) => name === 'HOME' ? '/tmp/home' : undefined } };
  await prompt(homeOnly, { text: raw, origin: { kind: 'composer' }, wait: false }, async () => ({}));
  assert.equal(getFile(defaultHistory).text.includes(raw), false);
});
await test('sdk prompt storage rewrites an enqueue record written after prompt forwarding', async () => {
  const raw = `ghp_${'q'.repeat(36)}`;
  const unrelated = '{"type":"system","content":"unchanged","uuid":"one"}';
  files.delete(historyPath);
  files.delete(transcriptPath);
  let original;
  await prompt($, { text: `use ${raw}`, origin: { kind: 'sdk' }, wait: false }, async () => {
    setFile(transcriptPath, `${unrelated}\n${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `use ${raw}`, uuid: 'two' })}\n`);
    original = { ...getFile(transcriptPath) };
    return {};
  });
  const stored = getFile(transcriptPath);
  assert.equal(stored.text.trimEnd().split('\n')[0], unrelated);
  assert.equal(stored.text.includes(raw), false);
  assert.equal(stored.mode, 0o600);
  assert.equal(stored.inode, original.inode);
  assert.equal(Buffer.byteLength(stored.text), Buffer.byteLength(original.text));
  assert.match(stored.text, /secret:github-classic#/);
});
await test('queue-operation targeting is independent of prompt origin and retries a late enqueue', async () => {
  const raw = `ghp_${'z'.repeat(36)}`;
  files.delete(historyPath);
  setFile(transcriptPath, `${JSON.stringify({ type: 'queue-operation', operation: 'dequeue', content: '' })}\n`);
  let sleeps = 0;
  onSleep = async () => {
    sleeps += 1;
    if (sleeps === 2) {
      getFile(transcriptPath).text += `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `use ${raw}` })}\n`;
      onSleep = undefined;
    }
  };
  await prompt($, { text: `use ${raw}`, origin: { kind: 'bridge' }, wait: false }, async () => ({}));
  assert.equal(sleeps, 2);
  assert.equal(getFile(transcriptPath).text.includes(raw), false);
  assert.match(getFile(transcriptPath).text, /secret:github-classic#/);
});
// Arbiter lock (2026-09-21): the narrowing is per STATEMENT, not per line. A declaration that follows a
// semicolon is still source code and stays exempt — the first version of the fix detected it, which
// makes the guard rewrite ordinary multi-statement lines (measured on the repo corpus: two such lines in
// a test file). The value is built by concatenation so this file carries no literal credential.
await test('a declaration after a semicolon stays exempt; a bare assignment after one is caught', async () => {
  const value = 'hunter2' + 'realcredential9Xq';
  const declaration = `const dir = '/tmp'; const token = '${value}'`;
  const kept = await call('git diff', declaration);
  assert.equal(kept.text, declaration, 'a declaration statement after a semicolon was rewritten');
  const attack = `const harmless = true; token = '${value}'`;
  const scrubbed = await call('git diff', attack);
  assert.equal(scrubbed.text.includes(value), false, 'a bare assignment after a semicolon survived');
});
await test('raw outbound values are refused on every governed tool without calling next', async () => {
  const raw = `ghp_${'o'.repeat(36)}`;
  const cases = [
    ['Bash', { command: `printf %s ${raw}` }],
    ['Write', { file_path: '/tmp/outbound.txt', content: raw }],
    ['Edit', { file_path: '/tmp/outbound.txt', old_string: 'old', new_string: raw }],
    ['NotebookEdit', { notebook_path: '/tmp/outbound.ipynb', new_source: raw }],
    ['mcp', { tool: 'mcp__fixture__send', payload: { api_key: raw } }],
  ];
  for (const [name, fields] of cases) {
    const hook = name === 'mcp' ? mcp : hookForTool(name);
    assert(hook, `${name} outbound guard was not registered`);
    let called = false;
    const result = await hook($, { tool: name, tool_use_id: `outbound-${name}`, ...fields }, async () => { called = true; return { text: 'sent' }; });
    assert.equal(called, false, `${name} reached next`);
    assert.match(result.deny, /refused/i);
    assert.equal(result.deny.includes(raw), false);
  }
});
await test('field-aware outbound classification catches credential UUIDs but not bare run ids', async () => {
  const rawUuid = '123e4567-e89b-12d3-a456-426614174111';
  let callsToNext = 0;
  const denied = await mcp($, { tool: 'mcp__fixture__send', tool_use_id: 'uuid-key', payload: { api_key: rawUuid } }, async () => { callsToNext += 1; return {}; });
  assert.match(denied.deny, /refused/i);
  const clean = { tool: 'mcp__fixture__send', tool_use_id: 'uuid-run', payload: { run_id: '123e4567-e89b-12d3-a456-426614174222' } };
  await mcp($, clean, async (event) => { callsToNext += 1; assert.deepEqual(event, clean); return { text: 'ok' }; });
  assert.equal(callsToNext, 1);
});
await test('outbound fixture canonicalization and unsupported-tool branches fail closed', async () => {
  const raw = `ghp_${'k'.repeat(36)}`;
  const event = { tool: 'Write', file_path: 'C:\\plugin\\hooks\\fixtures\\case.txt', content: raw };
  assert.deepEqual(await classifyOutbound({ pluginRoot: async () => undefined, fsStat: async () => ({}) }, event), { surface: 'write', findings: [{ kind: 'github-classic', value: raw }] });
  assert((await classifyOutbound({ pluginRoot: async () => 'C:\\plugin', fsStat: async () => { throw new Error('unresolved'); } }, event)).findings.length > 0);
  for (const key of ['resolvedPath', 'realPath', 'path']) {
    const host = { pluginRoot: async () => 'C:\\plugin', fsStat: async (path) => ({ [key]: path }) };
    assert((await classifyOutbound(host, event)).findings.length > 0, key);
  }
  const fallback = { pluginRoot: async () => 'C:\\plugin\\', fsStat: async () => ({}) };
  assert((await classifyOutbound(fallback, event)).findings.length > 0);
  assert.deepEqual(await classifyOutbound(fallback, { tool: 'Read', file_path: '/tmp/x' }), { surface: null, findings: [] });
  assert.deepEqual(await classifyOutbound(fallback, {}), { surface: null, findings: [] });
});
await test('reference-shaped outbound values and clean controls pass byte-identically', async () => {
  const cases = [
    ['Bash', { tool: 'Bash', command: 'export GH_TOKEN=op://Private/item/token' }],
    ['Write', { tool: 'Write', file_path: '/tmp/ref.txt', content: 'secret:env:GH_TOKEN' }],
    ['Edit', { tool: 'Edit', file_path: '/tmp/ref.txt', old_string: 'old', new_string: '${GH_TOKEN}' }],
    ['NotebookEdit', { tool: 'NotebookEdit', notebook_path: '/tmp/ref.ipynb', new_source: 'clean text' }],
  ];
  for (const [name, event] of cases) {
    const hook = hookForTool(name);
    assert(hook, `${name} outbound guard was not registered`);
    let received;
    await hook($, event, async (forwarded) => { received = forwarded; return { text: 'ok' }; });
    if (name !== 'Bash') assert.deepEqual(received, event);
  }
});
await test('R1 reference spans do not exempt adjacent raw assignments', async () => {
  for (const content of ['token: hunter2 ${_}', 'export DB_SECRET=hunter2 ${HOME}']) {
    const result = await classifyOutbound({}, { tool: 'Write', file_path: '/tmp/out', content });
    assert(result.findings.some((finding) => finding.value.includes('hunter2')), `raw assignment survived beside reference: ${content}`);
  }
});
await test('D8 fixture paths receive no outbound allowance', async () => {
  const raw = `ghp_${'f'.repeat(36)}`;
  const fixture = '/opt/wt-secret-guard/hooks/fixtures/outbound.txt';
  const runtime = {
    ...$,
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: configDir, HOME: '/tmp/home', CLAUDE_PLUGIN_ROOT: '/opt/wt-secret-guard' })[name] },
    fs: { ...$.fs, stat: async (path) => ({ kind: 'file', resolvedPath: path }) },
  };
  const result = await hookForTool('Write')(runtime, { tool: 'Write', file_path: fixture, content: raw }, async () => ({}));
  assert.match(result.deny, /refused/i);
});
await test('D10 Edit old_string can remove a leaked secret', async () => {
  const raw = `ghp_${'e'.repeat(36)}`;
  let received;
  await hookForTool('Edit')($, { tool: 'Edit', file_path: '/tmp/out', old_string: raw, new_string: '' }, async (event) => { received = event; return { text: 'ok' }; });
  assert.equal(received.old_string, raw);
});
await test('R2 network and delegated prompts are guarded while search results are scrubbed', async () => {
  const raw = `ghp_${'g'.repeat(36)}`;
  for (const [tool, field] of [['WebFetch', 'url'], ['WebFetch', 'prompt'], ['WebSearch', 'query'], ['Agent', 'prompt'], ['Task', 'prompt']]) {
    const hook = hookForTool(tool);
    assert(hook, `${tool} outbound guard was not registered`);
    const result = await hook($, { tool, [field]: raw }, async () => ({ text: 'sent' }));
    assert.match(result.deny, /refused/i);
  }
  for (const tool of ['Grep', 'Glob']) {
    const hook = hookForTool(tool);
    assert(hook, `${tool} result scrubber was not registered`);
    const result = await hook($, { tool, pattern: 'clean' }, async () => ({ text: raw }));
    assert.equal(result.text.includes(raw), false);
  }
});
await test('D2 known vault values and their base64 forms are refused outbound', async () => {
  const raw = 'short-13-pass';
  tokenize('fixture', raw);
  for (const value of [raw, Buffer.from(raw).toString('base64')]) {
    const result = await mcp($, { tool: 'mcp__fixture__send', text: value }, async () => ({ text: 'sent' }));
    assert.match(result.deny, /refused/i);
  }
});
await test('V1 known vault values remain refused inside reference-looking wrappers', async () => {
  const raw = 'wrapped-vault-value';
  const encoded = Buffer.from(raw).toString('base64');
  tokenize('fixture', raw);
  for (const content of [`op://vault/${raw}/field`, `secret:file:/tmp/${encoded}`]) {
    const result = await classifyOutbound({}, { tool: 'Write', file_path: '/tmp/out', content });
    assert(result.findings.some((finding) => finding.secret === raw), `wrapped vault value was allowed: ${content}`);
  }
});
await test('V2 reference-adjacent refusal repairs the original raw transcript span', async () => {
  const raw = 'token: hunter2 ${_}';
  const toolUseId = 'tool-reference-adjacent';
  setFile(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { content: raw } }] } })}\n`);
  const result = await hookForTool('Write')($, { tool: 'Write', tool_use_id: toolUseId, file_path: '/tmp/out', content: raw }, async () => ({}));
  assert.match(result.deny, /refused/i);
  assert.equal(getFile(transcriptPath).text.includes(raw), false, 'original reference-adjacent raw span survived transcript repair');
});
await test('D11 refusal guidance is surface specific', async () => {
  const raw = `ghp_${'j'.repeat(36)}`;
  const writeResult = await hookForTool('Write')($, { tool: 'Write', file_path: '/tmp/out', content: raw }, async () => ({}));
  assert.doesNotMatch(writeResult.deny, /secret:env:|secret:file:|environment reference/i);
  const bashResult = await bash($, { tool: 'Bash', command: `echo ${raw}` }, async () => ({}));
  assert.match(bashResult.deny, /reference/i);
});
await test('denied tool input is repaired in place in the transcript by tool_use_id', async () => {
  const raw = `ghp_${'t'.repeat(36)}`;
  const toolUseId = 'tool-denied-transcript';
  const original = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: `echo ${raw}` } }] } })}\n`;
  setFile(transcriptPath, original);
  let called = false;
  const result = await bash($, { tool: 'Bash', tool_use_id: toolUseId, command: `echo ${raw}` }, async () => { called = true; return {}; });
  const stored = getFile(transcriptPath);
  assert.equal(called, false);
  assert.match(result.deny, /refused/i);
  assert.equal(stored.text.includes(raw), false);
  assert.match(stored.text, /secret:github-classic#/);
  assert.equal(Buffer.byteLength(stored.text), Buffer.byteLength(original));
});
await test('D3 nested password findings carry the raw leaf into transcript repair', async () => {
  const raw = 'hunter2';
  const toolUseId = 'tool-nested-password';
  setFile(transcriptPath, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__fixture__send', input: { nested: { password: raw } } }] } })}\n`);
  const result = await mcp($, { tool: 'mcp__fixture__send', tool_use_id: toolUseId, nested: { password: raw } }, async () => ({}));
  assert.match(result.deny, /refused/i);
  assert.equal(getFile(transcriptPath).text.includes(raw), false, 'nested password remained in persisted tool input');
});
await test('R3 transcript repair reads only a bounded tail above 4 MiB', async () => {
  const raw = `ghp_${'l'.repeat(36)}`;
  const toolUseId = 'tool-large-transcript';
  const prefix = `${JSON.stringify({ type: 'result', content: 'x'.repeat(4 * 1024 * 1024) })}\n`;
  setFile(transcriptPath, `${prefix}${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`);
  await bash($, { tool: 'Bash', tool_use_id: toolUseId, command: raw }, async () => ({}));
  assert.equal(getFile(transcriptPath).text.includes(raw), false, 'large transcript was not repaired');
});
await test('R3 a partial trailing transcript line retries after completion', async () => {
  const raw = `ghp_${'p'.repeat(36)}`;
  const toolUseId = 'tool-partial-transcript';
  const complete = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`;
  setFile(transcriptPath, complete.slice(0, -8));
  let sleeps = 0;
  onSleep = async () => { sleeps += 1; getFile(transcriptPath).text = complete; onSleep = undefined; };
  await bash($, { tool: 'Bash', tool_use_id: toolUseId, command: raw }, async () => ({}));
  assert.equal(sleeps, 1);
  assert.equal(getFile(transcriptPath).text.includes(raw), false);
});
await test('R3 replacement between compare and write fails closed on file identity', async () => {
  const raw = `ghp_${'y'.repeat(36)}`;
  const toolUseId = 'tool-file-replaced';
  const original = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`;
  setFile(transcriptPath, original);
  onBeforeWrite = async (path) => { setFile(path, original); onBeforeWrite = undefined; };
  await bash($, { tool: 'Bash', tool_use_id: toolUseId, command: raw }, async () => ({}));
  assert.equal(getFile(transcriptPath).text, original, 'replacement file was overwritten');
});
await test('V3 no-inode replacement fails closed on size and prefix identity', async () => {
  const raw = `ghp_${'n'.repeat(36)}`;
  const toolUseId = 'tool-no-inode-original';
  const replacementId = 'tool-no-inode-otherxxx';
  const original = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`;
  const replacement = original.replace(toolUseId, replacementId);
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  assert.equal(Buffer.from(replacement).subarray(0, 64).equals(Buffer.from(original).subarray(0, 64)), true);
  setFile(transcriptPath, original);
  const runtime = { ...$, fs: { ...$.fs, stat: async (path) => { const value = await $.fs.stat(path); const { ino: _ino, ...withoutInode } = value; return withoutInode; } } };
  onBeforeWrite = async (path) => { const inode = getFile(path).inode; files.set(path, { text: replacement, mode: 0o600, inode }); onBeforeWrite = undefined; };
  await bash(runtime, { tool: 'Bash', tool_use_id: toolUseId, command: raw }, async () => ({}));
  assert.equal(getFile(transcriptPath).text, replacement, 'no-inode helper overwrote a different record');
});
await test('V3 Windows helper also refuses a same-prefix record with another tool_use id', async () => {
  const raw = `ghp_${'m'.repeat(36)}`;
  const toolUseId = 'tool-windows-original';
  const replacementId = 'tool-windows-otherxxx';
  const original = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`;
  const replacement = original.replace(toolUseId, replacementId);
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  assert.equal(Buffer.from(replacement).subarray(0, 64).equals(Buffer.from(original).subarray(0, 64)), true);
  setFile(transcriptPath, original);
  const windows = { ...$, env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: configDir, HOME: '/tmp/home', OS: 'Windows_NT' })[name] } };
  onBeforeWindowsWrite = async (path) => { const inode = getFile(path).inode; files.set(path, { text: replacement, mode: 0o600, inode }); onBeforeWindowsWrite = undefined; };
  await bash(windows, { tool: 'Bash', tool_use_id: toolUseId, command: raw }, async () => ({}));
  assert.equal(getFile(transcriptPath).text, replacement, 'Windows helper overwrote a different record');
});
await test('V7 bounded UTF-8 tails repair at every byte alignment', async () => {
  const raw = `ghp_${'u'.repeat(36)}`;
  for (let alignment = 0; alignment < 3; alignment += 1) {
    const toolUseId = `tool-utf8-${alignment}`;
    const record = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`;
    const discardedLength = 4 * 1024 * 1024 + alignment - Buffer.byteLength('€') - Buffer.byteLength(record);
    const prefix = `${'x'.repeat(10)}€${'y'.repeat(discardedLength - 1)}\n`;
    setFile(transcriptPath, `${prefix}${record}`);
    await bash($, { tool: 'Bash', tool_use_id: toolUseId, command: raw }, async () => ({}));
    assert.equal(getFile(transcriptPath).text.includes(raw), false, `UTF-8 tail alignment ${alignment} kept the raw value`);
  }
});
await test('D13 subagent denial names the unmeasured storage gap without touching the main transcript', async () => {
  const raw = `ghp_${'d'.repeat(36)}`;
  const toolUseId = 'tool-subagent';
  const original = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: toolUseId, input: { command: raw } }] } })}\n`;
  setFile(transcriptPath, original);
  const beforeLogs = logs.length;
  await bash($, { tool: 'Bash', tool_use_id: toolUseId, agentId: 'agent-fixture', command: raw }, async () => ({}));
  assert.equal(getFile(transcriptPath).text, original);
  assert(logs.slice(beforeLogs).some((line) => /subagent.*location.*unmeasured/i.test(line)));
});
async function collectStream(hook, chunks, result = {}) {
  const seen = [];
  const iterator = hook($, {}, async function* () { for (const chunk of chunks) yield chunk; return result; })[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { chunks: seen, result: step.value };
    seen.push(step.value);
  }
}
await test('assistant stream masks every character-boundary split and scrubs the final answer', async () => {
  assert(turnStep, 'turn.step assistant guard was not registered');
  const raw = `ghp_${'s'.repeat(36)}`;
  for (let split = 1; split < raw.length; split += 1) {
    const streamed = await collectStream(turnStep, [
      { kind: 'text', index: 0, text: raw.slice(0, split) },
      { kind: 'text', index: 0, text: raw.slice(split) },
      { kind: 'engine' },
      { kind: 'stop' },
    ], { answer: raw });
    const text = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
    assert.equal(text.includes(raw), false, `split ${split}`);
    assert.match(text, /secret:github-classic#/);
    assert.match(text, /REDACTION TOKEN/);
    assert.equal(JSON.stringify(streamed.result).includes(raw), false);
  }
});
await test('assistant stream finally flushes held text while signed thinking remains untouched', async () => {
  assert(turnStep, 'turn.step assistant guard was not registered');
  const raw = `ghp_${'v'.repeat(36)}`;
  const seen = [];
  const iterator = turnStep($, {}, () => ({
    [Symbol.asyncIterator]() { return (async function* () { yield { kind: 'text', index: 0, text: raw }; yield { kind: 'thinking', index: 1, text: raw }; throw new Error('fixture stream failure'); })(); },
  }))[Symbol.asyncIterator]();
  await assert.rejects(async () => { for (;;) { const step = await iterator.next(); if (step.done) break; seen.push(step.value); } }, /fixture stream failure/);
  const visible = seen.filter((chunk) => chunk.kind === 'text').map((chunk) => chunk.text).join('');
  assert.equal(visible.includes(raw), false);
  assert(seen.some((chunk) => chunk.kind === 'thinking' && chunk.text === raw), 'signed thinking must pass through unchanged');
});
await test('D1 turn.step leaves tool input chunks byte-identical for tool.call refusal', async () => {
  assert(turnStep, 'turn.step assistant guard was not registered');
  const raw = `ghp_${'i'.repeat(36)}`;
  const json = JSON.stringify({ command: `echo ${raw}` });
  const streamed = await collectStream(turnStep, [
    { kind: 'tool', index: 2, id: 'stream-tool', name: 'Bash' },
    { kind: 'input', index: 2, json: json.slice(0, 17) },
    { kind: 'input', index: 2, json: json.slice(17) },
    { kind: 'engine' },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.filter((chunk) => chunk.kind === 'input').map((chunk) => chunk.json).join('');
  assert.equal(output, json);
});
await test('assistant stream remains bounded for long clean, detected, and unterminated private-key blocks', async () => {
  const raw = `ghp_${'b'.repeat(36)}`;
  // Filler characters are deliberately outside every fixture value: a run of a character that a
  // registered secret also repeats is, by the invariant, a run of that secret.
  const clean = await collectStream(turnStep, [{ kind: 'text', index: 0, text: 'Ω'.repeat(5000) }, { kind: 'stop' }]);
  assert.equal(clean.chunks.map((chunk) => chunk.text ?? '').join('').replace(/\n/g, '').length, 5000);
  const detected = await collectStream(turnStep, [{ kind: 'text', index: 0, text: `${'Ω'.repeat(4500)}\n${raw}` }, { kind: 'stop' }]);
  assert.equal(detected.chunks.some((chunk) => chunk.text?.includes(raw)), false);
  const oversized = await collectStream(turnStep, [{ kind: 'text', index: 0, text: `${'-----BEGIN PRIVATE KEY-----'}${'Ω'.repeat(66000)}` }, { kind: 'stop' }]);
  assert.match(oversized.chunks.map((chunk) => chunk.text ?? '').join(''), /oversized secret-bearing stream block masked/);
  const answerOnly = await collectStream(turnStep, [], { answer: raw });
  assert.equal(JSON.stringify(answerOnly.result).includes(raw), false);
});
await test('R5 assistant stream masks a long opaque known value split across flush boundaries', async () => {
  const raw = `opaque-${'q'.repeat(6000)}`;
  tokenize('fixture', raw);
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `prefix ${raw.slice(0, 4500)}` },
    { kind: 'text', index: 0, text: raw.slice(4500) },
    { kind: 'stop' },
  ]);
  assert.equal(streamed.chunks.map((chunk) => chunk.text ?? '').join('').includes(raw), false, 'long registered secret crossed a stream flush');
});
await test('V6 detected-prefix flush retains every byte of an incomplete known value', async () => {
  const raw = `opaque-${'z'.repeat(6000)}`;
  tokenize('fixture', raw);
  const detector = `ghp_${'h'.repeat(36)}`;
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 1, text: `${detector}${'w'.repeat(13000)}` },
    { kind: 'engine' },
    { kind: 'text', index: 0, text: `${detector}${'x'.repeat(10000)}${raw.slice(0, 3000)}` },
    { kind: 'text', index: 0, text: raw.slice(3000) },
    { kind: 'stop' },
  ]);
  assert.equal(streamed.chunks.map((chunk) => chunk.text ?? '').join('').includes(raw), false, 'detected-prefix flush leaked a complete known value');
});
const FRAGMENT_SIZE = 8;
const runsOf = (text) => {
  const runs = new Set();
  for (let at = 0; at + FRAGMENT_SIZE <= text.length; at += 1) runs.add(text.slice(at, at + FRAGMENT_SIZE));
  return runs;
};
// The invariant is a SUBSTRING invariant: absence of the whole value proves nothing, because a
// value released as two halves is absent and leaked at the same time.
const leakedRunAt = (output, hidden) => {
  const runs = runsOf(output);
  for (let at = 0; at + FRAGMENT_SIZE <= hidden.length; at += 1) if (runs.has(hidden.slice(at, at + FRAGMENT_SIZE))) return at;
  return -1;
};
// A length-based hold-back releases its buffer only once the buffer passes twice its window, and
// that window follows the longest value in the live vault. Sizing the filler from the vault is what
// keeps these locks able to FAIL: a fixed filler silently stops reaching the release path as soon as
// an earlier test registers a longer value, and the leak then hides behind a green test.
const holdBackChars = () => Math.max(512, ...[...testState().values()].map((entry) => entry.value.length));
await test('V10 an incomplete known value is not released by a flush another detection triggers', async () => {
  const hidden = `opaque-${'z'.repeat(6000)}`;
  tokenize('fixture', hidden);
  const detector = `ghp_${'h'.repeat(36)}`;
  const before = journalSnapshot().size;
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `${detector} ${'x'.repeat(2 * holdBackChars() + 1200)} ${hidden.slice(0, 3000)}` },
    { kind: 'text', index: 0, text: hidden.slice(3000) },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
  assert.equal(output.includes(hidden), false, 'the complete known value reached the stream');
  assert.equal(leakedRunAt(output, hidden), -1, 'a raw run of the known value reached the stream');
  assert.equal(leakedRunAt(output, detector), -1, 'a raw run of the detected token reached the stream');
  assert.match(output, /REDACTION TOKEN/);
  assert(before >= 0 && [...journalSnapshot().values()].some((text) => text.includes('"surface":"assistant"') && text.includes('"action":"masked"')), 'masking produced no journal record');
});
await test('V11 a detected value straddling a prefix/tail cut is never released in halves', async () => {
  // A hold-back that releases "everything but the last N characters" cuts the buffer at a fixed
  // offset. This places a COMPLETE token across exactly that offset, where a released prefix holds
  // the token's first bytes and no detector has seen enough of it to mask them.
  const vendor = `ghp_${'j'.repeat(36)}`;
  const hold = holdBackChars();
  for (const inside of [1, 4, 8, 16, 24, 32, 35]) {
    const streamed = await collectStream(turnStep, [
      { kind: 'text', index: 0, text: `${'Ω'.repeat(hold + 1200)}${vendor}${'Ω'.repeat(hold - inside)}` },
      { kind: 'text', index: 0, text: 'Ω'.repeat(1200) },
      { kind: 'stop' },
    ]);
    const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
    assert.equal(leakedRunAt(output, vendor), -1, `cut ${inside} characters into the token: a raw run crossed it`);
  }
});
// A deterministic filler whose windows do not recur: an arithmetic walk over the alphabet has a
// period of 34 characters, so two such fillers share every 8-character window and a "leak" can be
// read off a fixture that never leaked. This one is driven by an LCG, so a run found in the output
// is attributable to the value it came from.
const varied = (length, offset = 0) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let seed = (offset * 2654435761 + 0x9e3779b9) >>> 0;
  let text = '';
  for (let at = 0; at < length; at += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    text += alphabet[(seed >>> 16) % alphabet.length];
  }
  return text;
};
await test('V12 an unfinished MULTILINE quoted assignment is held until the assignment completes', async () => {
  // The hold-back must follow the assignment SYNTAX, not the line. A quoted value that spans lines
  // is still unfinished, and releasing "everything but the last 512 characters" of it hands out the
  // confidential bytes before any detector has seen the closing quote.
  const confidential = `${varied(400, 1)}\n${varied(400, 2)}\n${varied(400, 3)}`;
  const opener = `${'pass'}word = "`;
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `${'Ω'.repeat(600)}${opener}${confidential}` },
    { kind: 'text', index: 0, text: '"\ndone\n' },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
  const at = leakedRunAt(output, confidential);
  assert.equal(at, -1, `a raw run of the unfinished multiline assignment escaped at offset ${at}`);
  assert.equal(output.includes(confidential), false, 'the complete confidential value reached the stream');
});
await test('V13 a value first detected in an emission also protects its own fragments', async () => {
  // The fragment index is what stops a value being released in pieces. Built from the vault ALONE it
  // cannot know a value this emission is the first to detect, so that value's own prefix goes out raw
  // beside its masked whole.
  const fresh = `ghp_${'QwErTy12'.repeat(4)}AbCd`;
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `here it is ${fresh} and again ${fresh.slice(0, 20)} end` },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
  const at = leakedRunAt(output, fresh);
  assert.equal(at, -1, `a raw run of the newly detected value reached the stream at offset ${at}`);
});
await test('V18 an OVERSIZED unfinished assignment keeps masking its continuation', async () => {
  // Discarding the buffer at the size cap also discards the knowledge that an assignment was left
  // open. The next chunk then looks like ordinary text to every detector, so the continuation of a
  // value whose opening quote was already masked is released raw.
  const opener = `${'pass'}word = "`;
  const continuation = varied(1000, 11);
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `${'Ω'.repeat(600)}${opener}${varied(66000, 12)}` },
    { kind: 'text', index: 0, text: `${continuation}"\ndone\n` },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
  const at = leakedRunAt(output, continuation);
  assert.equal(at, -1, `the continuation of an oversized unfinished assignment escaped at offset ${at}`);
  assert.match(output, /oversized secret-bearing stream block masked/);
});
await test('V22 an OVERSIZED unfinished UNQUOTED assignment keeps masking its continuation', async () => {
  // Round 6 carried the open state for quoted values and private keys only. An unquoted value has a
  // terminator too - the end of its line - and without it the continuation after the size cap reads
  // as ordinary text to every detector. The key starts its own line: `password: value` is detected
  // (op-output) only there, which is the shape the stream actually sees.
  for (const separator of ['=', ': ']) {
    const continuation = varied(1000, 21);
    const streamed = await collectStream(turnStep, [
      { kind: 'text', index: 0, text: `${'Ω'.repeat(600)}\n${'pass'}word${separator}${varied(66000, 22)}` },
      { kind: 'text', index: 0, text: `${continuation}\nvisible after the value\n` },
      { kind: 'stop' },
    ]);
    const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
    const at = leakedRunAt(output, continuation);
    assert.equal(at, -1, `password${separator.trim()}: the continuation of an oversized unquoted assignment escaped at offset ${at}`);
    assert.match(output, /visible after the value/, `password${separator.trim()}: text after the value's end was swallowed`);
  }
});
await test('V24 a private-key terminator split across chunks still closes the masking', async () => {
  // After an overflowed key block the stream drops text until `-----END `. A terminator arriving in
  // two chunks was never seen whole, so masking never closed and every later ordinary chunk vanished.
  const body = varied(66000, 31);
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `-----BEGIN RSA PRIVATE KEY-----\n${body}` },
    { kind: 'text', index: 0, text: `${varied(500, 32)}\n-----EN` },
    { kind: 'text', index: 0, text: 'D RSA PRIVATE KEY-----\nordinary text after the key\n' },
    { kind: 'text', index: 0, text: 'and a later ordinary chunk\n' },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
  assert.match(output, /ordinary text after the key/, 'text after a split terminator was swallowed');
  assert.match(output, /a later ordinary chunk/, 'a later ordinary chunk was swallowed');
  assert.equal(leakedRunAt(output, varied(500, 32)), -1, 'key material before the split terminator escaped');
});
await test('V26 an OVERSIZED detected value of ANY kind keeps masking its continuation', async () => {
  // Round 7 carried the open state for a list of kinds. Any detection still running at the size cap
  // is unfinished, whatever its kind; the carry follows the detection, not a list.
  for (const opener of ['API_KEY=', 'credential: ']) {
    const continuation = varied(1000, 41);
    const streamed = await collectStream(turnStep, [
      { kind: 'text', index: 0, text: `${'Ω'.repeat(600)}\n${opener}${varied(66000, 42)}` },
      { kind: 'text', index: 0, text: `${continuation}\nvisible after the value\n` },
      { kind: 'stop' },
    ]);
    const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
    const at = leakedRunAt(output, continuation);
    assert.equal(at, -1, `${opener.trim()} the continuation of an oversized detected value escaped at offset ${at}`);
    assert.match(output, /visible after the value/, `${opener.trim()} text after the value's line was swallowed`);
  }
});
await test('V28 a private-key terminator split across the FIRST overflowing chunk still closes the masking', async () => {
  // The carry was reset when the buffer overflowed, so a terminator whose first half sits at the end
  // of that very chunk was never seen whole.
  const streamed = await collectStream(turnStep, [
    { kind: 'text', index: 0, text: `-----BEGIN RSA PRIVATE KEY-----\n${varied(66000, 51)}\n-----EN` },
    { kind: 'text', index: 0, text: 'D RSA PRIVATE KEY-----\nordinary text after the key\n' },
    { kind: 'stop' },
  ]);
  const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
  assert.match(output, /ordinary text after the key/, 'text after a terminator split across the overflowing chunk was swallowed');
});
await test('stream fragment invariant holds at every split and every seeded chunking', async () => {
  // The value is long enough to outlast several cuts; the vault-sized cases that discriminate a
  // length-only hold-back live in V10 and V11, so this property stays cheap enough to run per gate.
  const long = `known-${'k'.repeat(1601)}`;
  tokenize('fixture', long);
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const paired = `\u{1F642}-${'m'.repeat(40)}-\u{1F642}`;
  tokenize('fixture', paired);
  const values = [
    github,
    `github_pat_${'A1_'.repeat(7)}Z`,
    aws,
    `sk-${'o'.repeat(24)}`,
    `xoxb-${'s'.repeat(16)}`,
    brave,
    `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(30)}.${'b'.repeat(43)}`,
    long,
    paired,
    `credential: ${uuid}`,
    `€${github}`,
  ];
  const filler = 'Ω'.repeat(2400);
  const assertMasked = async (raw, chunks, label) => {
    const streamed = await collectStream(turnStep, [...chunks.map((text) => ({ kind: 'text', index: 0, text })), { kind: 'stop' }]);
    const output = streamed.chunks.map((chunk) => chunk.text ?? '').join('');
    const hidden = raw.startsWith('credential: ') ? uuid : raw.startsWith('€') ? github : raw;
    const at = leakedRunAt(output, hidden);
    assert.equal(at, -1, `${label}: a ${FRAGMENT_SIZE}-character run of a ${hidden.length}-character value leaked at offset ${at}`);
  };
  for (const raw of values) {
    // Text AFTER the value is what pushes it onto a prefix/tail boundary, so short values carry a
    // trailing filler too; the long ones would only multiply the run time for the same boundary.
    const trailing = filler;
    for (let split = 1; split < raw.length; split += 1) {
      await assertMasked(raw, [`${github} ${filler} ${raw.slice(0, split)}`, `${raw.slice(split)}${trailing}`], `${raw.length}-char value, boundary ${split}`);
    }
  }
  let seed = 0x5eed1234;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let example = 0; example < 1000; example += 1) {
    const raw = values[random() % values.length];
    const source = `${random() % 2 ? `${github} ` : ''}${'Ω'.repeat(random() % 3400)} ${raw}${random() % 2 ? 'Ω'.repeat(random() % 3400) : ''}`;
    const chunks = [];
    for (let cursor = 0; cursor < source.length;) { const size = 1 + (random() % 331); chunks.push(source.slice(cursor, cursor + size)); cursor += size; }
    await assertMasked(raw, chunks, `seed=0x5eed1234 example=${example}`);
  }
  const clean = `ordinary € text ${'Ωμ '.repeat(4000)}`;
  const streamed = await collectStream(turnStep, [{ kind: 'text', index: 0, text: clean.slice(0, 7777) }, { kind: 'text', index: 0, text: clean.slice(7777) }, { kind: 'stop' }]);
  assert.equal(streamed.chunks.map((chunk) => chunk.text ?? '').join(''), clean, 'text carrying no secret run was altered');
});
await test('AssistantMessage render masking is display-only and forwards only scrubbed props', async () => {
  assert(assistantRender, 'AssistantMessage ui.render guard was not registered');
  const raw = `ghp_${'u'.repeat(36)}`;
  const event = { component: 'AssistantMessage', props: { text: raw, other: true } };
  let received;
  await assistantRender($, event, async (forwarded) => { received = forwarded; return {}; });
  assert.equal(received.props.text.includes(raw), false);
  assert.equal(event.props.text, raw, 'ui.render must not pretend to mutate stored input');
  const clean = { component: 'AssistantMessage', props: { text: 'clean' } };
  let cleanReceived;
  await assistantRender($, clean, async (forwarded) => { cleanReceived = forwarded; return {}; });
  assert.equal(cleanReceived, clean);
  const withoutText = { component: 'AssistantMessage', props: {} };
  let withoutTextReceived;
  await assistantRender($, withoutText, async (forwarded) => { withoutTextReceived = forwarded; return {}; });
  assert.equal(withoutTextReceived, withoutText);
});
await test('journal reload preserves records already present in the per-session file', async () => {
  const disk = new Map(); let storedSalt = 's'.repeat(64);
  const host = {
    getSalt: async () => storedSalt, setSalt: async (value) => { storedSalt = value; },
    fsRead: async (path) => { if (!disk.has(path)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } return disk.get(path); },
    fsWrite: async (path, text) => disk.set(path, text), fsStat: async (path) => ({ size: Buffer.byteLength(disk.get(path) ?? '') }),
    processRun: async (argv, init) => { const path = argv[2]; disk.set(path, `${disk.get(path) ?? ''}${init.stdin}`); return { exitCode: 0, stdout: path }; }, pluginRoot: async () => '/opt/wt-secret-guard',
    configDir: async () => '/tmp/reload-config', home: async () => '/tmp/reload-home',
    sessionId: async () => 'reload-session', sessionCwd: async () => '/tmp/reload-project', uiLog: async () => {},
  };
  const first = await import(`./journal.js?reload-first=${Date.now()}`);
  await first.appendEvent(host, { surface: 'bash', action: 'evaluated' });
  const second = await import(`./journal.js?reload-second=${Date.now()}`);
  await second.appendEvent(host, { surface: 'read', action: 'evaluated' });
  assert.equal([...disk.values()][0].trim().split('\n').length, 2);
});
await test('D6 journal appends from concurrent module instances without losing either event', async () => {
  const disk = new Map(); let storedSalt = 's'.repeat(64);
  const host = {
    getSalt: async () => storedSalt, setSalt: async (value) => { storedSalt = value; },
    fsRead: async (path) => disk.get(path) ?? '', fsWrite: async (path, text) => disk.set(path, text),
    processRun: async (argv, init) => { const path = argv[2]; disk.set(path, `${disk.get(path) ?? ''}${init.stdin}`); return { exitCode: 0, stdout: path }; }, pluginRoot: async () => '/opt/wt-secret-guard',
    configDir: async () => '/tmp/concurrent-config', home: async () => '/tmp/concurrent-home',
    sessionId: async () => 'concurrent-session', sessionCwd: async () => '/tmp/concurrent-project', uiLog: async () => {},
  };
  const first = await import(`./journal.js?concurrent-first=${Date.now()}`);
  const second = await import(`./journal.js?concurrent-second=${Date.now()}`);
  await Promise.all([
    first.appendEvent(host, { surface: 'bash', action: 'evaluated' }),
    second.appendEvent(host, { surface: 'read', action: 'evaluated' }),
  ]);
  assert.equal([...disk.values()][0].trim().split('\n').length, 2);
});
await test('R4 Windows prompt repair uses a shipped PowerShell -File adapter', async () => {
  const raw = `ghp_${'w'.repeat(36)}`;
  setFile(historyPath, `${JSON.stringify({ display: raw, pastedContents: {} })}\n`);
  const before = calls.length;
  const windows = { ...$, env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: configDir, HOME: '/tmp/home', OS: 'Windows_NT' })[name] } };
  await prompt(windows, { text: raw, origin: { kind: 'composer' } }, async () => ({}));
  const runs = calls.slice(before).filter((entry) => entry.capability === 'process.run');
  assert(runs.some((entry) => /powershell/i.test(entry.argv[0]) && entry.argv[3] === '-File' && /\.ps1$/i.test(entry.argv[4])));
  assert.equal(runs.some((entry) => entry.argv[0] === 'dd'), false);
});
await test('V8 Windows range writes recheck identity and expected bytes before writing', async () => {
  const raw = `ghp_${'w'.repeat(36)}`;
  const original = `${JSON.stringify({ display: raw, pastedContents: {} })}\n`;
  const replacement = `${JSON.stringify({ display: `ghp_${'r'.repeat(36)}`, pastedContents: {} })}\n`;
  setFile(historyPath, original);
  const windows = { ...$, env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: configDir, HOME: '/tmp/home', OS: 'Windows_NT' })[name] } };
  onBeforeWindowsWrite = async (path) => { const inode = getFile(path).inode; files.set(path, { text: replacement, mode: 0o600, inode }); onBeforeWindowsWrite = undefined; };
  await prompt(windows, { text: raw, origin: { kind: 'composer' } }, async () => ({}));
  assert.equal(getFile(historyPath).text, replacement, 'Windows adapter corrupted a replacement file');
  const script = readFileSync(new URL('./prompt-storage-range.ps1', import.meta.url), 'utf8');
  assert.match(script, /expected/i);
  assert.match(script, /Length/);
});
await test('D4 file references bind contents as data instead of shell source', async () => {
  setFile('/tmp/injection-secret', '$(printf INJECTED)');
  let received;
  const runtime = { ...$, process: { run: async (argv) => { received = argv; return { exitCode: 0, stdout: '' }; } } };
  await bash(runtime, { tool: 'Bash', command: 'printf %s secret:file:/tmp/injection-secret' }, async (event) => { received = event.command; return { text: 'ok' }; });
  assert.equal(received.includes('INJECTED'), false, 'secret content was inserted into shell source');
  assert(received.includes('base64 --decode'), 'secret content was not encoded as shell data');
});
await test('D5 explicit op read keeps account and failed prefetch refuses execution', async () => {
  const command = "echo \"$(op read --account 'other' 'op://vault/item/password')\"";
  let executed = false; let opArgv;
  const runtime = { ...$, process: { run: async (argv) => { opArgv = argv; return { exitCode: 1, stdout: '' }; } } };
  const result = await bash(runtime, { tool: 'Bash', command }, async () => { executed = true; return { text: 'leaked' }; });
  assert.deepEqual(opArgv, ['op', 'read', '--account', 'other', 'op://vault/item/password']);
  assert.equal(executed, false, 'command executed after op prefetch failed');
  assert.match(result.deny, /1Password reference/i);
});
await test('V4 every supported op read argument placement is prefetched or refused', async () => {
  const cases = [
    ["op read --account='team' -o /tmp/out 'op://vault/item/password'", 'team'],
    ["op read 'op://vault/item/password' --account team -o /tmp/out", 'team'],
    ["op read -o /tmp/out 'op://vault/item/password' --account=team", 'team'],
    ["op read 'op://vault/item/password' > /tmp/out", ''],
    ["> /tmp/out op read --account=team 'op://vault/item/password'", 'team'],
    ['"op" read \'op://vault/item/password\'', ''],
    ["op 'read' --account=team 'op://vault/item/password'", 'team'],
    ["o'p' read -n 'op://vault/item/password' --account team", 'team'],
    ["op read -n \\\n 'op://vault/item/password' --account team", 'team'],
  ];
  // Each placement carries its OWN item: a failed prefetch is remembered for the session (V19), so
  // reusing one reference would let the cache answer for every case after the first and the
  // placements after it would assert nothing.
  for (const [index, [shape, account]] of cases.entries()) {
    const ref = `op://vault/item/password-${index}`;
    const command = shape.replaceAll('op://vault/item/password', ref);
    let executed = false; let opArgv;
    const runtime = { ...$, process: { run: async (argv) => { opArgv = argv; return { exitCode: 1, stdout: '' }; } } };
    const result = await bash(runtime, { tool: 'Bash', command }, async () => { executed = true; return { text: 'leaked' }; });
    assert.equal(executed, false, `op invocation executed without a successful prefetch: ${command}`);
    assert.deepEqual(opArgv, account ? ['op', 'read', '--account', account, ref] : ['op', 'read', ref]);
    assert.match(result.deny, /1Password reference/i);
  }
});
await test('V14 a quoted spelling of the `op` command word is validated like the bare spelling', async () => {
  // Quoting changes the spelling of a shell word, never its meaning. `op 'read' "$REF"` runs exactly
  // what `op read "$REF"` runs, so it earns the same validation - and the same refusal.
  for (const command of ['op \'read\' "$REF"', '"op" read "$REF"', 'o"p" read "$REF"', "'op' 'read' \"$REF\"", 'op read"" "$REF"']) {
    let executed = false;
    const result = await bash($, { tool: 'Bash', command }, async () => { executed = true; return { text: 'raw' }; });
    assert.equal(executed, false, `${command} executed without validating its reference`);
    assert.match(result.deny ?? '', /refused/i, command);
  }
});
await test('V19 a FAILED prefetch is answered from memory instead of spawning op again', async () => {
  // Measured in a real session: one command carrying one reference produced 42,716 `op read` spawns
  // in about 100 seconds. The plugin resolves each reference once per call, so the re-entry is above
  // it - which is exactly why the bound has to sit here, where it holds whatever re-enters.
  const attempts = [];
  const runtime = { ...$, process: { run: async (argv) => { if (argv[0] === 'op') { attempts.push(argv); return { exitCode: 1, stdout: '' }; } return $.process.run(argv); } } };
  const command = "printf %s 'op://vault/storm/password'";
  for (let round = 0; round < 40; round += 1) {
    const result = await bash(runtime, { tool: 'Bash', command }, async () => ({ text: 'leaked' }));
    assert.match(result.deny ?? '', /refused/i, `round ${round} was not refused`);
  }
  assert.equal(attempts.length, 1, `a failing reference reached op ${attempts.length} times across 40 identical commands`);
});
await test('V20 a SUCCESSFUL resolution is never served from memory', async () => {
  // The other half of the same decision, locked so it cannot drift: a value that resolved once may
  // have rotated since, so re-reading it is the behaviour, and only the FAILURE is remembered.
  const attempts = [];
  const runtime = { ...$, process: { run: async (argv) => { if (argv[0] === 'op') { attempts.push(argv); return { exitCode: 0, stdout: 'rotating-value\n' }; } return $.process.run(argv); } } };
  for (let round = 0; round < 3; round += 1) {
    await bash(runtime, { tool: 'Bash', command: "printf %s 'op://vault/rotating/password'" }, async () => ({ text: 'ok' }));
  }
  assert.equal(attempts.length, 3, `a succeeding reference reached op ${attempts.length} times across 3 commands`);
  // The other bound, and the one the runaway analysis rests on: WITHIN one Bash call each DISTINCT
  // reference is resolved exactly once, however many times it is written.
  const perCall = [];
  const counting = { ...$, process: { run: async (argv) => { if (argv[0] === 'op') { perCall.push(argv.at(-1)); return { exitCode: 0, stdout: 'per-call-value\n' }; } return $.process.run(argv); } } };
  await bash(counting, { tool: 'Bash', command: "printf '%s%s%s' 'op://vault/once/a' 'op://vault/once/a' 'op://vault/once/b'" }, async () => ({ text: 'ok' }));
  assert.deepEqual(perCall, ['op://vault/once/a', 'op://vault/once/b'], 'one Bash call did not resolve each distinct reference exactly once');
});
await test('V23 the failure memory is a per-reference bound under concurrency and eviction', async () => {
  // Concurrency: forty requests arriving before the first failure is recorded each spawned a resolver.
  const concurrent = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = { ...$, process: { run: async (argv) => { if (argv[0] === 'op') { concurrent.push(argv); await gate; return { exitCode: 1, stdout: '' }; } return $.process.run(argv); } } };
  const pending = [];
  for (let round = 0; round < 40; round += 1) pending.push(bash(slow, { tool: 'Bash', command: "printf %s 'op://vault/concurrent/password'" }, async () => ({ text: 'leaked' })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const results = await Promise.all(pending);
  assert(results.every((result) => /refused/i.test(result.deny ?? '')), 'a concurrent request was not refused');
  assert.equal(concurrent.length, 1, `40 concurrent requests for one reference spawned ${concurrent.length} resolvers`);
  // Eviction: filling the memory with other failures must not reset a key still inside its window.
  const spawned = [];
  const failing = { ...$, process: { run: async (argv) => { if (argv[0] === 'op') { spawned.push(argv.at(-1)); return { exitCode: 1, stdout: '' }; } return $.process.run(argv); } } };
  const target = "printf %s 'op://vault/evicted/password'";
  await bash(failing, { tool: 'Bash', command: target }, async () => ({ text: 'leaked' }));
  for (let other = 0; other < 300; other += 1) await bash(failing, { tool: 'Bash', command: `printf %s 'op://vault/filler-${other}/password'` }, async () => ({ text: 'leaked' }));
  await bash(failing, { tool: 'Bash', command: target }, async () => ({ text: 'leaked' }));
  const retries = spawned.filter((ref) => ref === 'op://vault/evicted/password').length;
  assert.equal(retries, 1, `300 intervening failures let a reference inside its window spawn ${retries} times`);
});
await test('V17 a line continuation does not hide the documented op read form', async () => {
  // Bash removes a backslash-newline entirely - that is ordinary word reading, and the literal form
  // written with one is still OUR form. ANSI-C spellings of `op` are no longer this lock's business:
  // they are the documented out-of-scope case, locked as such in V21.
  const cases = [
    ['op r\\\nead "$REF"', 'line continuation inside the verb'],
    ['o\\\np read "$REF"', 'line continuation inside the command word'],
  ];
  for (const [command, shape] of cases) {
    let executed = false;
    const result = await bash($, { tool: 'Bash', command }, async () => { executed = true; return { text: 'short-13-pass' }; });
    assert.equal(executed, false, `${shape} executed without validating its reference: ${JSON.stringify(command)}`);
    assert.match(result.deny ?? '', /refused/i, shape);
  }
});
await test('V21 the planner acts on OUR forms only: refused in unowned contexts, out of scope otherwise, ordinary work untouched', async () => {
  // Four rounds showed that finding every way a shell reaches `op read` from the text cannot be won,
  // and that trying refuses ordinary work. So the guard acts on OUR reference forms and the one
  // literal documented `op read <literal op:// ref>` form, and on nothing else. This table locks all
  // three directions at once, so none of them can drift without the others noticing.
  const run = async (command) => {
    const spawned = [];
    const runtime = { ...$, process: { run: async (argv, init) => { if (/^op(?:\.exe)?$/.test(argv[0])) spawned.push(argv); return $.process.run(argv, init); } } };
    let received;
    const result = await bash(runtime, { tool: 'Bash', command }, async (event) => { received = event.command; return { text: 'short-13-pass' }; });
    return { result, received, spawned };
  };
  // 1. OUR forms inside a context we do not own: refused, by name, never executed.
  const refused = [
    ["$'op' $'read' 'op://vault/item/literal-ref'", 'ANSI-C words beside our 1Password form'],
    ["op $'read' --account=team 'op://vault/item/password'", 'an ANSI-C verb beside our 1Password form'],
    ["printf %s $'x' secret:env:GH_TOKEN", 'an ANSI-C span beside our env form'],
    ['echo `date`; printf %s secret:env:GH_TOKEN', 'a backtick beside our env form'],
    ['printf %s secret:env:GH_TOKEN\u0000', 'a NUL byte beside our env form'],
    ['"$EDITOR" op://vault/item/field', 'a command name we cannot read beside our 1Password form'],
    ['op read "$REF"', 'the documented op read form without a literal reference'],
    ['op --account=team read "$REF"', 'the documented op read form, global flag first, without a literal reference'],
  ];
  for (const [command, shape] of refused) {
    const { result, received } = await run(command);
    assert.equal(received, undefined, `${shape} executed: ${JSON.stringify(command)}`);
    assert.match(result.deny ?? '', /refused/i, shape);
  }
  // 2. DOCUMENTED OUT OF SCOPE: computed, aliased, eval'd or wrapped `op` invocations carrying none of
  //    our forms. The honest behaviour is locked: NOT refused, NOT rewritten, and NO prefetch - their
  //    output is protected only by the detectors and the values already in the vault (README).
  const outOfScope = [
    "$'\\557\\560' read \"$REF\"",
    "$'op\\0tail' read \"$REF\"",
    '$OP read "$REF"',
    'sudo "$CMD" read "$REF"',
    '$(printf op) read "$REF"',
    '{op,} read "$REF"',
    '/usr/bin/o? read "$REF"',
    `eval 'op read "$REF"'`,
    'alias r="op read"\nr "$REF"',
    'exec op read "$REF"',
    'command op read "$REF"',
    'env op read "$REF"',
    'time -p op read "$REF"',
    'CMD=op; "$CMD" read "$REF"',
  ];
  for (const command of outOfScope) {
    const { result, received, spawned } = await run(command);
    assert.equal(result?.deny, undefined, `an out-of-scope invocation was refused: ${JSON.stringify(command)} -> ${result?.deny}`);
    assert.equal(received, command, `an out-of-scope invocation was rewritten: ${JSON.stringify(command)}`);
    assert.equal(spawned.length, 0, `an out-of-scope invocation was prefetched: ${JSON.stringify(command)}`);
  }
  // 3. Ordinary work carrying none of our forms passes untouched, whatever it mentions.
  const ordinary = [
    "printf %s $'a\\tb'",
    'echo `date`',
    'while read line; do echo "$line"; done < /tmp/in',
    '"$EDITOR" /tmp/file',
    'ls {a,b}.txt *.md',
    'IFS= read -r first < /tmp/in',
    'npm --prefix "$dir" run build',
    'rg "$pattern" read',
    'echo op "$x"',
    'echo op read foo',
  ];
  for (const command of ordinary) {
    const { result, received, spawned } = await run(command);
    assert.equal(result?.deny, undefined, `ordinary work was refused: ${JSON.stringify(command)} -> ${result?.deny}`);
    assert.equal(received, command, `ordinary work was rewritten: ${JSON.stringify(command)}`);
    assert.equal(spawned.length, 0, `ordinary work spawned op: ${JSON.stringify(command)}`);
  }
  // The literal documented form keeps working wherever it is written, wrappers included: its
  // reference is literal, so it is prefetched and left as written.
  for (const command of ["exec op read 'op://vault/item/wrapped'", "op --account=team read 'op://vault/item/flag-first'"]) {
    const { result, received, spawned } = await run(command);
    assert.equal(result?.deny, undefined, `the documented form was refused: ${command} -> ${result?.deny}`);
    assert.equal(received, command, `the documented form was rewritten: ${command}`);
    assert.equal(spawned.length, 1, `the documented form was not prefetched exactly once: ${command}`);
  }
});
await test('V25 every value WE substitute is in the vault before the command runs - env references included', async () => {
  // A 13-character value matches no detector, so the only thing that can mask it in the output is the
  // vault knowing it. Env references were substituted as "${NAME}" and never registered.
  // A value NO other test registers: D2 already puts `short-13-pass` in the vault, so using it here
  // would let the vault mask it whether or not this path registers anything.
  const value = 'env13-onlyhere';
  assert.equal([...testState().values()].some((entry) => entry.value === value), false, 'fixture precondition: the value is already in the vault');
  testEnv.set('TEST_VALUE', value);
  let received;
  const result = await bash($, { tool: 'Bash', command: 'printf %s secret:env:TEST_VALUE' }, async (event) => { received = event.command; return { text: value }; });
  assert.equal(result?.deny, undefined, `the env reference was refused: ${result?.deny}`);
  assert.equal(result.text.includes(value), false, 'the substituted env value reached the tool result raw');
  assert.equal(spawnSync('bash', ['-c', received], { encoding: 'utf8', env: { PATH: process.env.PATH } }).stdout, value, 'the command did not receive the value the guard registered');
  // A reference whose value the guard cannot read is refused rather than substituted unknown.
  let executed = false;
  const unset = await bash($, { tool: 'Bash', command: 'printf %s secret:env:WT_NOT_SET_ANYWHERE' }, async () => { executed = true; return { text: 'x' }; });
  assert.equal(executed, false, 'an env reference with no readable value executed');
  assert.match(unset.deny ?? '', /refused/i);
});
await test('V27 a credential in a Python repr or a JSON body in command OUTPUT is detected', async () => {
  // The source-code exemption let `(`...`,`/`)`/`}` shapes through, and a quoted key followed by `:`
  // matched no pattern at all. Both are ordinary command output: a repr, an API response.
  const value = 'repr-json-fixture-credential';
  const shapes = [
    `Config(${'pass'}word='${value}', user='x')`,
    `Session(${'sec'}ret="${value}")`,
    `{"${'pass'}word": "${value}", "user": "x"}`,
    `{'${'tok'}en': '${value}', 'user': 'x'}`,
    `{"user": "x", "${'sec'}ret": "${value}"}`,
  ];
  for (const shape of shapes) {
    const result = await call('python -c "print(config)"', shape);
    assert.equal(result.text.includes(value), false, `a credential survived command output: ${shape}`);
  }
  // Source code keeps its exemption where the value is a NAME, not a literal: passing a variable is
  // not a credential, and reviewing such a call must not be scrubbed.
  const source = `connect(${'pass'}word=${'pass'}word, user=user)`;
  assert.equal((await call('git diff', source)).text, source, 'a call passing a variable was scrubbed');
});
await test('V15 a reference preceded by a backslash escape is refused instead of rewritten into broken syntax', async () => {
  // The escape belongs to the shell word. Replacing only the reference leaves the escape behind, and
  // the emitted command then carries an unmatched quote - accepted here, failing at run time there.
  setFile('/tmp/escaped-secret', 'escaped value');
  for (const command of ['printf %s \\secret:env:QUOTE_SECRET', 'printf %s \\secret:file:/tmp/escaped-secret', 'printf %s \\op://Private/item/field']) {
    let executed = false; let rewritten;
    const result = await bash($, { tool: 'Bash', command }, async (event) => { executed = true; rewritten = event.command; return { text: 'raw' }; });
    assert.equal(executed, false, `${command} was accepted and rewritten to ${rewritten}`);
    assert.match(result.deny ?? '', /refused/i, command);
  }
});
await test('V16 a trailing comment ends the line instead of reading as unfinished syntax', async () => {
  let rewritten;
  const result = await bash($, { tool: 'Bash', command: 'printf %s secret:env:GH_TOKEN # a note' }, async (event) => { rewritten = event.command; return { text: 'ok' }; });
  assert.equal(result?.deny, undefined, `a supported reference followed by a comment was refused: ${result?.deny}`);
  assert.match(rewritten, /printf %s "\$\{__wt_secret_0\}" # a note$/);
  assert.equal(spawnSync('bash', ['-c', rewritten], { encoding: 'utf8' }).stdout, 'fixture-gh-token-value');
});
await test('reference allow-list: every supported form expands byte-identically in every supported context', async () => {
  let directory;
  try { directory = mkdtempSync(join(tmpdir(), 'wt-secret-guard-op-')); } catch (error) {
    if (['EACCES', 'EROFS', 'ENOENT'].includes(error?.code)) throw new SkipTest(`writable temporary directory unavailable (${error.code})`);
    throw error;
  }
  try {
    const value = "matrix value with ' quote and € sign";
    writeFileSync(join(directory, 'op'), `#!/bin/sh\nprintf '%s\\n' "${value}"\n`, { mode: 0o755 });
    const vaultToken = tokenize('fixture', value);
    setFile('/tmp/matrix-secret', value);
    testEnv.set('MATRIX_SECRET', value);
    const path = `${directory}:${process.env.PATH}`;
    const run = (command) => spawnSync('bash', ['-c', command], { encoding: 'buffer', env: { ...process.env, PATH: path, MATRIX_SECRET: value } });
    const forms = [
      ['vault token', vaultToken],
      ['file reference', 'secret:file:/tmp/matrix-secret'],
      ['environment reference', 'secret:env:MATRIX_SECRET'],
      ['1Password reference', 'op://Private/matrix/password'],
    ];
    const contexts = [
      ['bare', (reference) => `printf %s ${reference}`],
      ['single-quoted', (reference) => `printf %s '${reference}'`],
      ['double-quoted', (reference) => `printf %s "${reference}"`],
      ['bare inside a substitution', (reference) => `printf %s "$(printf %s ${reference})"`],
      ['bare before a redirection', (reference) => `printf %s ${reference} > ${directory}/redirected; cat ${directory}/redirected`],
      ['double-quoted after a redirection target', (reference) => `> ${directory}/redirected printf %s "${reference}"; cat ${directory}/redirected`],
    ];
    for (const [form, reference] of forms) {
      for (const [context, build] of contexts) {
        const command = build(reference);
        let rewritten;
        const result = await bash($, { tool: 'Bash', command }, async (event) => { rewritten = event.command; return { text: 'ok' }; });
        assert.equal(result?.deny, undefined, `${form} in ${context} was refused: ${result?.deny}`);
        const execution = run(rewritten);
        assert.equal(execution.status, 0, `${form} in ${context}: ${execution.stderr?.toString()}`);
        assert.equal(execution.stdout.toString().replace(/\n$/, ''), value, `${form} in ${context} did not expand byte-identically`);
      }
    }
    // A heredoc body is NOT a supported context (round 8 decision): every form, in every heredoc
    // quoting, passes through as the literal text it is - unrewritten, unprefetched, unrefused - and
    // the command writes exactly that text.
    for (const [form, reference] of forms) {
      for (const [quoting, build] of [['unquoted', (text) => `cat <<EOF\n${text}\nEOF`], ['single-quoted', (text) => `cat <<'EOF'\n${text}\nEOF`], ['double-quoted', (text) => `cat <<"EOF"\n${text}\nEOF`]]) {
        const command = build(reference);
        const spawned = [];
        const counting = { ...$, process: { run: async (argv, init) => { if (/^op(?:\.exe)?$/.test(argv[0])) spawned.push(argv); return $.process.run(argv, init); } } };
        let rewritten;
        const result = await bash(counting, { tool: 'Bash', command }, async (event) => { rewritten = event.command; return { text: 'ok' }; });
        assert.equal(result?.deny, undefined, `${form} in a ${quoting} heredoc was refused: ${result?.deny}`);
        assert.equal(rewritten, command, `${form} in a ${quoting} heredoc was rewritten`);
        assert.equal(spawned.length, 0, `${form} in a ${quoting} heredoc was prefetched`);
        assert.equal(run(rewritten).stdout.toString().replace(/\n$/, ''), reference, `${form} in a ${quoting} heredoc did not stay literal text`);
      }
    }
    const invocations = [
      ['bare reference', 'op read op://Private/matrix/password'],
      ['single-quoted reference', "op read 'op://Private/matrix/password'"],
      ['double-quoted reference', 'op read "op://Private/matrix/password"'],
      ['documented flags', "op read --account 'my.1password.com' -n 'op://Private/matrix/password'"],
      ['inside a substitution', `printf %s "$(op read 'op://Private/matrix/password')"`],
      ['before a redirection', 'op read op://Private/matrix/password > /dev/null; op read op://Private/matrix/password'],
    ];
    for (const [placement, command] of invocations) {
      let rewritten;
      const result = await bash($, { tool: 'Bash', command }, async (event) => { rewritten = event.command; return { text: 'ok' }; });
      assert.equal(result?.deny, undefined, `op read ${placement} was refused: ${result?.deny}`);
      assert.equal(rewritten, command, `op read ${placement} was rewritten`);
      const execution = run(rewritten);
      assert.equal(execution.status, 0, `op read ${placement}: ${execution.stderr?.toString()}`);
      assert.equal(execution.stdout.toString().replace(/\n$/, ''), value, `op read ${placement} did not produce the value bytes`);
    }
    const multiple = tokenize('fixture', 'second matrix value');
    let combined;
    await bash($, { tool: 'Bash', command: `printf '%s|%s' ${multiple} ${vaultToken}` }, async (event) => { combined = event.command; return { text: 'ok' }; });
    assert.equal(run(combined).stdout.toString(), `second matrix value|${value}`);
    const refusals = [
      ['op read whose reference is a variable', 'op read $REF > output.tpl'],
      ['op read piped into op inject', 'op read $REF | op inject'],
      ['op read of a quoted variable', 'op read "$REF"'],
      ['op read with an undocumented flag', "op read --zap 'op://Private/matrix/password'"],
      ['op read with two references', "op read 'op://Private/matrix/password' 'op://Private/matrix/other'"],
      ['op inject beside a reference', 'op inject -i secret:file:/tmp/matrix-secret'],
      ['a reference inside a larger quoted string', "printf '%s' 'prefix op://Private/matrix/password suffix'"],
      ['a reference inside a parameter expansion', 'printf %s "${REF:-secret:env:MATRIX_SECRET}"'],
      ['a reference inside backticks', 'printf %s `printf %s secret:env:MATRIX_SECRET`'],
      ['a reference in an unterminated quote', "printf %s 'op://Private/matrix/password"],
      ['an undocumented reference form', 'printf %s secret:1p:Private/matrix/password'],
      ['a redaction token this session never issued', 'printf %s secret:fixture#abcdef'],
      ['a missing file reference', 'printf %s secret:file:/tmp/matrix-missing'],
      ['a relative file reference', 'printf %s secret:file:relative/path'],
      ['a lowercase environment name', 'printf %s secret:env:not_valid'],
      ['a truncated 1Password path', 'printf %s op://broken'],
      ['a reference written to a template destination', "printf '%s' 'op://Private/matrix/password' > /tmp/profile.tpl"],
      ['a reference escaped inside a double-quoted word', 'printf %s "\\secret:env:MATRIX_SECRET"'],
      ['op run with a flag beside a reference', "op run --env-file /tmp/env -- printf %s 'op://Private/matrix/password'"],
      ['a quoted op command word whose reference is a variable', '"op" read "$REF"'],
      ['a quoted op verb whose reference is a variable', "op 'read' \"$REF\""],
    ];
    // Every rejection family against every supported FORM. A family verified against one form only
    // says nothing about the other three: each form takes a different path through `extent`, and a
    // refusal that depends on the form rather than on the context is exactly what this catches.
    const families = [
      ['inside a comment', (reference) => `printf %s hello # ${reference}`],
      ['inside an ANSI-quoted word', (reference) => `printf %s $'${reference}'`],
      ['preceded by a backslash escape', (reference) => `printf %s \\${reference}`],
      ['beside op run', (reference) => `op run -- printf %s ${reference}`],
      ['written to a template destination', (reference) => `printf '%s' '${reference}' > /tmp/profile.tpl`],
      ['inside a parameter expansion', (reference) => `printf %s "\${REF:-${reference}}"`],
      ['inside backticks', (reference) => `printf %s \`printf %s ${reference}\``],
      ['inside a larger quoted word', (reference) => `printf '%s' 'prefix ${reference} suffix'`],
    ];
    for (const [form, reference] of forms) {
      for (const [family, build] of families) refusals.push([`a ${form} ${family}`, build(reference)]);
    }
    for (const [shape, command] of refusals) {
      let executed = false;
      const result = await bash($, { tool: 'Bash', command }, async () => { executed = true; return { text: 'raw' }; });
      assert.equal(executed, false, `${shape} executed`);
      assert.match(result.deny ?? '', /refused/i, shape);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
await test('V5 file reference contents remain byte-identical in supported quote contexts', async () => {
  const value = 'a  b\nc\n';
  setFile('/tmp/whitespace-secret', value);
  for (const command of ['printf %s secret:file:/tmp/whitespace-secret', 'printf %s "secret:file:/tmp/whitespace-secret"', "printf %s 'secret:file:/tmp/whitespace-secret'"]) {
    let rewritten;
    await bash($, { tool: 'Bash', command }, async (event) => { rewritten = event.command; return { text: 'ok' }; });
    const execution = spawnSync('bash', ['-c', rewritten], { encoding: 'buffer' });
    assert.equal(execution.status, 0);
    assert.deepEqual(execution.stdout, Buffer.from(value), `file reference bytes changed for ${command}`);
  }
});
await test('V9 journal rotation reuses the active segment', async () => {
  let directory;
  try { directory = mkdtempSync(join(tmpdir(), 'wt-secret-guard-journal-')); } catch (error) {
    if (['EACCES', 'EROFS', 'ENOENT'].includes(error?.code)) throw new SkipTest(`writable temporary directory unavailable (${error.code})`);
    throw error;
  }
  try {
    const path = join(directory, 'session.ndjson');
    writeFileSync(path, Buffer.alloc(4 * 1024 * 1024));
    const helper = new URL('./journal-append.mjs', import.meta.url);
    for (const line of ['one\n', 'two\n', 'three\n']) {
      const result = spawnSync(process.execPath, [helper.pathname, path], { input: line, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const entries = readdirSync(directory).filter((name) => name.startsWith('session.ndjson'));
    assert.equal(entries.length, 2, 'rotation created more than one active segment');
    const segment = entries.find((name) => name !== 'session.ndjson');
    assert.equal(statSync(join(directory, segment)).size, 14);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
await test('D7 resolver startup diagnostics never include arbitrary exception text', async () => {
  const raw = `ghp_${'r'.repeat(36)}`;
  const beforeLogs = logs.length;
  const runtime = { ...$, process: { run: async () => { throw new Error(raw); } } };
  await resolveReference(runtime, 'op://vault/item/field');
  assert(logs.slice(beforeLogs).every((line) => !line.includes(raw)));
});
await test('classic startup notice requires the flag and stays silent when Function Hooks are enabled', async () => {
  const { startupNotice, startupPayload } = await import('../bin/function-hooks-notice.mjs');
  assert.match(startupNotice({}), /Function Hooks.*disabled/i);
  assert.equal(startupNotice({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }), '');
  assert.match(startupPayload({}).systemMessage, /Secret guarding is inactive/);
  assert.equal(startupPayload({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }), null);
});
await test('D9 every attachment is scrubbed and SessionStart hook origin still warns', async () => {
  assert(attachment, 'prompt.attachment warning hook was not registered');
  const raw = `ghp_${'a'.repeat(36)}`;
  const event = { origin: { kind: 'hook', event: 'SessionStart' }, text: `replayed ${raw}` };
  let received;
  const beforeLogs = logs.length;
  await attachment($, event, async (forwarded) => { received = forwarded; return {}; });
  assert.equal(received.text.includes(raw), false);
  assert(logs.slice(beforeLogs).some((line) => /SessionStart/i.test(line)));
  assert(logs.slice(beforeLogs).every((line) => !line.includes(raw)));
  assert([...journalSnapshot().values()].some((text) => text.includes('"surface":"attachment"') && text.includes('"action":"warned"')));
  const engineRaw = `ghp_${'n'.repeat(36)}`;
  let engineReceived;
  await attachment($, { origin: { kind: 'file' }, index: 7, text: engineRaw }, async (forwarded) => { engineReceived = forwarded; return {}; });
  assert.equal(engineReceived.text.includes(engineRaw), false);
});
await test('D12 declared turnId and index fields drive dedupe identities', async () => {
  const source = readFileSync(new URL('./hooks.js', import.meta.url), 'utf8');
  assert.match(source, /event\.turnId/);
  assert.match(source, /event\.index/);
  assert.doesNotMatch(source, /turn_id|step_id|attachment_id|resolvedPath/);
});
await test('D14 read policy covers expansions, multiple paths, globs, envrc and backslashes', async () => {
  for (const command of [
    'cat <<EOF\n$(cat ~/.aws/credentials)\nEOF',
    'cat .env .env.example',
    'cat ~/.np*',
    'cat .envrc',
    String.raw`type C:\\Users\\fixture\\.aws\\credentials`,
  ]) assert.equal(verdictForBash(command).hit, true, command);
  assert.equal(verdictForPath(String.raw`C:\\Users\\fixture\\.envrc`).hit, true);
});
await test('D15 dated measurement comments remain beside measured adapters', async () => {
  const sources = ['journal.js', 'reference-runtime.js', 'references.js', 'prompt-storage-host.js'].map((name) => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
  for (const phrase of ['2026-09-21', 'fs.write', 'OP_ACCOUNT', '13-character', 'positional argv']) assert.match(sources, new RegExp(phrase.replace('.', '\\.')));
});
await test('D17 history storage returns immediately after successful repair', async () => {
  const raw = `ghp_${'h'.repeat(36)}`;
  setFile(historyPath, `${JSON.stringify({ display: raw, pastedContents: {} })}\n`);
  let sleeps = 0;
  onSleep = async () => { sleeps += 1; };
  await prompt($, { text: raw, origin: { kind: 'composer' } }, async () => ({}));
  onSleep = undefined;
  assert.equal(sleeps, 0, 'successful history repair kept retrying');
});
// LAST on purpose: it fills the failure memory, then empties it again by moving the clock.
await test('V29 the failure memory has an absolute bound: size, concurrency and expiry', async () => {
  // Measured by the reviewer at 28501c1f: 10,001 resident entries, 10,000 simultaneous distinct
  // resolvers, and expired entries kept until later activity. The per-reference bound held; the
  // ABSOLUTE one did not.
  const spawned = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gated = { ...$, process: { run: async (argv) => { spawned.push(argv.at(-1)); await gate; return { exitCode: 1, stdout: '' }; } } };
  const burst = [];
  for (let at = 0; at < 10000; at += 1) burst.push(resolveReference(gated, `op://vault/burst-${at}/password`, ''));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const simultaneous = spawned.length;
  release();
  const results = await Promise.all(burst);
  assert(results.every((result) => result.token === null), 'a bounded-out request produced a token');
  assert(simultaneous <= 16, `10,000 distinct references ran ${simultaneous} resolvers at once`);
  const { referenceMemoryStats } = await import('./reference-runtime.js');
  const failing = { ...$, process: { run: async () => ({ exitCode: 1, stdout: '' }) } };
  for (let at = 0; at < 3000; at += 1) await resolveReference(failing, `op://vault/sequential-${at}/password`, '');
  const resident = referenceMemoryStats().failures;
  assert(resident <= 1024, `3,000 distinct failures left ${resident} resident entries`);
  // Expiry: once the window has passed, the NEXT access leaves nothing expired behind.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 120_000;
    await resolveReference(failing, 'op://vault/after-expiry/password', '');
    assert(referenceMemoryStats().failures <= 1, `expired entries stayed resident: ${referenceMemoryStats().failures}`);
  } finally { Date.now = realNow; }
  // Leave nothing behind for the process: the entry just recorded carries the shifted clock.
  Date.now = () => realNow() + 240_000;
  try { await resolveReference(failing, 'op://vault/cleanup/password', ''); } finally { Date.now = realNow; }
});
console.log(`hooks registered: ${hooks.length}`);
process.exit(failures ? 1 : 0);
