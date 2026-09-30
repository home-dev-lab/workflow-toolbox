import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, rm, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractCases } from '../scripts/judge-extract.mjs';
import { judgeCases, scoreCases } from '../scripts/judge-cases.mjs';
import { RULE_CAP } from '../hooks/evidence.js';
import { openNewJudgeFile } from '../scripts/judge-output.mjs';

const source = (kind = 'tool', name = 'Agent') => {
  const head = kind === 'tool' ? `tool: '^${name}$'\n      unconditional: true` : "regex: 'checkpoint'";
  return `---\non-demand:\n  triggers:\n    - kind: ${kind}\n      ${head}\n---\nDo it.`;
};
async function fixture(t, records, rule = source()) {
  const root = await mkdtemp(join(tmpdir(), 'judge-structural-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rules = join(root, 'rules'), transcript = join(root, 'session.jsonl');
  await mkdir(rules); await writeFile(join(rules, 'r.md'), rule);
  await writeFile(transcript, records.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return { root, rules, transcript, out: join(root, 'output'), casesFile: join(root, 'cases.jsonl') };
}
const serve = (id, text = 'Do it.') => ({ type: 'attachment', timestamp: '2026-01-01T00:00:00Z', attachment: { type: 'hook_additional_context', ...(id ? { toolUseID: `${id}-context` } : {}), content: `<rule name="r.md">${text}</rule>` } });
const call = (...ids) => ({ type: 'assistant', message: { content: ids.map((id) => ({ type: 'tool_use', id, name: 'Agent', input: {} })) } });
const result = (...ids) => ({ type: 'user', message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: `result ${id}` })) } });
const extract = (f) => extractCases({ transcripts: [f.transcript], rulesDirs: [f.rules], configDir: f.root });
const readRows = async (path) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);

test('parallel serves and refusals never guess ownership or merge different bodies', async (t) => {
  const f = await fixture(t, [call('a', 'b'), serve('a'), result('a'), serve('b', 'Different.'), result('b')]);
  const cases = await extract(f);
  assert.equal(cases.length, 2);
  assert.equal(new Set(cases.map((c) => c.caseId)).size, 2);
  assert.deepEqual(cases.map((c) => c.ruleText), ['Do it.', 'Different.']);
  assert.ok(cases.every((c) => c.triggerState === 'unknown'));
  const refusal = (id, body) => ({ type: 'tool_result', tool_use_id: id, content: `wt-rules-on-demand: read the rule below before this action\n<rule name="r.md">${body}</rule>` });
  await writeFile(f.transcript, [call('a', 'b'), { type: 'user', message: { content: [refusal('a', 'A'), refusal('b', 'B')] } }].map(JSON.stringify).join('\n'));
  const refused = await extract(f);
  assert.equal(refused.length, 2);
  assert.deepEqual(refused.map((c) => c.ruleText), ['A', 'B']);
  assert.equal(new Set(refused.map((c) => c.caseId)).size, 2);
  assert.ok(refused.every((c) => c.triggerState === 'unknown'));
});

test('id-less attachments remain separate; results outside scope and malformed lines mark uncertainty', async (t) => {
  const f = await fixture(t, [call('a'), result('a'), { type: 'user', message: { content: 'checkpoint first' } }, serve(''), { type: 'assistant', message: { content: 'Checkpoint done.' } }, { type: 'user', message: { content: 'checkpoint second' } }, serve(''), { type: 'assistant', message: { content: 'Checkpoint again.' } }], source('prompt'));
  const cases = await extract(f);
  assert.equal(cases.length, 2);
  assert.equal(new Set(cases.map((c) => c.caseId)).size, 2);
  assert.ok(cases.every((c) => c.triggerState === 'unknown'));
  await writeFile(join(f.rules, 'r.md'), source());
  await writeFile(f.transcript, [serve('a'), call('a'), call('b'), serve('b'), result('a', 'b')].map(JSON.stringify).join('\n'));
  const parallel = await extract(f);
  assert.equal(parallel[0].triggerState, 'unknown');
  assert.match(parallel[0].triggerReason, /result|scope|ambiguous/i);
  await writeFile(f.transcript, `${JSON.stringify(serve('a'))}\n{bad json\n`);
  assert.match((await extract(f))[0].triggerReason, /malformed/i);
});

