import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';

const ruleText = (trigger, compliance) => `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nFollow this rule.\n`;
const toolTrigger = '    - kind: tool\n      tool: ^Agent$\n      unconditional: true';
const bashTrigger = '    - kind: bash\n      regex: git push';
const bashCompliance = '    kind: bash-command\n    act-regex: git push\n    require-regex: origin\n    window: 1\n    on-close: not applicable';

function host(rules, options = {}) {
  resetForSelftest();
  const handlers = new Map(), stored = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true, ...options });
  const files = new Map(Object.entries(rules).map(([name, text]) => [`/config/rules-on-demand/${name}`, text]));
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/config', HOME: '/home' })[name] },
    fs: {
      list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => ({ kind: 'file', name: path.slice(dir.length + 1) })),
      read: async (path) => files.get(path),
      stat: async (path) => ({ kind: files.has(path) ? 'file' : 'dir', size: files.get(path)?.length ?? 0, realPath: path }),
    },
    ui: { log: async () => {} },
    store: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value) },
    session: { id: async () => 'fixture', messages: async () => [] },
    model: { classify: async () => 'followed' },
  };
  return {
    $, stored,
    call: (event) => handlers.get('tool.call')($, { cwd: '/project', ...event }, async () => ({})),
    prompt: (event) => handlers.get('prompt.submit')($, { cwd: '/project', ...event }, async () => ({})),
    finish: () => handlers.get('turn.complete')($, {}, async () => ({})),
    compact: () => handlers.get('session.compact')($, {}, async () => ({})),
    verdicts: () => String(stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}

test('model classification includes its triggering tool call but prompt injection has no triggering call', async () => {
  const f = host({ 'model.md': ruleText(toolTrigger, '    kind: model\n    model: haiku\n    prompt: Judge\n    window: 1\n    on-close: not applicable') });
  const prompts = [];
  f.$.model.classify = async (text) => { prompts.push(text); return 'followed'; };
  await f.call({ tool: 'Agent', model: 'sonnet', prompt: 'trigger-secret' });
  await f.finish();
  assert.match(prompts[0], /Agent: .*trigger-secret/, 'model must see the triggering flat call');
  assert.equal(f.verdicts()[0].evidence, 'Agent: call');

  const p = host({ 'prompt.md': ruleText('    - kind: prompt\n      regex: hello', '    kind: model\n    model: haiku\n    prompt: Judge\n    window: 1\n    on-close: not applicable') });
  const promptTexts = [];
  p.$.model.classify = async (text) => { promptTexts.push(text); return 'followed'; };
  await p.prompt({ text: 'hello' });
  await p.finish();
  assert.doesNotMatch(promptTexts[0], /hello/);
  assert.equal(p.verdicts()[0].evidence, 'no following calls');
});

test('turn correlation only measures rules served in this context at turn and compaction', async () => {
  const compliance = "    kind: turn-correlation\n    tool: ^Agent$\n    id-regex: 'agentId: (\\w+)'\n    value-regex: 'id: (\\w+)'\n    follow-up-tool: ^SendMessage$\n    min-distinct: 1\n    window: 1\n    on-close: not applicable";
  for (const close of ['finish', 'compact']) {
    const f = host({ 'correlate.md': ruleText('    - kind: prompt\n      regex: enable', compliance) });
    await f.call({ tool: 'Agent', tool_use_id: 'a' });
    await f[close]();
    assert.deepEqual(f.verdicts(), [], `unserved correlation must not record at ${close}`);
    await f.prompt({ text: 'enable' });
    await f.call({ tool: 'Agent', tool_use_id: 'b' });
    await f[close]();
    assert.equal(f.verdicts().length, 1, `served correlation must record at ${close}`);
  }
});

test('served declarative rules judge each governed act once, including ride-along and after window expiry', async () => {
  const f = host({
    'bash.md': ruleText(bashTrigger, bashCompliance),
    'input.md': ruleText('    - kind: tool\n      tool: ^Write$\n      unconditional: true', '    kind: tool-input\n    tool: ^Write$\n    require-input-regex: approved\n    window: 1\n    on-close: not applicable'),
  });
  await f.call({ tool: 'Bash', command: 'git push origin main' });
  await f.call({ tool: 'Write', file_path: '/a', content: 'approved' });
  await f.call({ tool: 'Bash', command: 'git push elsewhere main' });
  await f.call({ tool: 'Write', file_path: '/b', content: 'rejected' });
  await f.call({ tool: 'Bash', command: 'git push origin next' });
  await f.call({ tool: 'Write', file_path: '/c', content: 'approved' });
  const byRule = (name) => f.verdicts().filter((row) => row.rule === name).map((row) => row.verdict);
  assert.deepEqual(byRule('bash.md'), ['followed', 'not followed', 'followed'], 'bash ride-along and subsequent acts must each yield one verdict');
  assert.deepEqual(byRule('input.md'), ['followed', 'not followed', 'followed'], 'tool-input ride-along and subsequent acts must each yield one verdict');

  const pending = host({ 'prompt-bash.md': ruleText('    - kind: prompt\n      regex: enable', bashCompliance.replace('window: 1', 'window: 3')) });
  await pending.prompt({ text: 'enable' });
  await pending.call({ tool: 'Bash', command: 'git push origin main' });
  await pending.call({ tool: 'Bash', command: 'git push elsewhere main' });
  assert.deepEqual(pending.verdicts().map((row) => row.verdict), ['followed', 'not followed'], 'pending path must not double-record a governed call');
});

test('a re-served declarative rule measured by its own retry leaves no second verdict behind', async () => {
  const f = host({ 'refuse.md': ruleText('    - kind: bash\n      regex: git push\n      before-first-act: true', bashCompliance.replace('window: 1', 'window: 3')) }, { time_reserve: true });
  const realNow = Date.now;
  try {
    await f.call({ tool: 'Bash', command: 'git push origin main' });
    Date.now = () => realNow() + 31 * 60_000;
    await f.call({ tool: 'Bash', command: 'git push origin main' });
    await f.finish();
  } finally { Date.now = realNow; }
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['followed'], 'the retry is one act: one verdict, nothing left pending');
});

test('a refused call is never classifier evidence; its executed retry is', async () => {
  const f = host({ 'model.md': ruleText(toolTrigger.replace('unconditional: true', 'unconditional: true\n      before-first-act: true'), '    kind: model\n    model: haiku\n    prompt: Judge\n    window: 1\n    on-close: not applicable') });
  const prompts = [];
  f.$.model.classify = async (text) => { prompts.push(text); return 'followed'; };
  const refused = await f.call({ tool: 'Agent', prompt: 'denied-attempt' });
  assert.ok(refused?.deny, 'the first call is refused');
  await f.call({ tool: 'Agent', model: 'sonnet', prompt: 'corrected-retry' });
  await f.finish();
  assert.doesNotMatch(prompts.join('\n'), /denied-attempt/, 'the refused attempt never ran');
  assert.match(prompts.join('\n'), /corrected-retry/);
});
