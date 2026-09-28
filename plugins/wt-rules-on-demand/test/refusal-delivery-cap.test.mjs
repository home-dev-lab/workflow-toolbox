import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, resolveContext, judge } from '../scripts/transcript-verdicts.mjs';
import { SUBJECT_CAP } from '../hooks/evidence.js';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';

const ruleText = (trigger, compliance) => `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nFollow this rule.\n`;
const toolTrigger = '    - kind: tool\n      tool: ^Agent$\n      unconditional: true';

test('late refusal blocks count as delivery without widening stored result evidence', () => {
  const time = new Date().toISOString();
  const text = `wt-rules-on-demand: read the rule below before this action\n<rule name="early.md">\nRule.\n</rule>\n${'x'.repeat(23000)}\n<rule name="late.md">\nRule.\n</rule>`;
  const result = normalize({ type: 'user', timestamp: time, message: { content: [{ type: 'tool_result', tool_use_id: 'first', content: text }] } }, 2);
  assert.equal(result[0].text.length, SUBJECT_CAP);
  const parsed = parseRuntimeRule('late.md', ruleText(toolTrigger, '    kind: check\n    check: agent-model'));
  const scope = { scope: 'project', projectRoot: '/project', rulesDir: '/project/.claude/rules-on-demand', rules: [
    { ...parsed, migrated: time, cutoff: Date.parse(time), lastChange: 0 },
    { ...parsed, name: 'early.md', migrated: time, cutoff: Date.parse(time), lastChange: 0 },
  ] };
  const use = { kind: 'use', id: 'second', name: 'Agent', input: {}, line: 3, at: time, sessionId: 'fixture' };
  const context = { cwd: '/project', start: Date.parse(time), events: [...result, use] };
  const stats = { days: 7, coverage: { missingTimestamps: 0 }, skippedOutsideWindow: 0 };
  const rows = judge(context, resolveContext(context, [scope]), 'synthetic.jsonl', stats, new Set(), Date.parse(time) + 1);
  assert.deepEqual(rows.filter((row) => row.rule === 'late.md').map(({ served, verdict }) => [served, verdict]), [[true, 'not followed']], 'late refusal rule must prevent a trigger miss');
});

test('a refusal marker past the stored 16 KiB still excludes the refused call from judgment', () => {
  const time = new Date().toISOString();
  const text = `${'p'.repeat(17000)}\nwt-rules-on-demand: read the rule below before this action\n<rule name="late.md">\nRule.\n</rule>`;
  const result = normalize({ type: 'user', timestamp: time, message: { content: [{ type: 'tool_result', tool_use_id: 'refused', content: text }] } }, 2);
  const parsed = parseRuntimeRule('late.md', ruleText(toolTrigger, '    kind: check\n    check: agent-model'));
  const scope = { scope: 'project', projectRoot: '/project', rulesDir: '/project/.claude/rules-on-demand', rules: [
    { ...parsed, migrated: time, cutoff: Date.parse(time), lastChange: 0 },
  ] };
  const use = { kind: 'use', id: 'refused', name: 'Agent', input: {}, line: 1, at: time, sessionId: 'fixture' };
  const context = { cwd: '/project', start: Date.parse(time), events: [use, ...result] };
  const stats = { days: 7, coverage: { missingTimestamps: 0 }, skippedOutsideWindow: 0 };
  const rows = judge(context, resolveContext(context, [scope]), 'synthetic.jsonl', stats, new Set(), Date.parse(time) + 1);
  assert.equal(result.some((event) => event.kind === 'delivery' && event.name === 'late.md'), true, 'the late block is a delivery');
  assert.deepEqual(rows.filter((row) => row.rule === 'late.md').map(({ verdict }) => verdict), [], 'the refused call is never judged');
});
