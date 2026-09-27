import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { bashCommandVerdict, isGovernedAct } from '../hooks/act-checks.js';
import { correlateTurn, toolInputVerdict } from '../hooks/declarative-checks.js';

const rule = (compliance, trigger = '    - kind: bash\n      regex: run') => parseRuntimeRule('example.md', `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nbody`);

test('tool-input checks bounded arguments and refuses empty required fields', () => {
  const c = rule('    kind: tool-input\n    tool: ^mcp__chat__speak$\n    require-input-regex: \u0027"reply_to"\\s*:\\s*"[^"]+||"mentions"\\s*:\\s*\\[[^\\]]+\u0027\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(toolInputVerdict(c, { tool: 'mcp__chat__speak', input: { reply_to: 'person', mentions: ['other'] } }), 'followed');
  assert.equal(toolInputVerdict(c, { tool: 'mcp__chat__speak', input: { reply_to: '', mentions: [] } }), 'not followed');
});

test('bash-command evaluates each executable segment and exempts matching segments', () => {
  const c = rule('    kind: bash-command\n    act-regex: ^runner\\s+run\\b\n    require-all: --auto||--dir||timeout||< /dev/null\n    exempt-regex: ^lane-run\\b\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(isGovernedAct(c, { tool: 'Bash', command: 'echo ready; runner run --auto' }), true);
  assert.equal(bashCommandVerdict(c, 'runner run --auto; echo --dir timeout < /dev/null'), 'not followed');
  assert.equal(bashCommandVerdict(c, 'lane-run; runner run --auto --dir work timeout 30 < /dev/null'), 'followed');
  const exempt = rule('    kind: bash-command\n    act-regex: ^lane-run\\b\n    require-all: --auto\n    exempt-regex: ^lane-run\\b\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(bashCommandVerdict(exempt, 'lane-run'), 'not applicable');
});

test('turn correlation confirms distinct values, including a shell loop, only at close', () => {
  const c = rule('    kind: turn-correlation\n    tool: ^mcp__board__create_card$\n    id-regex: \u0027"id"\\s*:\\s*"?(\\d{6,})\u0027\n    follow-up-tool: ^mcp__board__add_label$\n    act-regex: add_label\\b\n    value-regex: \u0027labelId\\\\?"\\s*:\\s*\\\\?"?([^"\\s,}]+)\u0027\n    min-distinct: 3\n    window: 1\n    on-close: not applicable').compliance;
  const events = [{ kind: 'use', id: 'a', name: 'mcp__board__create_card', input: {} }, { kind: 'result', id: 'a', text: '{"id":"123456"}' },
    { kind: 'use', id: 'b', name: 'Bash', input: { command: 'for label in red blue green; do lane-run add_label "{\\"cardId\\":\\"123456\\",\\"labelId\\":\\"$label\\"}"; done' } },
    { kind: 'result', id: 'b', text: 'ok' }, { kind: 'turn' }];
  assert.equal(correlateTurn(c, events)[0].verdict, 'followed');
  assert.equal(correlateTurn(c, events.slice(0, -1))[0].verdict, 'unresolved');
});

test('unknown check degrades but trigger still parses, unknown keys still refuse', () => {
  const parsed = rule('    kind: check\n    check: some-private-kind');
  assert.equal(parsed.compliance.reason, 'unregistered check some-private-kind');
  assert.throws(() => rule('    kind: check\n    check: custom\n    typo: yes'), /unknown compliance key/);
});

test('command-head finds wrapped launches but excludes quoted mentions and commit messages', () => {
  const trigger = rule('    kind: none\n    reason: no check', '    - kind: bash\n      regex: ^runner\\s+run\\b\n      command-head: true').triggers[0];
  for (const command of ['timeout 30 env X=1 setsid nohup nice -n 1 exec command stdbuf -oL runner run', 'sh -c "runner run"', 'echo ready; runner run'])
    assert.equal(triggerMatches(trigger, { channel: 'tool', tool: 'Bash', command }), true, command);
  for (const command of ['echo "runner run"', 'git commit -am "runner run"', 'git commit --message="runner run"'])
    assert.equal(triggerMatches(trigger, { channel: 'tool', tool: 'Bash', command }), false, command);
});

test('safe regex accepts disambiguated option alternatives and rejects ambiguous repetitions', () => {
  assert.doesNotThrow(() => rule('    kind: none\n    reason: no check', '    - kind: bash\n      regex: "\\\\b(?:pnpm|npm|yarn)\\\\s+(?:(?:-C|--dir|--filter|-F|--prefix|-w|--workspace)\\\\s+\\\\S+\\\\s+|-r\\\\s+|--recursive\\\\s+)*(?:run\\\\s+)?(?:test|typecheck|lint|build|e2e|check)\\\\b"'));
  for (const source of ['(a+)+', '(?:\\d*)*', '(a|ab)*']) assert.throws(() => rule('    kind: none\n    reason: no check', `    - kind: bash\n      regex: '${source}'`), /regex has/);
});
