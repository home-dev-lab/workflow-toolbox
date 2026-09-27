import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandHeads, maskReadOnlyMentions } from '../hooks/bash-mention.js';
import { register, resetForSelftest } from '../hooks/hooks.js';

const wrapper = [
  'timeout 60', 'timeout --kill-after=5s 60', 'setsid', 'nohup', 'env X=1',
  'X=1', 'nice -n 1', 'exec', 'command', 'stdbuf -oL',
];
const acts = wrapper.flatMap((prefix) => [
  `${prefix} git push mirror main`,
  `${prefix} pnpm test`,
  `${prefix} opencode run --auto`,
]);
acts.push('bash -c "git push mirror main"', '(git push mirror main)', 'echo ready; git push mirror main',
  'echo ready && pnpm test', 'grep x file | git push mirror main');
const mentions = [
  'grep -n "git push" notes.md', 'rg "pnpm test" notes.md', 'echo "opencode run"',
  'printf "git push"', 'cat > notes.md <<\'EOF\'\ngit push\nEOF',
  'git commit -m "run git push later"', 'sed -n "/pnpm test/p" notes.md',
  'cat notes.md', 'wc -c notes.md', 'ls notes',
];
for (let i = 0; i < 3; i++) mentions.push(...[
  `grep -n "git push ${i}" notes.md`, `echo "pnpm test ${i}"`,
  `git commit -m "opencode run ${i}"`, `sed -n '/git push ${i}/p' notes.md`,
  `cat > notes${i}.md <<'EOF'\npnpm test\nEOF`,
  `printf 'opencode run ${i}'`,
]);

function runtime() {
  resetForSelftest();
  const rule = `---\non-demand:\n  triggers:\n    - kind: 'bash'\n      regex: 'git\\s+push|pnpm\\s+test|opencode\\s+run'\n      before-first-act: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'synthetic'\n---\nCheck the act.\n`;
  const handlers = new Map();
  register((event, handler) => handlers.set(event, handler), { enabled: true });
  const $ = {
    env: { get: async (name) => name === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
     fs: { list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: 'act.md' }] : [], read: async () => rule,
       stat: async (path) => ({ kind: 'file', size: rule.length, realPath: path }) },
    ui: { log: async () => {} }, store: { get: async () => undefined, set: async () => {} },
    session: { id: async () => 'synthetic', messages: async () => [] },
  };
  return async (command, next = async () => ({})) => handlers.get('tool.call')($, { cwd: '/synthetic-project', tool: 'Bash', command }, next);
}

test('synthetic corpus covers at least 25 acts and mentions', () => {
  assert.ok(acts.length >= 25 && mentions.length >= 25);
});
for (const [index, command] of acts.entries()) {
  test(`governed command ${index}: ${command}`, async () => {
    let executed = 0;
    const result = await runtime()(command, async () => { executed++; return {}; });
    assert.match(result.deny, /Check the act/, command);
    assert.equal(executed, 0);
  });
}
for (const [index, command] of mentions.entries()) {
  test(`read-only mention ${index}: ${command.split('\n')[0]}`, async () => {
    const result = await runtime()(command);
    assert.equal(result.deny, undefined, command);
    assert.equal(result.context, undefined, command);
  });
}

test('command-head scanner retains wrapped heads, subshells and separators', () => {
  for (const command of acts) {
    const heads = commandHeads(maskReadOnlyMentions(command));
    let expected = 'opencode';
    if (command.startsWith('bash -c')) expected = 'bash';
    else if (command.includes('git push')) expected = 'git';
    else if (command.includes('pnpm test')) expected = 'pnpm';
    assert.ok(heads.some(({ head }) => head === expected), `${command}: expected executable ${expected}, got ${JSON.stringify(heads)}`);
  }
  assert.equal(maskReadOnlyMentions('git commit -m "git push"').includes('git push'), false);
  const input = "cat > note <<'EOF'\ngit push\nEOF\npnpm test";
  const output = maskReadOnlyMentions(input);
  assert.equal(output.length, input.length);
  assert.equal(output.split('\n').length, input.split('\n').length);
  assert.ok(output.endsWith('pnpm test'));
});