test('empty truncated excerpts and missing counts never become negative code verdicts', async (t) => {
  const huge = { type: 'assistant', message: { content: Array.from({ length: 12 }, (_, i) => ({ type: 'tool_use', id: String(i), name: 'Agent', input: { prompt: 'x'.repeat(1400) } })) } };
  const f = await fixture(t, [serve(''), huge]);
  const [item] = await extract(f);
  assert.ok(item.truncated);
  assert.ok(item.droppedActs > 0);
  await writeFile(f.casesFile, [item, { caseId: 'known', rule: 'r.md', ruleText: 'Do it.', excerpt: 'act', facts: {}, governedActs: 1, triggerState: 'known', truncated: true, droppedActs: 2 }, { caseId: 'missing', rule: 'r.md', ruleText: 'Do it.', excerpt: 'act', facts: {}, triggerState: 'known' }].map(JSON.stringify).join('\n'));
  let prompt = '';
  const run = await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async (value) => { prompt = value; return { answer: '{"verdict":"followed","reason":"ok"}' }; } });
  const judged = await readRows(run.path);
  assert.equal(judged.find((r) => r.caseId === 'missing').verdict, 'undecidable');
  if (!item.excerpt.trim()) assert.equal(judged[0].verdict, 'undecidable');
  else assert.match(prompt, /droppedActs|truncated/);
  assert.ok(judged.every((r) => r.verdict !== 'not applicable'));
});

test('extract reports scanner gap and keeps deleted rule as unknown', async (t) => {
  const text = 'wt-rules-on-demand: read the rule below before this action\n' + 'x'.repeat(RULE_CAP + 5) + '<rule name="r.md">Do it.</rule>';
  const f = await fixture(t, [call('a'), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: text }] } }]);
  const cases = await extract(f);
  assert.equal(cases.length, 1);
  await rm(join(f.rules, 'r.md'));
  assert.match((await extract(f))[0].triggerReason, /current.*not found|missing/i);
});

test('judge and extract create exclusive output files, preserving rollback inputs and decisions', async (t) => {
  const f = await fixture(t, []), store = join(f.root, 'store.json'), archive = join(f.root, 'archive.jsonl');
  await writeFile(store, '{"caseId":"old","promptHash":"old","compliance-verdicts-jsonl":""}');
  await writeFile(archive, '{"rule":"r.md"}\n');
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: '', facts: {}, governedActs: 0 }) + '\n');
  const projectRules = join(f.root, '.claude', 'rules-on-demand'); await mkdir(projectRules, { recursive: true });
  await writeFile(join(projectRules, 'r.md'), source());
  const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
  const decide = (mechanical) => spawnSync(process.execPath, [rollback, '--project', f.root, '--store', store, '--verdicts', archive, '--dry-run', '--json', ...(mechanical ? ['--mechanical-only'] : [])], { encoding: 'utf8' });
  const before = [decide(false), decide(true)].map((r) => { assert.equal(r.status, 0, r.stderr); return r.stdout; });
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: store }), /directory|output|judge/i);
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: archive }), /directory|output|judge/i);
  await symlink(store, f.out);
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: f.out }), /symlink/i);
  await rm(f.out);
  await mkdir(f.out);
  const run = await judgeCases({ casesFile: f.casesFile, out: f.out });
  assert.equal((await readRows(run.path)).length, 1);
  assert.equal(await readFile(store, 'utf8'), '{"caseId":"old","promptHash":"old","compliance-verdicts-jsonl":""}');
  assert.equal(await readFile(archive, 'utf8'), '{"rule":"r.md"}\n');
  assert.deepEqual([decide(false).stdout, decide(true).stdout], before);
  const second = await judgeCases({ casesFile: f.casesFile, out: f.out, previous: run.path });
  assert.equal(second.skipped, 1);
  assert.notEqual(second.path, run.path);
  assert.deepEqual(await readdir(f.out).then((names) => names.length), 2);
});

