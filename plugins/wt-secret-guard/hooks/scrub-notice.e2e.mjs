// Replay real process output through the registered guard with disposable host storage.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from './hooks.js';

const value = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const expectNotices = process.argv.includes('--expect-notices');
const hooks = [];
const logs = [];
const directory = mkdtempSync(join(tmpdir(), 'guard-scrub-replay-'));
const store = new Map();
const runtime = {
  ui: { log: (line) => logs.push(line) },
  store: { get: (key) => store.get(key), set: (key, data) => store.set(key, data) },
  session: { id: () => 'scrub-replay', cwd: () => directory },
  env: { get: (name) => name === 'OS' ? undefined : directory },
  plugin: { root: fileURLToPath(new URL('../', import.meta.url)) },
  process: { run: (argv, init) => {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', input: init?.stdin });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  } },
  fs: { read: (path) => readFileSync(path, 'utf8'), stat: (path) => statSync(path) },
  clock: { sleep: () => {} },
};
register((event, matcher, handler) => hooks.push({ event, matcher: handler ? matcher : undefined, handler: handler ?? matcher }));
const tool = (name) => hooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === name).handler;
const prompt = hooks.find((hook) => hook.event === 'prompt.submit').handler;

async function replay(name, run) {
  const before = logs.length;
  const result = JSON.stringify(await run());
  const raw = result.includes(value);
  const token = /secret:github-classic#[a-f0-9]{6}/.test(result);
  const recorded = logs.slice(before);
  console.log(`${name}: raw value=${raw ? 'yes' : 'no'}; redaction token=${token ? 'yes' : 'no'}`);
  console.log(`ui.log: ${JSON.stringify(recorded)}`);
  assert.equal(raw, false);
  assert.equal(token, true);
  assert.equal(recorded.length > 0, expectNotices, 'unexpected console notice count');
}

async function replayCases() {
  await replay('real Bash', () => tool('Bash')(runtime, { tool: 'Bash', command: "printf '%s' \"$SCRUB_REPLAY_VALUE\"" }, async (event) => {
    const stdout = execFileSync('bash', ['-c', event.command], { encoding: 'utf8', env: { ...process.env, SCRUB_REPLAY_VALUE: value } });
    return { result: { stdout, stderr: '' }, text: stdout };
  }));
  await replay('tool result', () => tool('Grep')(runtime, { tool: 'Grep', pattern: 'fixture' }, async () => ({ text: value })));
  const history = join(directory, 'history.jsonl');
  writeFileSync(history, `${JSON.stringify({ display: value, pastedContents: {} })}\n`);
  await replay('prompt submit', () => prompt(runtime, { text: value, origin: { kind: 'composer' } }, async (event) => event));
  assert.equal(readFileSync(history, 'utf8').includes(value), false, 'prompt storage retained the fake credential');
}

try { await replayCases(); }
finally { rmSync(directory, { recursive: true, force: true }); }
