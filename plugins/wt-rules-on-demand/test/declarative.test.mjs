import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { triggerMatches } from '../hooks/trigger-match.js';
import { bashCommandVerdict, isGovernedAct } from '../hooks/act-checks.js';
import { correlateTurn, toolInputVerdict, bashSegments, segmentVerdict } from '../hooks/declarative-checks.js';

const rule = (compliance, trigger = '    - kind: bash\n      regex: run') => parseRuntimeRule('example.md', `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nbody`);

test('tool-input checks bounded arguments and refuses empty required fields', () => {
  const c = rule('    kind: tool-input\n    tool: ^mcp__chat__speak$\n    require-input-regex: \u0027"reply_to"\\s*:\\s*"[^"]+||"mentions"\\s*:\\s*\\[[^\\]]+\u0027\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(toolInputVerdict(c, { tool: 'mcp__chat__speak', input: { reply_to: 'person', mentions: ['other'] } }), 'followed');
  assert.equal(toolInputVerdict(c, { tool: 'mcp__chat__speak', input: { reply_to: '', mentions: [] } }), 'not followed');
});

test('tool-input supports scoped paths, absent keys and forbidden text while preserving ungoverned calls', () => {
  const c = rule('    kind: tool-input\n    tool: ^Write$\n    path-regex: (?:^|/)brief[^/]*\\.md$\n    require-input-regex: lessons for the memory\n    forbid-input-regex: sub-agent allowed\n    absent-input-key: persistent\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(toolInputVerdict(c, { tool: 'Edit', input: { path: '/brief.md' } }), null);
  assert.equal(toolInputVerdict(c, { tool: 'Write', input: { file_path: '/other.md', content: 'no' } }), null);
  assert.equal(toolInputVerdict(c, { tool: 'Write', input: { file_path: '/brief.md', content: 'lessons for the memory' } }), 'followed');
  assert.equal(toolInputVerdict(c, { tool: 'Write', input: { file_path: '/brief.md', content: 'lessons for the memory; sub-agent allowed' } }), 'not followed');
  assert.equal(toolInputVerdict(c, { tool: 'Write', input: { file_path: '/brief.md', content: 'lessons for the memory', persistent: false } }), 'not followed');
});
test('tool-input permits an either-or requirement without accepting empty recipients', () => {
  const c = rule('    kind: tool-input\n    tool: ^Speak$\n    require-any-input-regex: \'"reply_to"\\s*:\\s*"[^" ]+"||"mentions"\\s*:\\s*\\[\\s*"[^" ]+"\'\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(toolInputVerdict(c, { tool: 'Speak', input: { reply_to: 'a', mentions: [] } }), 'followed');
  assert.equal(toolInputVerdict(c, { tool: 'Speak', input: { reply_to: '', mentions: ['a'] } }), 'followed');
  assert.equal(toolInputVerdict(c, { tool: 'Speak', input: { reply_to: '', mentions: [] } }), 'not followed');
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

test('tool triggers accept canonical boolean and quoted unconditional values', () => {
  for (const value of ['true', "'true'", '"true"']) {
    const parsed = rule('    kind: none\n    reason: fixture', `    - kind: tool\n      tool: ^Edit$\n      unconditional: ${value}`);
    assert.equal(triggerMatches(parsed.triggers[0], { channel: 'tool', tool: 'Edit' }), true);
  }
  for (const value of ['false', "'false'"]) assert.throws(() => rule('    kind: none\n    reason: fixture', `    - kind: tool\n      tool: ^Edit$\n      unconditional: ${value}`), /tool trigger requires/);
});

test('command-head finds wrapped launches but excludes quoted mentions and commit messages', () => {
  const trigger = rule('    kind: none\n    reason: no check', '    - kind: bash\n      regex: ^runner\\s+run\\b\n      command-head: true').triggers[0];
  for (const command of ['timeout 30 env X=1 setsid nohup nice -n 1 exec command stdbuf -oL runner run', 'sh -c "runner run"', 'echo ready; runner run'])
    assert.equal(triggerMatches(trigger, { channel: 'tool', tool: 'Bash', command }), true, command);
  for (const command of ['echo "runner run"', 'git commit -am "runner run"', 'git commit --message="runner run"'])
    assert.equal(triggerMatches(trigger, { channel: 'tool', tool: 'Bash', command }), false, command);
});

test('safe regex accepts disambiguated option alternatives and rejects ambiguous repetitions', () => {
  assert.doesNotThrow(() => rule('    kind: none\n    reason: no check', '    - kind: bash\n      regex: "\\\\b(?:pnpm|npm|yarn)\\\\s+(?:(?:-C|--dir|--filter|-F|--prefix|-w|--workspace)\\\\s+\\\\S+\\\\s+|-r\\\\s+|--recursive\\\\s+){0,8}(?:run\\\\s+)?(?:test|typecheck|lint|build|e2e|check)\\\\b"'));
  for (const source of ['(a+)+', '(?:\\d*)*', '(a|ab)*']) assert.throws(() => rule('    kind: none\n    reason: no check', `    - kind: bash\n      regex: '${source}'`), /regex has/);
});

test('safe regex refuses nested unbounded command-head scanning before execution', () => {
  const source = String.raw`^(?:(?:(?:[^'";&|()\n]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')*(?:;|&&|\|\|)\s*)|(?:timeout\s+\S+))*runner\b`;
  assert.throws(() => rule('    kind: none\n    reason: no check', `    - kind: bash\n      regex: '${source.replaceAll("'", "''")}'`), /regex has.*nested unbounded/);
  assert.throws(() => rule('    kind: none\n    reason: no check', '    - kind: bash\n      regex: "(?:(?:[ab])* ;)*x"'), /nested unbounded/);
});

test('check-rules measures every trigger and compliance regex against a supplied corpus', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rod-census-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'sample.md'), `---\non-demand:\n  triggers:\n    - kind: bash\n      regex: '^(a|aa){20}$'\n  compliance:\n    kind: bash-command\n    act-regex: '^(a|aa){20}$'\n    require-regex: '^a'\n    window: 1\n    on-close: not applicable\n---\nbody`);
  const corpus = join(dir, 'corpus.json');
  await writeFile(corpus, JSON.stringify([{ command: 'a'.repeat(35) + 'b' }, 'a'.repeat(35) + 'b']));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url)), 'check-rules', '--dir', dir, '--corpus', corpus, '--time-bound-ms', '0.000001'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /slow\s+sample\.md\s+trigger-0-regex\s+[\d.]+/);
  assert.match(result.stdout, /slow\s+sample\.md\s+compliance-act\s+[\d.]+/);
});