test('decoded duplicate response keys invalidate the model response', async (t) => {
  const f = await fixture(t, []);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: 'act', facts: {}, governedActs: 1, triggerState: 'known' }) + '\n');
  const run = await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => ({ answer: '{"verdict":"not followed","verdi\\u0063t":"followed","reason":"ok"}' }) });
  assert.equal((await readRows(run.path))[0].verdict, 'undecidable');
});

test('one singly labelled case without a prediction is reported missing', async (t) => {
  const f = await fixture(t, []), labels = join(f.root, 'labels.jsonl');
  await writeFile(f.out, JSON.stringify({ caseId: 'a', rule: 'r.md', verdict: 'followed' }) + '\n');
  await writeFile(labels, JSON.stringify({ caseId: 'b', rule: 'r.md', label: 'followed', labeller: 'one' }));
  assert.match(await scoreCases(f.out, [labels]), /1 labelled cases without a judge row/);
});

test('extract --out cannot overwrite a store or traverse a symlink or lexical parent alias', async (t) => {
  const f = await fixture(t, [serve('a'), call('a')]);
  const script = fileURLToPath(new URL('../scripts/judge-cases.mjs', import.meta.url));
  const store = join(f.root, 'store.json'), archive = join(f.root, 'archive.jsonl'), alias = join(f.root, 'alias');
  await writeFile(store, '{"compliance-verdicts-jsonl":""}');
  await writeFile(archive, 'archive\n');
  await symlink(f.root, alias);
  const run = (out) => spawnSync(process.execPath, [script, 'extract', '--transcript', f.transcript, '--rules-dir', f.rules, '--out', out], { encoding: 'utf8' });
  for (const out of [store, archive, alias, `${alias}/../output`]) assert.equal(run(out).status, 1);
  assert.equal(await readFile(store, 'utf8'), '{"compliance-verdicts-jsonl":""}');
  assert.equal(await readFile(archive, 'utf8'), 'archive\n');
  const extracted = run(f.out);
  assert.equal(extracted.status, 0);
  assert.match(extracted.stdout, /1 raw served blocks, 0 not produced as cases/);
  const output = await readdir(f.out);
  assert.equal(output.length, 1);
  assert.equal((await readRows(join(f.out, output[0], 'cases.jsonl'))).length, 1);
});

test('string answers are represented and malformed records in scope fail closed', async (t) => {
  const f = await fixture(t, [{ type: 'user', message: { content: 'checkpoint now' } }, serve(''), { type: 'assistant', message: { content: 'Checkpoint done.' } }], source('prompt'));
  const [item] = await extract(f);
  assert.equal(item.governedActs, 1);
  assert.match(item.excerpt, /Checkpoint done/);
  await writeFile(f.transcript, `${JSON.stringify(serve('a'))}\n{unparseable\n${JSON.stringify(call('a'))}\n`);
  assert.match((await extract(f))[0].triggerReason, /malformed/);
});

test('agent tools are known only for bare flat names and block list stops at next field', async (t) => {
  const f = await fixture(t, [], source());
  const name = 'executor-delegation-briefs-read-only.md';
  await writeFile(join(f.rules, name), source());
  await writeFile(f.transcript, [JSON.stringify({ ...serve('a'), attachment: { ...serve('a').attachment, content: `<rule name="${name}">Do it.</rule>` } }), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { subagent_type: 'reader' } }] } })].join('\n'));
  const agents = join(f.root, 'agents'); await mkdir(agents);
  const path = join(agents, 'reader.md');
  for (const text of ['tools: [Read, [Bash]]', 'tools:\n  - "Read"\n  - Glob # comment']) {
    await writeFile(path, `---\n${text}\n---\n`);
    assert.equal((await extract(f))[0].facts.agents[0].tools, 'unknown');
  }
  await writeFile(path, '---\ntools:\n  - Read\n  - Glob\nmodel: haiku\n---\n');
  assert.deepEqual((await extract(f))[0].facts.agents[0].tools, ['Read', 'Glob']);
});

