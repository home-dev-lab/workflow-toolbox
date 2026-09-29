import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCases } from '../scripts/judge-extract.mjs';
import { judgeCases, scoreCases, cliRunner } from '../scripts/judge-cases.mjs';
import { normalize } from '../scripts/transcript-verdicts.mjs';
import { RULE_CAP } from '../hooks/evidence.js';

const toolRule = (tool = 'Agent') => `---\non-demand:\n  triggers:\n    - kind: tool\n      tool: '^${tool}$'\n      unconditional: true\n---\nDo it.`;
const promptRule = `---\non-demand:\n  triggers:\n    - kind: prompt\n      regex: 'checkpoint'\n---\nRemember.`;
const use = (id, name = 'Agent', input = {}) => ({ type: 'tool_use', id, name, input });
const call = (...parts) => ({ type: 'assistant', message: { content: parts } });
const result = (...ids) => ({ type: 'user', message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: `result ${id}` })) } });
const served = (name, id, content = 'Do it.') => ({ type: 'attachment', timestamp: '2026-01-01T00:00:00Z', attachment: { type: 'hook_additional_context', toolUseID: id ? `${id}-context` : undefined, content: `<rule name="${name}">${content}</rule>` } });
const rows = async (file) => {
  if ((await stat(file)).isDirectory()) {
    const runs = (await readdir(file)).sort();
    file = join(file, runs.at(-1), (await readdir(join(file, runs.at(-1))))[0]);
  }
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
};
async function setup(t, records, source = toolRule(), name = 'r.md') {
  const root = await mkdtemp(join(tmpdir(), 'judge-review-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const rules = join(root, 'rules'), transcript = join(root, 'session.jsonl');
  await mkdir(rules);
  await writeFile(join(rules, name), source);
  await writeFile(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, rules, transcript, name, casesFile: join(root, 'cases.jsonl'), out: join(root, 'judge.jsonl') };
}
const extract = (f) => extractCases({ transcripts: [f.transcript], rulesDirs: [f.rules] });

test('multi-call records retain every call and result, with same-message text', async (t) => {
  const f = await setup(t, [served('r.md', ''), call({ type: 'text', text: 'I saved the checkpoint.' }, use('read', 'Read'), use('agent')), result('read', 'agent')]);
  const [c] = await extract(f);
  assert.equal(c.governedActs, 1);
  assert.match(c.excerpt, /checkpoint/);
  assert.match(c.excerpt, /tool call Agent agent/);
  assert.match(c.excerpt, /result agent/);
  assert.doesNotMatch(c.excerpt, /result read/);
});

test('an assistant message includes its own text before its governed call', async (t) => {
  const f = await setup(t, [served('r.md', ''), call({ type: 'text', text: 'checkpoint marker saved.' }, use('a')), result('a')]);
  const [c] = await extract(f);
  assert.equal(c.governedActs, 1);
  assert.match(c.excerpt, /checkpoint marker saved/);
});

test('prompt that causes attachment owns answer preceding a later prompt', async (t) => {
  const f = await setup(t, [{ type: 'user', message: { content: 'checkpoint now' } }, served('r.md', '', 'Remember.'), call({ type: 'text', text: 'Checkpoint done.' })], promptRule);
  const [c] = await extract(f);
  assert.equal(c.governedActs, 1);
  assert.match(c.excerpt, /Checkpoint done/);
});

test('prompt-side serve keeps its causing prompt across intervening metadata', async (t) => {
  const f = await setup(t, [{ type: 'user', message: { content: 'checkpoint now' } }, { type: 'system', subtype: 'metadata' }, served('r.md', '', 'Remember.'), call({ type: 'text', text: 'Checkpoint done.' })], promptRule);
  const [c] = await extract(f);
  assert.equal(c.governedActs, 1);
  assert.match(c.excerpt, /checkpoint now/);
});

test('historical trigger without proof cannot produce code-decided not applicable', async (t) => {
  const f = await setup(t, [served('r.md', ''), call(use('old', 'Agent'))], toolRule('Read'));
  const [c] = await extract(f);
  assert.equal(c.triggerState, 'unknown');
  assert.match(c.triggerReason, /historical|serve|excerpt/i);
  await writeFile(f.casesFile, JSON.stringify(c) + '\n');
  await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => { throw new Error('must not run'); } });
  assert.equal((await rows(f.out))[0].verdict, 'undecidable');
});

