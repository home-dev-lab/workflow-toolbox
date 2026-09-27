import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, CHECKS, checkLines } from '../hooks/act-checks.js';
import { maskReadOnlyMentions } from '../hooks/bash-mention.js';

test('generic checks only and shell gate background', () => {
  assert.deepEqual(CHECKS, ['agent-model', 'gate-background']);
  assert.equal(classify('Agent', { prompt: 'work' }).verdict, 'VIOLATED');
  assert.equal(classify('Agent', { model: 'sonnet' }).verdict, 'FOLLOWED');
  assert.equal(classify('Bash', { command: 'pnpm test' })[0].verdict, 'VIOLATED');
  assert.equal(classify('Bash', { command: 'pnpm test', run_in_background: true })[0].verdict, 'FOLLOWED');
});
test('read-only mentions cannot trigger an executable command', () => {
  assert.doesNotMatch(maskReadOnlyMentions('rg "git push" docs'), /git push/);
  assert.match(maskReadOnlyMentions('git push origin main'), /git push/);
});
test('refusal result is recorded as refused rather than a governed act', () => {
  const refusal = 'wt-rules-on-demand: read the rule below before this action';
  const rows = [
    { kind: 'use', id: 'fixture-use', name: 'Agent', input: {} },
    { kind: 'result', id: 'fixture-use', text: refusal },
  ];
  assert.equal(checkLines(rows)[0].verdict, 'refused');
});
