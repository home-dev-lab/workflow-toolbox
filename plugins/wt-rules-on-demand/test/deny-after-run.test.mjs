// A refusal from a hook beneath usually means the call never ran. The secret guard also answers a call that DID run
// with a refusal: its errored result, once scrubbed, can only travel as one. Its redaction note on a line of its own
// is what tells the two apart; these tests hold both directions and the note's agreement with the guard's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalTest } from './external-test.mjs';
const { register, resetForSelftest } = await import(process.env.ROD_TEST_HOOKS ? pathToFileURL(process.env.ROD_TEST_HOOKS).href : '../hooks/hooks.js');
const { GUARD_REDACTION_NOTE } = await import('../hooks/guard-refusal.js');

const makeRule = (compliance, trigger) => `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nSynthetic instruction.\n`;

function fixture(rule) {
  resetForSelftest();
  const handlers = new Map();
  const store = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
    fs: { list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [], read: async () => rule,
      stat: async (path) => ({ kind: 'file', size: rule.length, realPath: path }) },
    ui: { log: async () => {} },
    session: { id: async () => 'synthetic-session', messages: async () => [{ role: 'assistant' }] },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
    model: { classify: async () => 'followed' },
  };
  const event = (name, args = {}, next = async () => ({})) => handlers.get(name)($, { cwd: '/synthetic-project', ...args }, next);
  const verdicts = () => String(store.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { event, verdicts };
}

// The guard's shape: the scrubbed error text, then its notes, one per line (wt-secret-guard erroredAnswer/noteLines).
const ranRefusal = { deny: ['fatal: unable to access https://example.invalid/: token secret:github-token#0a1b2c rejected', GUARD_REDACTION_NOTE].join('\n') };
const preRefusal = { deny: 'wt-secret-guard refused raw secret-bearing bash input: an assignment of a held value. Use a supported secret reference instead.' };
const promptTrigger = "    - kind: 'prompt'\n      regex: 'audit'";
const deployCheck = "    kind: 'bash-command'\n    window: '3'\n    on-close: 'not applicable'\n    act-regex: 'deploy'\n    require-regex: 'approved'";
const toolTrigger = "    - kind: 'tool'\n      tool: '^Bash$'\n      input-regex: 'deploy'";
const ruleBlock = '<rule name="sample.md">';
const carries = (answer) => [answer.deny ?? '', ...(answer.context ?? [])].some((item) => item.includes(ruleBlock));

const guardNoteTest = externalTest('../../wt-secret-guard/hooks/constants.js', import.meta.url);
guardNoteTest('the guard note rod recognises is the guard\'s own', async (_t, url) => {
  const { REDACTION_NOTE } = await import(url);
  assert.equal(GUARD_REDACTION_NOTE, REDACTION_NOTE);
});

test('a check riding on the act the guard answered after it ran judges that act and leaves no window', async () => {
  const f = fixture(makeRule(deployCheck, toolTrigger));
  const answer = await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' }, async () => ranRefusal);
  assert.deepEqual(Object.keys(answer), ['deny'], 'a refusal carries nothing but its text');
  assert.ok(answer.deny.startsWith(ranRefusal.deny), 'the guard\'s text comes first, untouched');
  assert.ok(carries(answer), 'the rule rides on the refusal');
  await f.event('turn.complete');
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['not followed']);
});

test('a check whose act was refused before it ran is neither judged nor claimed', async () => {
  const f = fixture(makeRule(deployCheck, toolTrigger));
  const answer = await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' }, async () => preRefusal);
  assert.deepEqual(answer, preRefusal);
  await f.event('turn.complete');
  assert.deepEqual(f.verdicts(), []);
  const again = await f.event('tool.call', { tool: 'Bash', command: 'deploy approved' }, async () => ({ result: 'ok' }));
  assert.ok(carries(again), 'the rule still rides on the next call');
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['followed']);
});