test('a case without an established trigger cannot be code-decided not applicable', async (t) => {
  const f = await setup(t, []);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'unknown', rule: 'r.md', ruleText: 'Do it.', excerpt: '', facts: {}, governedActs: 0 }) + '\n');
  await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => { throw new Error('unproved applicability must not call a model'); } });
  assert.equal((await rows(f.out))[0].verdict, 'undecidable');
});

test('git history at the serve supplies a candidate trigger but cannot prove it was active', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const f = await setup(t, [served('r.md', ''), call(use('old', 'Agent'))]);
  const git = (...args) => {
    const run = spawnSync('git', ['-C', f.rules, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' } });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q'); git('add', 'r.md'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial rule');
  await writeFile(join(f.rules, 'r.md'), toolRule('Read'));
  const [c] = await extract(f);
  assert.equal(c.governedActs, 1);
  assert.equal(c.triggerState, 'unknown');
  assert.match(c.triggerReason, /committed history|body differs|ambiguous/);
  assert.match(c.triggerSource, /^git /);
});

test('normalization retains its bounded refusal detection', () => {
  const hidden = 'x'.repeat(RULE_CAP + 1) + 'wt-rules-on-demand: read the rule below before this action\n<rule name="r.md">Do it.</rule>';
  const events = normalize({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: hidden }] } }, 1);
  assert.equal(events[0].refused, undefined, 'refusal beyond cap must not change the quality scanner result');
  assert.equal(events.some((event) => event.kind === 'delivery'), false, 'rule block beyond refusal cap is invisible to the quality scanner');
});

test('second serve owns causing call and earlier governed call is never neighbourhood', async (t) => {
  const f = await setup(t, [served('r.md', 'a'), call(use('a')), result('a'), call(use('b')), served('r.md', 'b'), result('b')]);
  const cases = await extract(f);
  assert.deepEqual(cases.map((c) => c.governedActs), [1, 1]);
  assert.doesNotMatch(cases[1].excerpt, /tool call Agent a|result a|-\d+ lines omitted/);
  assert.match(cases[1].excerpt, /result b/);
});

test('unrelated intervening transcript lines produce a positive gap', async (t) => {
  const f = await setup(t, [served('r.md', ''), call(use('a')), result('a'), { type: 'system', content: 'unrelated' }, { type: 'system', content: 'unrelated again' }, call(use('b')), result('b')]);
  const [c] = await extract(f);
  assert.match(c.excerpt, /… 2 lines omitted …/);
  assert.doesNotMatch(c.excerpt, /… -/);
});

test('trigger matcher errors are unknown', async (t) => {
  const source = `---\non-demand:\n  triggers:\n    - kind: tool\n      tool: '^Agent$'\n      input-regex: '(?:[a]{1024}){4}[b]'\n---\nDo it.`;
  const f = await setup(t, [served('r.md', ''), call(use('a', 'Agent', { prompt: 'a'.repeat(16384) }))], source);
  const [c] = await extract(f);
  assert.equal(c.triggerState, 'unknown');
  assert.match(c.triggerReason, /budget|error/i);
});

test('duplicate transcript aliases, repeated cases and evidence changes do not reuse stale rows', async (t) => {
  const f = await setup(t, [served('r.md', ''), call(use('a'))]);
  const alias = join(f.root, 'alias.jsonl'); await symlink(f.transcript, alias);
  assert.equal((await extractCases({ transcripts: [alias, f.transcript], rulesDirs: [f.rules] })).length, 1);
  const item = { caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: 'first', facts: {}, governedActs: 1, triggerState: 'known' };
  await writeFile(f.casesFile, `${JSON.stringify(item)}\n${JSON.stringify(item)}\n`);
  let calls = 0;
  const runner = async () => { calls++; return { answer: '{"verdict":"followed","reason":"ok"}', model: 'm' }; };
  const first = await judgeCases({ casesFile: f.casesFile, out: f.out, runner });
  assert.equal(calls, 1);
  await writeFile(f.casesFile, JSON.stringify({ ...item, excerpt: 'changed' }) + '\n');
  const second = await judgeCases({ casesFile: f.casesFile, out: f.out, previous: first.path, runner });
  assert.equal(calls, 2);
  assert.equal((await rows(second.path)).length, 1);
});

