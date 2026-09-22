import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detections, optionalDetections } from './detector.js';
import { configure, register, testState, tokenize } from './hooks.js';
import { sha256 } from './sha256.js';
import { resolveReference } from './hooks.js';
import { opReadArgv, opReferencesIn, opValueFrom } from './op-resolve.js';

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
const setFile = (path, text, mode = 0o600) => files.set(path, { text, mode, inode: nextInode++ });
const getFile = (path) => files.get(path);
let onSleep;
let onBeforeCompare;
let onBeforeWrite;
const readFile = async (path) => {
  if (typeof path !== 'string') throw new Error('fs.read takes a path string (positional)');
  if (!files.has(path)) throw new Error('ENOENT');
  return files.get(path).text;
};
const $ = {
  ui: { log: async (line) => logs.push(line) },
  fs: {
    read: readFile,
    readFile,
    stat: async (path) => ({ kind: 'file', size: Buffer.byteLength(files.get(path).text), mtimeMs: 0 }),
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
    return { exitCode: 0, stdout: argv[0] === 'op' ? 'op-fake-value\n' : '' };
  } },
  env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: configDir, HOME: '/tmp/home' })[name] },
  session: { cwd: async () => projectDir, id: async () => sessionId },
  clock: { sleep: async () => { if (onSleep) await onSleep(); }, now: () => 0 },
};
register((event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }));
const bash = hooks.find((hook) => hook.event === 'tool.call').hook;
const prompt = hooks.find((hook) => hook.event === 'prompt.submit').hook;
const receive = hooks.find((hook) => hook.event === 'session.receive')?.hook;
const context = hooks.find((hook) => hook.event === 'prompt.context')?.hook;
const read = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === 'Read').hook;
const mcp = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool instanceof RegExp).hook;
const call = (command, output) => bash($, { tool: 'Bash', command }, async (event) => ({ result: { stdout: output ?? event.command, stderr: '' }, text: output ?? event.command }));
let failures = 0;
async function test(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`); } }

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
await test('shared corpus contains the 47 SR Cloud command verdicts and no local workspace path', async () => {
  assert.equal(corpus.denyCommands.length, 47);
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
await test('token round-trip', async () => { const [token, entry] = [...testState()][0]; let received; await bash($, { tool: 'Bash', command: `echo ${token}` }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, `echo ${entry.value}`); });
await test('op reference rewrite with shell quoting', async () => { let received; const result = await bash($, { tool: 'Bash', command: "echo op://Private/O'Brien/token" }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, "echo \"$(op read 'op://Private/O'\"'\"'Brien/token')\""); assert.equal((result.text.match(/wt-secret-guard: rewrote/g) ?? []).length, 1); });
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
await test('op reference written to a tpl file is left literal', async () => { await assertSkippedWhilePlainRewrites("printf '%s\\n' 'op://Private/item/field' > /tmp/profile.tpl"); });
await test('op reference in a heredoc body is left literal', async () => { await assertSkippedWhilePlainRewrites("cat <<'EOF'\nop://Private/item/field\nEOF"); });
await test('op reference in a sed search pattern is left literal', async () => { await assertSkippedWhilePlainRewrites("sed -n '/op:\\/\\/Private\\/item\\/field/p' /tmp/input"); });
await test('op reference inside a larger quoted string is left literal', async () => { await assertSkippedWhilePlainRewrites("printf '%s\\n' 'prefix op://Private/item/field suffix'"); });
await test('already substituted op reference is not rewritten again', async () => { await assertSkippedWhilePlainRewrites("echo \"$(op read 'op://Private/item/field')\""); });
await test('env reference rewrite', async () => { let received; await bash($, { tool: 'Bash', command: 'echo secret:env:GH_TOKEN' }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, 'echo "$GH_TOKEN"'); });
await test('file reference rewrite quotes and tokenises its content before Bash runs', async () => { const value = "file-secret value with ' quote\nsecond-file-secret"; let received; const result = await bash($, { tool: 'Bash', command: 'echo secret:file:/tmp/wt-secret-guard-file' }, async (event) => { received = event.command; return { text: value }; }); assert.equal(received, "echo 'file-secret value with '\"'\"' quote\nsecond-file-secret'"); assert(!JSON.stringify(result).includes(value)); assert.match(result.text, /secret:file#/); });
await test('file reference line selection quotes and tokenises only that line', async () => { let received; const result = await bash($, { tool: 'Bash', command: 'echo secret:file:/tmp/wt-secret-guard-file#2' }, async (event) => { received = event.command; return { text: 'second-file-secret' }; }); assert.equal(received, "echo 'second-file-secret'"); assert(!JSON.stringify(result).includes('second-file-secret')); assert.match(result.text, /secret:file#/); });
await test('missing file reference remains unchanged and logs no path or value', async () => { let received; await bash($, { tool: 'Bash', command: 'cat secret:file:/tmp/wt-secret-guard-missing' }, async (event) => { received = event.command; return { text: 'failed' }; }); assert.equal(received, 'cat secret:file:/tmp/wt-secret-guard-missing'); assert(logs.some((line) => line === 'wt-secret-guard: file reference unavailable (1 reference)')); assert(logs.every((line) => !line.includes('/tmp/wt-secret-guard-missing'))); });
await test('Read result scrub publishes tokens without treating its path as a secret', async () => { const value = 'read-result-secret'; const result = await read($, { tool: 'Read', file_path: '/tmp/not-a-secret' }, async (event) => ({ ...event, text: `password = ${value}` })); assert(!JSON.stringify(result).includes(value)); assert.equal(result.file_path, '/tmp/not-a-secret'); assert.match(result.text, /secret:assignment#/); });
await test('MCP result scrub tokenises inbound sensitive text without rewriting its input', async () => { const value = 'mcp-result-secret'; const event = { tool: 'mcp__atrium__read_message', text: `token = ${value}` }; const result = await mcp($, event, async (received) => ({ ...received, text: received.text })); assert(!JSON.stringify(result).includes(value)); assert.equal(result.tool, event.tool); assert.match(result.text, /secret:assignment#/); });
await test('[KNOWN GAP deny layer] Bash secret-file reads currently reach the executor unchanged', async () => {
  const command = corpus.denyCommands.find((fixture) => fixture.verdict)?.command;
  let received;
  const result = await bash($, { tool: 'Bash', command }, async (event) => { received = event; return { text: 'fixture file contents' }; });
  assert.equal(received.command, command);
  assert.equal(result.deny, undefined);
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
await test('op resolver runs the configured binary and logs a counts-only line when it fails', async () => { const { configure } = await import('./hooks.js'); configure({ opBinary: 'op.exe' }); const before = calls.length; await bash($, { tool: 'Bash', command: 'echo op://Private/item/pw2' }, async () => ({ text: 'x' })); const run = calls.slice(before).find((call) => call.capability === 'process.run'); assert(run && run.argv[0] === 'op.exe'); const failing = { ...$, process: { run: async () => { const e = new Error('spawn op ENOENT'); e.code = 'ENOENT'; throw e; } } }; const r = await resolveReference(failing, 'op://v/i/f'); assert.equal(r.token, null); assert(logs.some((line) => line.includes('op resolve failed to start (ENOENT)'))); assert(logs.every((line) => !line.includes('op-fake-value'))); configure({}); });
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
console.log(`hooks registered: ${hooks.length}`);
process.exit(failures ? 1 : 0);
