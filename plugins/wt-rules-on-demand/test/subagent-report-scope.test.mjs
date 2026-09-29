import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpec, frontmatter } from '../scripts/rule-lifecycle-lib.mjs';
import { parseRuntimeRule } from '../hooks/runtime-rule.js';
import { register, resetForSelftest } from '../hooks/hooks.js';

const names = ['wt-delegation-ladder-at-act', 'wt-delegation-addressing-at-act', 'wt-delegation-routing-at-act'];

async function fixture(name) {
  const spec = await readSpec(new URL(`../../../plugin/rules/${name}.spec.json`, import.meta.url));
  const mutant = process.env.ROD_SCOPE_MUTANT;
  if (mutant === 'drop-message') spec.triggers = spec.triggers.filter((trigger) => trigger.tool !== '^SendMessage$');
  if (mutant === 'impossible-target') {
    for (const trigger of spec.triggers) if (trigger.tool === '^SendMessage$') trigger['input-regex'] = '"to":"(?!.)';
  }
  if (mutant === 'drop-spawn') spec.triggers = spec.triggers.filter((trigger) => trigger.tool !== '^(?:Agent|Workflow)$');
  const rule = `${frontmatter(spec)}Synthetic instruction.\n`;
  parseRuntimeRule(name, rule);
  resetForSelftest();
  const handlers = new Map();
  const store = new Map();
  register((event, handler) => handlers.set(event, handler), { enabled: true });
  const $ = {
    env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
    fs: {
      list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: `${name}.md` }] : [],
      read: async () => rule,
      stat: async (path) => ({ kind: 'file', size: rule.length, realPath: path }),
    },
    ui: { log: async () => {} },
    session: { id: async () => 'synthetic-session', messages: async () => [{ role: 'assistant' }] },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
    model: { classify: async () => 'followed' },
  };
  return (args) => handlers.get('tool.call')($, { cwd: '/synthetic-project', ...args }, async () => ({}));
}

for (const name of names) {
  test(`${name}: reporting to an upward address does not serve the rule`, async () => {
    for (const [to, messageFirst] of [['main', false], ['team-lead', false], ['main [x1]', false], ['team-lead [x1]', false], ['main  [x1]', false], ['main', true]]) {
      const call = await fixture(name);
      const args = messageFirst ? { message: 'progress', to } : { to, message: 'progress' };
      const result = await call({ tool: 'SendMessage', agentId: 'a1b2c3', ...args });
      assert.equal(result.deny, undefined, `${name} to ${to} must not be refused`);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(`<rule name="${name}\\.md"`));
    }
  });

  test(`${name}: main addressing a delegate receives the rule`, async () => {
    // `parent` is no harness address (every recorded send to it failed), so a delegate may carry that name.
    for (const to of ['pilot-1', 'a7aee4b875a68ab69', 'mainline', 'main-2', 'team-leader', 'parent', 'parent-worker', 'parent [x1]']) {
      const call = await fixture(name);
      const first = await call({ tool: 'SendMessage', to, message: 'progress' });
      assert.match(first.deny ?? '', new RegExp(`<rule name="${name}\\.md"`), `${name} to ${to}`);
      const second = await call({ tool: 'SendMessage', to, message: 'progress' });
      assert.equal(second.deny, undefined, `${name} must serve only once`);
    }
    // Argument order and letter case must not turn a delegate into an upward address.
    for (const args of [{ message: 'progress', to: 'worker-1' }, { to: 'Main', message: 'progress' }]) {
      const call = await fixture(name);
      assert.match((await call({ tool: 'SendMessage', ...args })).deny ?? '', new RegExp(`<rule name="${name}\\.md"`), `${name} to ${args.to}`);
    }
  });

  test(`${name}: pilot spawning and addressing delegates receives the rule`, async () => {
    for (const [tool, args] of [['Agent', {}], ['Workflow', {}], ['SendMessage', { to: 'worker-1', message: 'progress' }]]) {
      const call = await fixture(name);
      const result = await call({ tool, agentId: 'pilot-ctx', ...args });
      assert.match(result.deny ?? '', new RegExp(`<rule name="${name}\\.md"`), `${name} on ${tool}`);
    }
  });
}