test('agreement includes unjudged labels and counts missing predictions', async (t) => {
  const f = await setup(t, []);
  const labels = join(f.root, 'labels.jsonl');
  await writeFile(f.out, JSON.stringify({ caseId: 'a', rule: 'r.md', verdict: 'followed' }) + '\n');
  await writeFile(labels, [['a', 'followed', 'x'], ['a', 'followed', 'y'], ['b', 'followed', 'x'], ['b', 'not followed', 'y']].map(([caseId, label, labeller]) => JSON.stringify({ caseId, label, labeller, rule: 'r.md' })).join('\n'));
  const report = await scoreCases(f.out, [labels]);
  assert.match(report, /1\/2 = 50\.0%/);
  assert.match(report, /disagree: b/);
  assert.ok(report.includes('1 labelled cases without a judge row'));
});

test('excerpt dropped counts follow retained acts rather than prompt text', async (t) => {
  const acts = Array.from({ length: 30 }, (_, i) => call(use(String(i), 'Agent', { prompt: 'x'.repeat(1400) })));
  const f = await setup(t, [served('r.md', ''), { type: 'user', message: { content: acts.map((_, i) => `line ${i + 3} `).join('') } }, ...acts]);
  const [c] = await extract(f);
  assert.equal(c.governedActs, 30);
  assert.ok(c.droppedActs > 0, 'dropped acts must count records that did not fit');
});

test('prompt preserves literal placeholder tokens in the served rule', async (t) => {
  const f = await setup(t, []);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Use {excerpt} literally; then {facts}', excerpt: 'ACTUAL EVIDENCE', facts: { known: true }, governedActs: 1, triggerState: 'known' }) + '\n');
  let prompt;
  await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async (value) => {
    prompt = value;
    return { model: 'm', answer: '{"verdict":"followed","reason":"ok"}' };
  } });
  assert.match(prompt, /Use \{excerpt\} literally; then \{facts\}/);
  assert.match(prompt, /Excerpt:\nACTUAL EVIDENCE/);
});

test('one surrounding markdown JSON fence is unwrapped before strict parsing', async (t) => {
  const f = await setup(t, []);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: 'act', facts: {}, governedActs: 1, triggerState: 'known' }) + '\n');
  await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => ({ model: 'm', answer: '```json\n{"verdict":"followed","reason":"ok"}\n```' }) });
  assert.equal((await rows(f.out))[0].verdict, 'followed');
});

test('contradictory duplicate verdict keys are invalid with the raw answer retained', async (t) => {
  const f = await setup(t, []);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: 'act', facts: {}, governedActs: 1, triggerState: 'known' }) + '\n');
  await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => ({ model: 'm', answer: '{"verdict":"not followed","verdict":"followed","reason":"wrong"}' }) });
  const [row] = await rows(f.out);
  assert.equal(row.verdict, 'undecidable');
  assert.match(row.rawAnswer, /"verdict":"not followed"/);
});

test('agent tools parse block and flow YAML, malformed declaration stays unknown with path', async (t) => {
  const f = await setup(t, [served('executor-delegation-briefs-read-only.md', ''), call(use('a', 'Agent', { subagent_type: 'reader' }))], toolRule(), 'executor-delegation-briefs-read-only.md');
  const agents = join(f.root, 'agents'); await mkdir(agents);
  const path = join(agents, 'reader.md');
  for (const [source, expected] of [['---\ntools:\n  - Read\n  - Glob\n---\n', ['Read', 'Glob']], ['---\r\ntools:\r\n  - Read\r\n  - Glob\r\n---\r\n', ['Read', 'Glob']], ['---\ntools: [Read, Glob]\n---\n', ['Read', 'Glob']], ['---\ntools: {nonsense}\n---\n', 'unknown']]) {
    await writeFile(path, source);
    const [c] = await extractCases({ transcripts: [f.transcript], rulesDirs: [f.rules], configDir: f.root });
    assert.deepEqual(c.facts.agents[0].tools, expected);
    assert.equal(c.facts.agents[0].source, path);
  }
});