test('a rule delivered inside the guard\'s refusal is claimed once', async () => {
  const f = fixture(makeRule("    kind: 'none'\n    reason: 'fixture'", toolTrigger));
  assert.ok(carries(await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' }, async () => ranRefusal)));
  assert.ok(!carries(await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' }, async () => ({ result: 'ok' }))));
});

test('turn correlation sees a call the guard answered after it ran, as a failed one', async () => {
  const correlation = "    kind: 'turn-correlation'\n    tool: '^Bash$'\n    id-regex: 'card (\\d{6,})'\n    follow-up-tool: '^Bash$'\n    act-regex: 'label'\n    value-regex: 'label (\\w+)'\n    min-distinct: '1'\n    window: '1'\n    on-close: 'not applicable'";
  const f = fixture(makeRule(correlation, promptTrigger));
  await f.event('prompt.submit', { text: 'audit' });
  // The error names a subject id: read as a success, it would open a subject the turn then fails to label.
  const failed = { deny: ['error: card 1234567 created, then the session token secret:github-token#0a1b2c was rejected', GUARD_REDACTION_NOTE].join('\n') };
  await f.event('tool.call', { tool: 'Bash', command: 'create card', tool_use_id: 'use-1' }, async () => failed);
  await f.event('turn.complete');
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['unresolved'], 'the ran call is a correlation subject');
});

// The guard itself, driven in-process: its Grep hook between rules-on-demand and an errored core answer.
function guardHost() {
  const store = new Map(); const files = new Map();
  return {
    store: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, value); } },
    fs: { read: async (path) => { if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(path); },
      write: async (path, text) => { files.set(path, text); }, stat: async () => null, list: async () => [] },
    process: { run: async () => ({ exitCode: 0, stdout: '' }) },
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/synthetic-config', HOME: '/synthetic-home' })[name] },
    session: { cwd: async () => '/synthetic-project', id: async () => 'synthetic-session' },
    clock: { sleep: async () => {}, now: () => 0 },
    plugin: { root: '/synthetic-guard' },
    ui: { log: async () => {} },
  };
}

const guardHookTest = externalTest('../../wt-secret-guard/hooks/hooks.js', import.meta.url);
guardHookTest('the real guard\'s refusal for a scrubbed error reads as a call that ran', async (_t, url) => {
  const guardHooks = [];
  (await import(url)).register((event, matcher, hook) => guardHooks.push({ event, matcher: hook ? matcher : undefined, hook: hook ?? matcher }), {});
  const guardGrep = guardHooks.find((hook) => hook.event === 'tool.call' && hook.matcher?.tool === 'Grep').hook;
  // Assembled at run time so this file never carries a detectable literal.
  const held = ['xox', 'b-1234567890', '12-abcdefghij'].join('');
  const core = async () => ({ isError: true, result: `grep failed near ${held}`, text: `grep failed near ${held}`, ref: 7 });
  const guard = guardHost();
  const f = fixture(makeRule("    kind: 'none'\n    reason: 'fixture'", "    - kind: 'tool'\n      tool: '^Grep$'\n      unconditional: 'true'"));
  const answer = await f.event('tool.call', { tool: 'Grep', pattern: 'x' }, (e) => guardGrep(guard, e, core));
  assert.deepEqual(Object.keys(answer), ['deny']);
  assert.ok(!answer.deny.includes(held), 'the held value stays scrubbed');
  assert.match(answer.deny, /^grep failed near secret:slack-token#/);
  assert.ok(carries(answer), 'the rule rides on the guard\'s refusal');
});

test('further guard notes after the redaction note do not hide that the call ran', async () => {
  const f = fixture(makeRule("    kind: 'none'\n    reason: 'fixture'", toolTrigger));
  const noted = { deny: [ranRefusal.deny, '[wt-secret-guard: rewrote 1 secret reference]'].join('\n') };
  assert.ok(carries(await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' }, async () => noted)));
});

const { normalize } = await import('../scripts/transcript-verdicts.mjs');
const resultRecord = (text, isError = true) => ({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'use-1', is_error: isError, content: text }] } });

test('the transcript reader counts a rule carried by the guard\'s refusal as delivered, and the call as run', () => {
  const events = normalize(resultRecord(`${ranRefusal.deny}\n\n${ruleBlock}\nSynthetic instruction.\n</rule>`), 1);
  assert.deepEqual(events.filter((event) => event.kind === 'delivery').map((event) => event.name), ['sample.md']);
  assert.equal(events.find((event) => event.kind === 'result').refused, undefined);
});