test('swapping a run directory during the model call cannot redirect its open output to rollback input', async (t) => {
  const f = await fixture(t, []);
  const victim = join(f.root, 'victim'); await mkdir(victim);
  const store = join(victim, 'judgments.jsonl');
  const bytes = '{"compliance-verdicts-jsonl":""}';
  await writeFile(store, bytes);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', ruleText: 'Do it.', excerpt: 'tool call Agent a', facts: {}, governedActs: 1, triggerState: 'known' }) + '\n');
  const moved = join(f.root, 'moved');
  const run = await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => {
    const [runName] = await readdir(f.out);
    if (process.platform === 'win32') {
      await assert.rejects(() => rename(join(f.out, runName), moved), (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code));
      return { answer: '{"verdict":"not followed","reason":"ok"}' };
    }
    await rename(join(f.out, runName), moved);
    await symlink(victim, join(f.out, runName));
    return { answer: '{"verdict":"not followed","reason":"ok"}' };
  } });
  assert.equal(await readFile(store, 'utf8'), bytes);
  if (process.platform === 'win32') {
    assert.equal((await readRows(run.path))[0].verdict, 'not followed');
    return;
  }
  assert.equal((await readRows(join(moved, 'judgments.jsonl')))[0].verdict, 'not followed');
  assert.notEqual(run.path, join(moved, 'judgments.jsonl'));
});

test('historical trigger provenance stays provisional but nonempty, owned evidence reaches the model', async (t) => {
  const f = await fixture(t, [serve('a'), call('a'), result('a')]);
  const [item] = await extract(f);
  assert.equal(item.triggerState, 'unknown');
  assert.ok(item.governedActs > 0);
  await writeFile(f.casesFile, JSON.stringify(item));
  let prompt;
  const output = await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async (text) => {
    prompt = text;
    return { answer: '{"verdict":"undecidable","reason":"trigger provenance unclear"}' };
  } });
  assert.match(prompt, /historical trigger|trigger provenance/i);
  assert.match(prompt, /tool call Agent a/);
  assert.equal((await readRows(output.path))[0].decidedBy, undefined);
});

test('resuming an unterminated prior JSONL file never concatenates or changes the prior bytes', async (t) => {
  const f = await fixture(t, []);
  const prior = join(f.root, 'previous.jsonl');
  const original = '{"caseId":"old","promptHash":"old"}';
  await writeFile(prior, original);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'new', rule: 'r.md', governedActs: 0 }) + '\n');
  const output = await judgeCases({ casesFile: f.casesFile, out: f.out, previous: prior });
  assert.equal(await readFile(prior, 'utf8'), original);
  assert.deepEqual((await readRows(output.path)).map((row) => row.caseId), ['new']);
});

test('an existing file at the exact output name is refused without changing its bytes', async (t) => {
  const f = await fixture(t, []);
  const existing = join(f.root, 'judgments.jsonl');
  const bytes = 'existing rollback input\n';
  await writeFile(existing, bytes);
  await assert.rejects(() => openNewJudgeFile(f.root, 'judgments.jsonl'), { code: 'EEXIST' });
  assert.equal(await readFile(existing, 'utf8'), bytes);
});