test('text-field checks mask quoted code and validate each selected line independently', () => {
  const c = rule("    kind: tool-input\n    tool: ^Write$\n    input-field: content\n    mask-code: true\n    require-input-regex: ^[^`]*$\n    forbid-input-regex: \\bshould\\b\n    window: 1\n    on-close: not applicable").compliance;
  assert.equal(toolInputVerdict(c, { tool: 'Write', input: { content: '```js\nshould\n```\n`should`\nRun now.' } }), 'followed');
  assert.equal(toolInputVerdict(c, { tool: 'Write', input: { content: 'You should run now.' } }), 'not followed');
  const lines = rule("    kind: tool-input\n    tool: ^Write$\n    input-field: content\n    each-line-regex: '^- '\n    require-input-regex: '^-'\n    forbid-input-regex: UPD\n    window: 1\n    on-close: not applicable").compliance;
  assert.equal(toolInputVerdict(lines, { tool: 'Write', input: { content: '# Header' } }), null);
  assert.equal(toolInputVerdict(lines, { tool: 'Write', input: { content: '- [good]\n- [UPD]' } }), 'not followed');
  const blocks = rule("    kind: tool-input\n    tool: ^Write$\n    input-field: content\n    match-block-regex: 'BEGIN([\\s\\S]*?)END'\n    require-input-regex: '^good'\n    window: 1\n    on-close: not applicable").compliance;
  assert.equal(toolInputVerdict(blocks, { tool: 'Write', input: { content: 'BEGINgoodEND BEGINbadEND' } }), 'not followed');
  assert.equal(toolInputVerdict(blocks, { tool: 'Write', input: { content: 'No blocks' } }), null);
});

test('declarative bash checks classify the segment pipe, and tool inputs require numeric minimum', () => {
  const gate = rule('    kind: bash-command\n    act-regex: ^runner\\s+test\\b\n    require-regex: ^runner\n    forbid-pipe: true\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(segmentVerdict(gate, bashSegments(gate, 'runner test | tee output')[0]), 'not followed');
  assert.equal(segmentVerdict(gate, bashSegments(gate, 'runner test; echo ready')[0]), 'followed');
  const monitor = rule('    kind: tool-input\n    tool: ^Monitor$\n    require-input-regex: .\n    minimum-input-key: timeout_ms\n    minimum-input-value: 1800000\n    absent-input-key: persistent\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(toolInputVerdict(monitor, { tool: 'Monitor', input: { timeout_ms: 1800000 } }), 'followed');
  assert.equal(toolInputVerdict(monitor, { tool: 'Monitor', input: { timeout_ms: 100, persistent: false } }), 'not followed');
  const withBash = rule('    kind: tool-input\n    tool: ^Monitor$\n    require-input-regex: .\n    reject-bash-regex: runner\\s+--obsolete\\b\n    window: 1\n    on-close: not applicable').compliance;
  assert.equal(toolInputVerdict(withBash, { tool: 'Bash', input: { command: 'runner --obsolete' } }), 'not followed');
  assert.equal(toolInputVerdict(withBash, { tool: 'Bash', input: { command: 'echo "runner --obsolete"' } }), null);
});

test('turn correlation pairs a confirmed later message with the spawned identity', () => {
  const c = rule("    kind: turn-correlation\n    tool: '^Agent$'\n    subject-input-key: subagent_type\n    subject-input-regex: '^worker$'\n    id-regex: 'agentId:\\s*(\\S+)'\n    value-regex: 'AGENT_ID:\\s*(\\S+)'\n    follow-up-tool: '^SendMessage$'\n    identity-pair: true\n    min-distinct: 1\n    window: 1\n    on-close: not applicable").compliance;
  const spawn = { kind: 'use', id: 'a', name: 'Agent', input: { subagent_type: 'worker' } };
  const result = { kind: 'result', id: 'a', text: 'agentId: xyz' };
  const message = { kind: 'use', id: 'b', name: 'SendMessage', input: { to: 'xyz', message: 'AGENT_ID: xyz' } };
  assert.equal(correlateTurn(c, [spawn, result, message, { kind: 'result', id: 'b', text: 'ok' }, { kind: 'turn' }])[0].verdict, 'followed');
  assert.equal(correlateTurn(c, [spawn, result, message, { kind: 'result', id: 'b', isError: true }, { kind: 'turn' }])[0].verdict, 'not followed');
  assert.equal(correlateTurn(c, [spawn, result, message, { kind: 'result', id: 'b', text: 'ok' }])[0].verdict, 'unresolved');
  assert.deepEqual(correlateTurn(c, [{ ...spawn, input: { subagent_type: 'other' } }, result, { kind: 'turn' }]), []);
});