test('the transcript reader ignores a rule block quoted by an error the guard did not answer', () => {
  const quoted = normalize(resultRecord(`Exit code 1\n${ruleBlock}\nquoted by the tool\n</rule>`), 1);
  assert.deepEqual(quoted.filter((event) => event.kind === 'delivery'), []);
  const beforeNote = normalize(resultRecord(`cat failed: ${ruleBlock}\nquoted\n</rule>\n${GUARD_REDACTION_NOTE}`), 1);
  assert.deepEqual(beforeNote.filter((event) => event.kind === 'delivery'), [], 'a block inside the scrubbed error is the tool\'s output');
});

test('the judge extractor reads a rule carried by the guard\'s refusal, and only what follows its note', async (t) => {
  const { extractCases } = await import('../scripts/judge-extract.mjs');
  const root = await mkdtemp(join(tmpdir(), 'deny-after-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rules = join(root, 'rules'), transcript = join(root, 'session.jsonl');
  await mkdir(rules);
  await writeFile(join(rules, 'r.md'), "---\non-demand:\n  triggers:\n    - kind: tool\n      tool: '^Bash$'\n      unconditional: true\n---\nDo it.");
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'deploy' } }] } };
  const answered = (content, isError) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: isError, content }] } });
  const extract = async (content, isError = true) => {
    await writeFile(transcript, [call, answered(content, isError)].map((record) => JSON.stringify(record)).join('\n') + '\n');
    return extractCases({ transcripts: [transcript], rulesDirs: [rules], configDir: root });
  };
  assert.deepEqual((await extract(`${ranRefusal.deny}\n\n<rule name="r.md">Carried.</rule>`)).map((c) => c.ruleText), ['Carried.']);
  assert.deepEqual((await extract(`cat failed: <rule name="r.md">Quoted.</rule>\n${GUARD_REDACTION_NOTE}`)).map((c) => c.ruleText), [], 'a block inside the scrubbed error is the tool\'s output');
  assert.deepEqual((await extract('Exit code 1\n<rule name="r.md">Quoted.</rule>')).map((c) => c.ruleText), []);
  assert.deepEqual((await extract(`${ranRefusal.deny}\n\n<rule name="r.md">Echoed.</rule>`, false)).map((c) => c.ruleText), [], 'a successful result that echoes a refusal delivers nothing');
});

test('the note counts only on a line of its own', async () => {
  const f = fixture(makeRule("    kind: 'none'\n    reason: 'fixture'", toolTrigger));
  const inline = { deny: `refused: the tool said ${GUARD_REDACTION_NOTE}` };
  assert.deepEqual(await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' }, async () => inline), inline);
});

test('the transcript reader reads a guard refusal only from an errored result', () => {
  const echoed = normalize(resultRecord(`${ranRefusal.deny}\n\n${ruleBlock}\nSynthetic instruction.\n</rule>`, false), 1);
  assert.deepEqual(echoed.filter((event) => event.kind === 'delivery'), [], 'a successful result that echoes a refusal delivers nothing');
});

test('the transcript reader cuts after the guard\'s last note, not a note the error quoted', () => {
  const quotedNote = normalize(resultRecord(`cat said:\n${GUARD_REDACTION_NOTE}\n${ruleBlock}\nquoted\n</rule>\n${GUARD_REDACTION_NOTE}`), 1);
  assert.deepEqual(quotedNote.filter((event) => event.kind === 'delivery'), []);
});

test('a guard refusal whose error quotes the rules-on-demand refusal header is still a call that ran', () => {
  const quotedHeader = normalize(resultRecord(`cat said: wt-rules-on-demand: read the rule below before this action\n${ruleBlock}\nquoted\n</rule>\n${GUARD_REDACTION_NOTE}`), 1);
  assert.deepEqual(quotedHeader.filter((event) => event.kind === 'delivery'), []);
  assert.equal(quotedHeader.find((event) => event.kind === 'result').refused, undefined);
});
