import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreCases } from '../scripts/judge-cases.mjs';

async function scored(t, pairs) {
  const root = await mkdtemp(join(tmpdir(), 'judge-score-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const judges = join(root, 'judges.jsonl'), labels = join(root, 'labels.jsonl');
  await writeFile(judges, pairs.map(([caseId, , verdict]) => JSON.stringify({ caseId, rule: 'a.md', verdict })).join('\n'));
  await writeFile(labels, pairs.flatMap(([caseId, label]) => ['one', 'two'].map((labeller) => JSON.stringify({ caseId, label, labeller }))).join('\n'));
  return scoreCases(judges, [labels]);
}

test('score reports the violation-detector view, where followed and not applicable are both no violation', async (t) => {
  const report = await scored(t, [['a', 'not applicable', 'followed'], ['b', 'not applicable', 'not followed'],
    ['c', 'not followed', 'not followed'], ['d', 'followed', 'undecidable']]);
  const overall = report.split('\n').find((line) => /^\s+violation detector/.test(line));
  assert.ok(overall, report);
  assert.match(overall, /violation precision 1\/2 = 50\.0% \(small\)/);
  assert.match(overall, /violation recall 1\/1 = 100\.0% \(small\)/);
  assert.match(overall, /no-violation precision 1\/1 = 100\.0% \(small\)/);
  assert.match(overall, /decided 3\/4 = 75\.0% \(small\) of agreed determinate cases/);
});

test('an undecidable truth is left out of the decided rate', async (t) => {
  const report = await scored(t, [['a', 'undecidable', 'followed'], ['b', 'followed', 'followed']]);
  assert.match(report, /decided 1\/1 = 100\.0% \(small\) of agreed determinate cases/);
});
