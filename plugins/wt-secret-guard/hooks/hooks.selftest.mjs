import assert from 'node:assert/strict';
import { register, testState } from './hooks.js';
import { sha256 } from './sha256.js';
import { resolveReference } from './hooks.js';

const hooks = []; const logs = []; const calls = [];
const files = new Map([
  ['/tmp/wt-secret-guard-file', "file-secret value with ' quote\nsecond-file-secret"],
]);
const $ = {
  ui: { log: async (line) => logs.push(line) },
  fs: {
    readFile: async (path) => {
      if (typeof path !== 'string') throw new Error('fs.readFile takes a path string (positional)');
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    },
    writeFile: async (path, text) => calls.push({ capability: 'fs.writeFile', path, text }),
    stat: async () => ({ mode: 0o600 }),
  },
  store: { get: async () => ({}), set: async (key, value) => calls.push({ capability: 'store.set', key, value }) },
  process: { run: async (argv) => { calls.push({ capability: 'process.run', argv }); return { stdout: argv[0] === 'op' ? 'op-fake-value\n' : '' }; } },
};
register((event, matcher, hook) => hooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }));
const bash = hooks.find((hook) => hook.event === 'tool.call').hook;
const prompt = hooks.find((hook) => hook.event === 'prompt.submit').hook;
const read = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === 'Read').hook;
const mcp = hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool instanceof RegExp).hook;
const call = (command, output) => bash($, { tool: 'Bash', command }, async (event) => ({ result: { stdout: output ?? event.command, stderr: '' }, text: output ?? event.command }));
let failures = 0;
async function test(name, fn) { try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name}: ${error.message}`); } }

const github = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const aws = 'AKIA1234567890ABCDEF';
await test('sha256 known answer', async () => { assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
await test('output scrub and distinct tokens', async () => { const result = await call('x', `${github}\n${aws}`); assert(!JSON.stringify(result).includes(github)); assert(!JSON.stringify(result).includes(aws)); assert.equal(testState().size, 2); });
await test('token round-trip', async () => { const [token, entry] = [...testState()][0]; let received; await bash($, { tool: 'Bash', command: `echo ${token}` }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, `echo ${entry.value}`); });
await test('op reference rewrite with shell quoting', async () => { let received; const result = await bash($, { tool: 'Bash', command: "echo op://Private/O'Brien/token" }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, "echo \"$(op read 'op://Private/O'\"'\"'Brien/token')\""); assert.equal((result.text.match(/wt-secret-guard: rewrote/g) ?? []).length, 1); });
await test('op reference rewrite carries --account when the opAccount option is set', async () => { const { configure } = await import('./hooks.js'); configure({ opAccount: "my.1password.com" }); let received; await bash($, { tool: 'Bash', command: 'echo op://Private/item/field' }, async (event) => { received = event.command; return { text: 'ok' }; }); configure({}); assert.equal(received, "echo \"$(op read --account 'my.1password.com' 'op://Private/item/field')\""); let plain; await bash($, { tool: 'Bash', command: 'echo op://Private/item/field' }, async (event) => { plain = event.command; return { text: 'ok' }; }); assert.equal(plain, "echo \"$(op read 'op://Private/item/field')\""); });
await test('a value resolved through op:// is scrubbed from the result even when it matches no pattern', async () => { const result = await bash($, { tool: 'Bash', command: 'echo op://Private/item/pw' }, async () => ({ result: { stdout: 'op-fake-value\n', stderr: '' }, text: 'op-fake-value\n' })); assert(!JSON.stringify(result).includes('op-fake-value')); assert(/secret:onepassword#/.test(result.text)); assert(calls.some((call) => call.capability === 'process.run' && call.argv[0] === 'op' && call.argv[1] === 'read')); });
await test('env reference rewrite', async () => { let received; await bash($, { tool: 'Bash', command: 'echo secret:env:GH_TOKEN' }, async (event) => { received = event.command; return { text: 'ok' }; }); assert.equal(received, 'echo "$GH_TOKEN"'); });
await test('file reference rewrite quotes and tokenises its content before Bash runs', async () => { const value = "file-secret value with ' quote\nsecond-file-secret"; let received; const result = await bash($, { tool: 'Bash', command: 'echo secret:file:/tmp/wt-secret-guard-file' }, async (event) => { received = event.command; return { text: value }; }); assert.equal(received, "echo 'file-secret value with '\"'\"' quote\nsecond-file-secret'"); assert(!JSON.stringify(result).includes(value)); assert.match(result.text, /secret:file#/); });
await test('file reference line selection quotes and tokenises only that line', async () => { let received; const result = await bash($, { tool: 'Bash', command: 'echo secret:file:/tmp/wt-secret-guard-file#2' }, async (event) => { received = event.command; return { text: 'second-file-secret' }; }); assert.equal(received, "echo 'second-file-secret'"); assert(!JSON.stringify(result).includes('second-file-secret')); assert.match(result.text, /secret:file#/); });
await test('missing file reference remains unchanged and logs no path or value', async () => { let received; await bash($, { tool: 'Bash', command: 'cat secret:file:/tmp/wt-secret-guard-missing' }, async (event) => { received = event.command; return { text: 'failed' }; }); assert.equal(received, 'cat secret:file:/tmp/wt-secret-guard-missing'); assert(logs.some((line) => line === 'wt-secret-guard: file reference unavailable (1 reference)')); assert(logs.every((line) => !line.includes('/tmp/wt-secret-guard-missing'))); });
await test('Read result scrub publishes tokens without treating its path as a secret', async () => { const value = 'read-result-secret'; const result = await read($, { tool: 'Read', file_path: '/tmp/not-a-secret' }, async (event) => ({ ...event, text: `password = ${value}` })); assert(!JSON.stringify(result).includes(value)); assert.equal(result.file_path, '/tmp/not-a-secret'); assert.match(result.text, /secret:assignment#/); });
await test('MCP result scrub tokenises inbound sensitive text without rewriting its input', async () => { const value = 'mcp-result-secret'; const event = { tool: 'mcp__atrium__read_message', text: `token = ${value}` }; const result = await mcp($, event, async (received) => ({ ...received, text: received.text })); assert(!JSON.stringify(result).includes(value)); assert.equal(result.tool, event.tool); assert.match(result.text, /secret:assignment#/); });
await test('allow-list', async () => { const input = '0123456789abcdef0123456789abcdef01234567 123e4567-e89b-12d3-a456-426614174000 secret:github#abcdef'; const result = await call('cat fixture.txt', input); assert.equal(result.text, input); });
await test('logs contain no secret value', async () => { for (const value of [github, aws, "file-secret value with ' quote", 'second-file-secret', 'read-result-secret', 'mcp-result-secret']) assert(logs.every((line) => !line.includes(value))); });
await test('detection table in the store carries tokens, kinds and salted hashes, never values', async () => { assert.equal(calls.filter((call) => call.capability === 'fs.writeFile').length, 0); const publication = calls.filter((call) => call.capability === 'store.set' && call.key === 'detections').at(-1); assert(publication); const table = publication.value; const text = JSON.stringify(table); assert.equal(table.version, 1); assert(table.entries.length >= 2); assert(table.entries.every((entry) => entry.kind && /^secret:/.test(entry.token) && /^[a-f0-9]{64}$/.test(entry.sha256))); assert(!text.includes(github) && !text.includes(aws)); const saltWrite = calls.find((call) => call.capability === 'store.set' && call.key === 'salt'); assert(saltWrite); assert.equal(sha256(`${saltWrite.value}:${github}`), table.entries.find((entry) => entry.kind === 'github-classic').sha256); assert.notEqual(sha256(github), table.entries.find((entry) => entry.kind === 'github-classic').sha256); });
await test('persistent store never carries a value; tokens only under the detections key', async () => { const writes = calls.filter((call) => call.capability === 'store.set'); assert(writes.length >= 3); for (const value of [github, aws, "file-secret value with ' quote", 'second-file-secret', 'read-result-secret', 'mcp-result-secret']) assert(writes.every((call) => !JSON.stringify(call.value).includes(value))); assert(writes.filter((call) => call.key !== 'detections').every((call) => !JSON.stringify(call.value).includes('secret:'))); });
await test('op resolver runs the configured binary and logs a counts-only line when it fails', async () => { const { configure } = await import('./hooks.js'); configure({ opBinary: 'op.exe' }); const before = calls.length; await bash($, { tool: 'Bash', command: 'echo op://Private/item/pw2' }, async () => ({ text: 'x' })); const run = calls.slice(before).find((call) => call.capability === 'process.run'); assert(run && run.argv[0] === 'op.exe'); const failing = { ...$, process: { run: async () => { const e = new Error('spawn op ENOENT'); e.code = 'ENOENT'; throw e; } } }; const r = await resolveReference(failing, 'op://v/i/f'); assert.equal(r.token, null); assert(logs.some((line) => line.includes('op resolve failed to start (ENOENT)'))); assert(logs.every((line) => !line.includes('op-fake-value'))); configure({}); });
await test('op resolver returns a token, never its value', async () => { const result = await resolveReference($, 'op://vault/item/field'); assert.match(result.token, /^secret:onepassword#/); assert(!JSON.stringify(result).includes('op-fake-value')); assert.equal(testState().get(result.token).value, 'op-fake-value'); });
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
console.log(`hooks registered: ${hooks.length}`);
process.exit(failures ? 1 : 0);