test('refusal and id-less attachment following same act produce one case', async (t) => {
  const refusal = 'wt-rules-on-demand: read the rule below before this action\n<rule name="r.md">Do it.</rule>';
  const f = await setup(t, [call(use('a')), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: refusal }] } }, served('r.md', '')]);
  assert.equal((await extract(f)).length, 1);
});

test('judge writer refuses store, archive, symlink and nonjudge file; rollback unchanged in both modes', async (t) => {
  const f = await setup(t, []);
  const store = join(f.root, 'store.json'), archive = join(f.root, 'archive.jsonl'), alias = join(f.root, 'alias.jsonl'), storeAlias = join(f.root, 'store-alias.jsonl');
  const storeBytes = '{"compliance-verdicts-jsonl":""}\n', archiveBytes = '{"rule":"r.md","verdict":"not followed"}\n';
  await writeFile(store, storeBytes); await writeFile(archive, archiveBytes); await symlink(archive, alias); await symlink(store, storeAlias);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: '', facts: {}, governedActs: 0 }) + '\n');
  for (const out of [store, storeAlias, archive, alias]) await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out }), /judge|output|refus/i);
  const defaultStore = join(f.root, 'plugins', 'store', 'wt-rules-on-demand_test.json');
  await mkdir(join(f.root, 'plugins', 'store'), { recursive: true });
  await writeFile(defaultStore, JSON.stringify({ caseId: 'old', promptHash: 'hash' }) + '\n');
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: defaultStore }), /directory/);
  assert.equal(await readFile(store, 'utf8'), storeBytes);
  assert.equal(await readFile(archive, 'utf8'), archiveBytes);
  const { spawnSync } = await import('node:child_process');
  const rollback = new URL('../scripts/rollback-check.mjs', import.meta.url).pathname;
  const projectRules = join(f.root, '.claude', 'rules-on-demand'); await mkdir(projectRules, { recursive: true });
  await writeFile(join(projectRules, 'r.md'), toolRule());
  const verdicts = join(f.root, 'verdicts.jsonl'); await writeFile(verdicts, '');
  const run = (mechanical) => spawnSync(process.execPath, [rollback, '--project', f.root, '--store', store, '--verdicts', verdicts, '--dry-run', '--json', ...(mechanical ? ['--mechanical-only'] : [])], { encoding: 'utf8' });
  const before = [run(false), run(true)];
  for (const value of before) assert.equal(value.status, 0, value.stderr);
  const out = join(f.root, 'plugins', 'data', 'wt-rules-on-demand', 'judge', 'judgments.jsonl');
  await judgeCases({ casesFile: f.casesFile, out });
  for (const [index, mode] of [false, true].entries()) {
    const after = run(mode); assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before[index].stdout);
  }
});

test('CLI help and judge both use dedicated isolated profile and allow-listed environment', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture');
  const f = await setup(t, []), fake = join(f.root, 'fake-cli');
  const { chmod } = await import('node:fs/promises');
  await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs'); fs.appendFileSync(process.env.CLAUDE_CONFIG_DIR + '/observed', JSON.stringify({env:process.env, args:process.argv.slice(2)}) + '\\n');
if (process.argv.includes('--help')) console.log('-p --output-format --model --tools --setting-sources --strict-mcp-config --mcp-config --settings --no-session-persistence');
else console.log(JSON.stringify({result:'{"verdict":"followed","reason":"ok"}',model:'m'}));
`); await chmod(fake, 0o755);
  const profile = join(f.root, 'judge-profile'); await mkdir(profile);
  const previous = { ...process.env };
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(f.root, 'caller'), ANTHROPIC_MODEL: 'poison', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'poison', CLAUDE_CODE_SUBAGENT_MODEL: 'poison', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', WT_ROD_JUDGE_CONFIG_DIR: profile });
  try { await cliRunner('prompt', 'haiku', { binary: fake }); }
  finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
  const observed = await rows(join(profile, 'observed'));
  assert.equal(observed.length, 2);
  for (const { env } of observed) {
    assert.equal(env.CLAUDE_CONFIG_DIR, profile);
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']) assert.equal(env[key], undefined);
  }
});