test('owned excerpts alone cannot bypass overlapping serves or id-less attachment ownership', async (t) => {
  const f = await fixture(t, []);
  const git = (...args) => {
    // The fixture requires the installed git binary to create readable history in its temporary repo.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const run = spawnSync('git', ['-C', f.rules, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z' } });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q'); git('add', 'r.md'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'rule');
  for (const [label, records, reason] of [
    ['overlap', [call('a', 'b'), serve('a'), serve('b'), result('a', 'b')], /ambiguous overlapping serves/],
    ['id-less', [serve(''), call('a'), result('a')], /id-less attachment owner ambiguous/]
  ]) {
    await t.test(label, async () => {
      await writeFile(f.transcript, records.map(JSON.stringify).join('\n') + '\n');
      const cases = await extract(f);
      assert.ok(cases.length > 0, label);
      assert.ok(cases.every((item) => item.governedActs > 0 && item.excerpt.trim() && item.triggerSource.startsWith('git ')), label);
      await writeFile(f.casesFile, cases.map(JSON.stringify).join('\n') + '\n');
      const run = await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => { throw new Error(`${label} must not reach runner`); } });
      assert.ok((await readRows(run.path)).every((row) => row.verdict === 'undecidable' && row.decidedBy === 'code' && reason.test(row.reason)), label);
    });
  }
});

test('otherwise eligible empty or whitespace evidence never reaches the runner', async (t) => {
  const f = await fixture(t, []);
  await writeFile(f.casesFile, ['', ' \t\n '].map((excerpt, index) => JSON.stringify({ caseId: `empty-${index}`, rule: 'r.md', ruleText: 'Do it.', excerpt, facts: {}, governedActs: 1, triggerState: 'known' })).join('\n') + '\n');
  const run = await judgeCases({ casesFile: f.casesFile, out: f.out, runner: async () => { throw new Error('empty evidence must not reach runner'); } });
  assert.deepEqual((await readRows(run.path)).map((row) => [row.verdict, row.decidedBy]), [['undecidable', 'code'], ['undecidable', 'code']]);
});

test('judge and extract refuse every rollback store and archive output namespace before creation', async (t) => {
  const f = await fixture(t, [call('a'), serve('a'), result('a')]);
  const storeDir = join(f.root, 'plugins', 'store');
  const archiveDir = join(f.root, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  await mkdir(storeDir, { recursive: true }); await mkdir(archiveDir, { recursive: true });
  const store = join(storeDir, 'wt-rules-on-demand_existing.json');
  const archive = join(archiveDir, 'compliance-verdicts-archive-1-2.jsonl');
  const existingArchive = join(archiveDir, 'compliance-verdicts-archive-3-4.jsonl');
  const bytes = '{"sessions":{},"compliance-verdicts-jsonl":""}\n';
  await writeFile(store, bytes);
  const archiveBytes = '{"rule":"r.md","verdict":"followed"}\n';
  await writeFile(existingArchive, archiveBytes);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', governedActs: 0 }) + '\n');
  const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
  const check = () => spawnSync(process.execPath, [rollback, '--config-dir', f.root, '--user', '--project', f.root, '--dry-run', '--json'], { encoding: 'utf8' });
  const userRules = join(f.root, 'rules-on-demand'); await mkdir(userRules); await writeFile(join(userRules, 'r.md'), source());
  const before = check(); assert.equal(before.status, 0, before.stderr);
  const script = fileURLToPath(new URL('../scripts/judge-cases.mjs', import.meta.url));
  for (const out of [storeDir, join(storeDir, 'wt-rules-on-demand_new.json'), join(storeDir, 'nested', 'other'), archiveDir, archive, existingArchive, join(archiveDir, 'nested', 'other')]) {
    await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: f.root }), /rollback input/i, out);
    const extracted = spawnSync(process.execPath, [script, 'extract', '--transcript', f.transcript, '--rules-dir', f.rules, '--config-dir', f.root, '--out', out], { encoding: 'utf8' });
    assert.equal(extracted.status, 1, `${out}: ${extracted.stderr}`);
    assert.match(extracted.stderr, /rollback input/i);
    if (out !== storeDir && out !== archiveDir && out !== existingArchive) await assert.rejects(() => stat(out), { code: 'ENOENT' });
    const after = check(); assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
    assert.equal(await readFile(store, 'utf8'), bytes);
    assert.equal(await readFile(existingArchive, 'utf8'), archiveBytes);
  }
  const alias = join(f.root, 'config-alias'); await symlink(f.root, alias);
  await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out: archive, rollbackConfigDir: alias }), /rollback input/i);
});

