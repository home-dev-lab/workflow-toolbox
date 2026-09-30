import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/judge-cases.mjs', import.meta.url));
const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const rule = (kind, regex) => `---\non-demand:\n  triggers:\n    - kind: ${kind}\n      regex: '${regex}'\n  compliance:\n    kind: none\n    reason: judgment\n---\nFollow the instruction.`;
const toolRule = `---\non-demand:\n  triggers:\n    - kind: tool\n      tool: '^Agent$'\n      unconditional: true\n  compliance:\n    kind: none\n    reason: judgment\n---\nRead-only delegate.`;
const row = (type, n, other = {}) => ({ type, timestamp: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), sessionId: 'session', ...other });
const use = (id, n, input = { subagent_type: 'reader' }) => row('assistant', n, { message: { content: [{ type: 'text', text: 'I will delegate.' }, { type: 'tool_use', id, name: 'Agent', input }] } });
const result = (id, n, content = 'done') => row('user', n, { message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const delivery = (name, id, n, body) => row('attachment', n, { attachment: { type: 'hook_additional_context', toolUseID: `${id}-context`, content: `<rule name="${name}">${body}</rule>` } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'judge-fixture-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true, force: true }); });
  const projects = join(root, 'projects');
  const session = join(projects, 'session.jsonl');
  const subagents = join(projects, 'session', 'subagents');
  const rules = join(root, 'rules');
  const agents = join(root, '.claude', 'agents');
  await Promise.all([mkdir(subagents, { recursive: true }), mkdir(rules), mkdir(agents, { recursive: true })]);
  await writeFile(join(rules, 'executor-delegation-briefs-read-only.md'), toolRule);
  await writeFile(join(rules, 'checkpoint-and-compaction-policy-at-act.md'), rule('prompt', 'checkpoint'));
  await writeFile(join(agents, 'reader.md'), '---\nname: reader\ntools: Read, Glob\n---\n');
  const records = [row('user', 0, { cwd: root, message: { content: 'checkpoint now' } }),
    delivery('executor-delegation-briefs-read-only.md', 'a', 1, 'Served read-only text.'), use('a', 1), result('a', 2, 'x'.repeat(10000)),
    row('system', 3, { subtype: 'compact_boundary' }), row('assistant', 4, { message: { content: [{ type: 'text', text: 'Unrelated answer.' }] } }),
    use('b', 5), result('b', 6), delivery('executor-delegation-briefs-read-only.md', 'c', 7, 'New served text.'), use('c', 7), result('c', 8),
    delivery('checkpoint-and-compaction-policy-at-act.md', '', 9, 'Checkpoint text.'), row('user', 10, { message: { content: 'checkpoint please' } }),
    row('assistant', 11, { message: { content: [{ type: 'text', text: 'Checkpoint saved.' }] } })];
  await writeFile(session, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(subagents, 'agent-reader.jsonl'), [delivery('executor-delegation-briefs-read-only.md', 's', 1, 'Subagent text.'), use('s', 2), result('s', 3)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, projects, session, rules };
}
const lines = async (path) => {
  if ((await stat(path)).isDirectory()) {
    const runs = (await readdir(path)).sort();
    path = join(path, runs.at(-1), (await readdir(join(path, runs.at(-1))))[0]);
  }
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
};

test('extract uses served text and shared triggers across gaps and compactions, subagents and prompt answers', async (t) => {
  const f = await fixture(t); const out = join(f.root, 'cases.jsonl');
  const run = spawnSync(process.execPath, [script, 'extract', '--projects-dir', f.projects, '--rules-dir', f.rules, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const cases = await lines(out);
  assert.equal(cases.length, 4);
  const first = cases.find((c) => c.serveLine === 2);
  assert.equal(first.ruleText, 'Served read-only text.');
  assert.equal(first.governedActs, 2);
  assert.match(first.excerpt, /compaction/);
  assert.match(first.excerpt, /line 7/);
  assert.equal(first.facts.agents[0].tools[0], 'Read');
  assert.ok(first.truncated);
  assert.equal(cases.find((c) => c.serveLine === 9).governedActs, 1);
  assert.ok(cases.some((c) => c.transcriptPath.includes('subagents')));
  assert.match(cases.find((c) => c.rule.startsWith('checkpoint')).excerpt, /Checkpoint saved/);
});

test('unmatched verdict rows are reported, and duplicate refusal and attachment delivery is one case', async (t) => {
  const f = await fixture(t); const input = join(f.root, 'verdicts.jsonl'); const out = join(f.root, 'cases.jsonl');
  await writeFile(input, [JSON.stringify({ rule: 'executor-delegation-briefs-read-only.md', sessionId: 'session', agentId: 'main', injectedAt: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString() }), JSON.stringify({ rule: 'absent.md', sessionId: 'session', injectedAt: '2026-01-01' })].join('\n'));
  const run = spawnSync(process.execPath, [script, 'extract', '--transcript', f.session, '--rules-dir', f.rules, '--from-verdicts', input, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await lines(out)).length, 1);
  assert.match(run.stderr, /absent.md.*no matching serve/);
});

test('a refusal serve includes its preceding triggering call and deduplicates the echoed attachment', async (t) => {
  const f = await fixture(t); const out = join(f.root, 'refusal-cases.jsonl');
  const refusal = 'wt-rules-on-demand: read the rule below before this action\n<rule name="executor-delegation-briefs-read-only.md">Refusal text.</rule>';
  const records = [use('refused', 0), result('refused', 1, refusal), delivery('executor-delegation-briefs-read-only.md', 'refused', 2, 'Refusal text.'), use('retry', 3)];
  await writeFile(f.session, records.map(JSON.stringify).join('\n') + '\n');
  const run = spawnSync(process.execPath, [script, 'extract', '--transcript', f.session, '--rules-dir', f.rules, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const cases = await lines(out);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].governedActs, 2, 'the call that caused the refusal is governed even though it precedes delivery');
  assert.match(cases[0].excerpt, /refused/);
});

test('judge resumes from a prior file into a new file and never code-decides not applicable', async (t) => {
  const f = await fixture(t); const casesFile = join(f.root, 'cases.jsonl'); const out = join(f.root, 'judge.jsonl');
  await writeFile(casesFile, [JSON.stringify({ caseId: 'one', rule: 'a.md', ruleText: 'Do A', excerpt: 'act', facts: {}, governedActs: 1, triggerState: 'known' }), JSON.stringify({ caseId: 'two', rule: 'a.md', ruleText: 'Do A', excerpt: '', facts: {}, governedActs: 0, triggerState: 'known' })].join('\n') + '\n');
  const { judgeCases } = await import('../scripts/judge-cases.mjs');
  let calls = 0;
  const runner = async () => { calls++; return { answer: 'FOLLOWED', model: 'reported-model' }; };
  const first = await judgeCases({ casesFile, out, model: 'requested-model', concurrency: 2, runner });
  const second = await judgeCases({ casesFile, out, previous: first.path, model: 'requested-model', concurrency: 2, runner });
  assert.equal(calls, 1);
  assert.equal(second.skipped, 2);
  const judged = await lines(first.path);
  assert.equal(judged.length, 2);
  assert.equal(judged.find((row) => row.caseId === 'one').verdict, 'undecidable');
  assert.equal(judged.find((row) => row.caseId === 'one').model, 'reported-model');
  assert.equal(judged.find((row) => row.caseId === 'two').verdict, 'undecidable');
  assert.equal(judged.find((row) => row.caseId === 'two').decidedBy, 'code');
});

test('headless CLI runner refuses missing isolation flags advertised by its own help', async (t) => {
  if (process.platform === 'win32') return t.skip('executable fixture uses a POSIX shebang');
  const f = await fixture(t); const fake = join(f.root, 'fake-cli');
  await writeFile(fake, '#!/usr/bin/env node\nprocess.stdout.write("-p --model --tools");\n'); await chmod(fake, 0o755);
  const { cliRunner } = await import('../scripts/judge-cases.mjs');
  await assert.rejects(() => cliRunner('case', 'haiku', { binary: fake }), /--help does not advertise --output-format/);
});

test('headless runner clears inherited function hooks and reports the CLI model id', async (t) => {
  if (process.platform === 'win32') return t.skip('executable fixture uses a POSIX shebang');
  const f = await fixture(t); const fake = join(f.root, 'fake-judge');
  await writeFile(fake, `#!/usr/bin/env node
if (process.argv.includes('--help')) process.stdout.write('-p --output-format --model --tools --setting-sources --strict-mcp-config --mcp-config --settings --no-session-persistence');
else process.stdout.write(JSON.stringify({ result: JSON.stringify({ verdict: 'followed', reason: process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS }), modelUsage: { 'reported-id': {} } }));
`); await chmod(fake, 0o755);
  const { cliRunner } = await import('../scripts/judge-cases.mjs');
  const previous = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
  process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1';
  try {
    const result = await cliRunner('case', 'haiku', { binary: fake });
    assert.equal(JSON.parse(result.answer).reason, undefined, 'no inherited function hooks may run in the judge');
    assert.equal(result.model, 'reported-id');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
    else process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = previous;
  }
});

test('score counts agree/disagree and class denominators', async (t) => {
  const f = await fixture(t); const judges = join(f.root, 'judges.jsonl'); const labels = join(f.root, 'labels.jsonl');
  await writeFile(judges, ['a', 'b'].map((caseId) => JSON.stringify({ caseId, rule: 'a.md', verdict: 'followed' })).join('\n'));
  await writeFile(labels, [['a', 'followed', 'first'], ['a', 'followed', 'second'], ['b', 'followed', 'first'], ['b', 'not followed', 'second']].map(([caseId, label, labeller]) => JSON.stringify({ caseId, label, labeller })).join('\n'));
  const run = spawnSync(process.execPath, [script, 'score', '--judges', judges, '--labels', labels], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /disagree.*b/si);
  assert.match(run.stdout, /small/);
  assert.match(run.stdout, /precision.*recall/si);
});

test('score refuses mixed model runs that duplicate a case', async (t) => {
  const f = await fixture(t); const judges = join(f.root, 'judges.jsonl'); const labels = join(f.root, 'labels.jsonl');
  await writeFile(judges, [JSON.stringify({ caseId: 'a', rule: 'a.md', verdict: 'followed' }), JSON.stringify({ caseId: 'a', rule: 'a.md', verdict: 'not followed' })].join('\n'));
  await writeFile(labels, [JSON.stringify({ caseId: 'a', label: 'followed', labeller: 'one' }), JSON.stringify({ caseId: 'a', label: 'followed', labeller: 'two' })].join('\n'));
  const run = spawnSync(process.execPath, [script, 'score', '--judges', judges, '--labels', labels], { encoding: 'utf8' });
  assert.equal(run.status, 1, 'duplicate predictions would inflate labelled case counts');
  assert.match(run.stderr, /duplicate judge case/);
});

test('judge data cannot change rollback in either mode', async (t) => {
  const f = await fixture(t); const config = join(f.root, 'config'); const data = join(config, 'plugins', 'data', 'wt-rules-on-demand', 'judge');
  const projectRules = join(f.root, '.claude', 'rules-on-demand'); const store = join(f.root, 'store.json'); const verdicts = join(f.root, 'scan.jsonl');
  await Promise.all([mkdir(data, { recursive: true }), mkdir(projectRules, { recursive: true })]);
  await writeFile(join(projectRules, 'a.md'), toolRule);
  await writeFile(join(f.root, '.claude', 'rules-on-demand-ledger.jsonl'), JSON.stringify({ action: 'migrate', rule: 'a.md', time: '2020-01-01T00:00:00Z' }) + '\n');
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': '' }));
  await writeFile(verdicts, Array.from({ length: 10 }, (_, i) => JSON.stringify({ rule: 'a.md', scope: 'project', rulesDir: projectRules,
    phase: 'before', checkVerdict: 'followed', verdict: 'static baseline', at: `2019-01-01T00:00:${String(i).padStart(2, '0')}Z` })).join('\n') + '\n');
  const run = (mechanical) => spawnSync(process.execPath, [rollback, '--project', f.root, '--store', store, '--verdicts', verdicts, '--dry-run', '--json', ...(mechanical ? ['--mechanical-only'] : [])], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  for (const mechanical of [false, true]) {
    const before = run(mechanical); assert.equal(before.status, 0, before.stderr);
    const rows = Array.from({ length: 10 }, (_, i) => ({ caseId: String(i), rule: 'a.md', ruleIdentity: `project:${projectRules}:a.md`, verdict: 'not followed', decidedAt: '2026-01-01T00:00:00Z' }));
    await writeFile(join(data, 'judge.jsonl'), rows.map(JSON.stringify).join('\n'));
    const after = run(mechanical); assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout, `rollback changed with judge file in ${mechanical ? 'mechanical' : 'manual'} mode`);
    if (!mechanical) {
      await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': rows.map(JSON.stringify).join('\n') }));
      const poisoned = run(false); assert.equal(poisoned.status, 0, poisoned.stderr);
      assert.notEqual(poisoned.stdout, before.stdout, 'isolation proof must fail if judge rows enter the compliance store');
      await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': '' }));
    }
  }
});

test('judge output refuses a compliance archive path even when explicitly named', async (t) => {
  const f = await fixture(t); const { judgeCases } = await import('../scripts/judge-cases.mjs');
  const casesFile = join(f.root, 'cases.jsonl');
  await writeFile(casesFile, JSON.stringify({ caseId: 'none', rule: 'a.md', governedActs: 0 }) + '\n');
  const archive = join(f.root, 'quality', 'compliance-verdicts-archive-1-2.jsonl');
  await mkdir(join(f.root, 'quality')); await writeFile(archive, 'original\n');
  await assert.rejects(() => judgeCases({ casesFile, out: archive, runner: async () => { throw new Error('should not call'); } }), /^Error: judge output component matches rollback input name$/);
  assert.equal(await readFile(archive, 'utf8'), 'original\n');
});
