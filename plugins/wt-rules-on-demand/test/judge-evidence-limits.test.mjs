import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractCases, ITEM_CHARS } from '../scripts/judge-extract.mjs';
import { judgeCases } from '../scripts/judge-cases.mjs';

const rule = "---\non-demand:\n  triggers:\n    - kind: tool\n      tool: '^Agent$'\n      unconditional: true\n---\nDo it.";
const serve = (id) => ({ type: 'attachment', timestamp: '2026-01-01T00:00:00Z', attachment: { type: 'hook_additional_context', toolUseID: `${id}-context`, content: '<rule name="r.md">Do it.</rule>' } });
const call = (id, prompt) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt } }] } });

async function casesFor(t, records) {
  const root = await mkdtemp(join(tmpdir(), 'judge-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rules = join(root, 'rules'), transcript = join(root, 'session.jsonl');
  await mkdir(rules); await writeFile(join(rules, 'r.md'), rule);
  await writeFile(transcript, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { root, cases: await extractCases({ transcripts: [transcript], rulesDirs: [rules], configDir: root }) };
}

test('one long item cut at the item limit is told apart from an excerpt that hit its budget', async (t) => {
  const { cases } = await casesFor(t, [serve('a'), call('a', 'x'.repeat(ITEM_CHARS + 50))]);
  const [item] = cases;
  assert.equal(item.excerptBudgetHit, false);
  assert.equal(item.itemsCut, 1);
  assert.equal(item.truncated, true, 'truncated keeps meaning "something was cut", for older readers');
});

test('an excerpt that overflows its budget says so, with the dropped acts counted', async (t) => {
  const records = [serve('0'), ...Array.from({ length: 14 }, (_, i) => call(String(i), 'y'.repeat(ITEM_CHARS + 10)))];
  const { cases } = await casesFor(t, records);
  const [item] = cases;
  assert.equal(item.excerptBudgetHit, true);
  assert.ok(item.itemsCut > 0);
  assert.ok(item.droppedActs > 0);
});

test('transcript text that merely contains the cut marker is not counted as a cut item', async (t) => {
  const { cases } = await casesFor(t, [serve('a'), call('a', 'quoting a past excerpt: … [item truncated] and again [item truncated]')]);
  const [item] = cases;
  assert.equal(item.itemsCut, 0);
  assert.equal(item.truncated, false);
});

test('an excerpt with nothing cut reports neither loss', async (t) => {
  const { cases } = await casesFor(t, [serve('a'), call('a', 'short')]);
  const [item] = cases;
  assert.equal(item.excerptBudgetHit, false);
  assert.equal(item.itemsCut, 0);
  assert.equal(item.truncated, false);
});

test('the judge model defaults to sonnet, the tier measured fit to decide', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'judge-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const casesFile = join(root, 'cases.jsonl');
  await writeFile(casesFile, JSON.stringify({ caseId: 'c', rule: 'r.md', ruleText: 'Do it.', excerpt: 'act', facts: {}, governedActs: 1, triggerState: 'known' }) + '\n');
  const asked = [];
  const run = await judgeCases({ casesFile, out: join(root, 'out'), runner: async (prompt, model) => { asked.push(model); return { answer: '{"verdict":"followed","reason":"ok"}', model }; } });
  assert.deepEqual(asked, ['sonnet']);
  const [row] = (await readFile(run.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(row.requestedModel, 'sonnet');
});