test('another config rollback store and archive cannot be judge or extract output', async (t) => {
  const f = await fixture(t, []);
  const selected = join(f.root, 'selected'), other = join(f.root, 'other');
  const storeDir = join(other, 'plugins', 'store');
  const archiveDir = join(other, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  await mkdir(storeDir, { recursive: true }); await mkdir(archiveDir, { recursive: true });
  const store = join(storeDir, 'wt-rules-on-demand_existing.json');
  const archive = join(archiveDir, 'compliance-verdicts-archive-1-2.jsonl');
  const storeBytes = '{"sessions":{},"compliance-verdicts-jsonl":""}\n';
  const archiveBytes = '{"rule":"r.md","verdict":"followed"}\n';
  await writeFile(store, storeBytes); await writeFile(archive, archiveBytes);
  const userRules = join(other, 'rules-on-demand'); await mkdir(userRules); await writeFile(join(userRules, 'r.md'), source());
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', governedActs: 0 }) + '\n');
  const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
  const check = () => spawnSync(process.execPath, [rollback, '--config-dir', other, '--user', '--project', f.root, '--dry-run', '--json'], { encoding: 'utf8' });
  const before = check(); assert.equal(before.status, 0, before.stderr);
  const script = fileURLToPath(new URL('../scripts/judge-cases.mjs', import.meta.url));
  for (const out of [join(storeDir, 'plain'), join(storeDir, 'wt-rules-on-demand_new.json'), join(archiveDir, 'plain'), join(archiveDir, 'compliance-verdicts-archive-3-4.jsonl')]) {
    await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: selected }), /rollback input/i, out);
    const extracted = spawnSync(process.execPath, [script, 'extract', '--transcript', f.transcript, '--rules-dir', f.rules, '--config-dir', selected, '--out', out], { encoding: 'utf8' });
    assert.equal(extracted.status, 1, `${out}: ${extracted.stderr}`);
    assert.match(extracted.stderr, /rollback input/i);
    await assert.rejects(() => stat(out), { code: 'ENOENT' });
    const after = check(); assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, before.stdout);
    assert.equal(await readFile(store, 'utf8'), storeBytes);
    assert.equal(await readFile(archive, 'utf8'), archiveBytes);
  }
});

test('rollback input names in any output component are refused before creation', async (t) => {
  const f = await fixture(t, []);
  await writeFile(f.casesFile, JSON.stringify({ caseId: 'a', rule: 'r.md', governedActs: 0 }) + '\n');
  const script = fileURLToPath(new URL('../scripts/judge-cases.mjs', import.meta.url));
  for (const name of ['wt-rules-on-demand_new.json', 'compliance-verdicts-archive-1-2.jsonl']) {
    const out = join(f.root, 'outside', name, 'nested');
    await assert.rejects(() => judgeCases({ casesFile: f.casesFile, out, rollbackConfigDir: join(f.root, 'selected') }), /rollback input/i, out);
    const extracted = spawnSync(process.execPath, [script, 'extract', '--transcript', f.transcript, '--rules-dir', f.rules, '--config-dir', join(f.root, 'selected'), '--out', out], { encoding: 'utf8' });
    assert.equal(extracted.status, 1, `${out}: ${extracted.stderr}`);
    assert.match(extracted.stderr, /rollback input/i);
    await assert.rejects(() => stat(join(f.root, 'outside')), { code: 'ENOENT' });
  }
});
