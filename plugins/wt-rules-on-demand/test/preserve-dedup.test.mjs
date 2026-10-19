// The card's hard requirement: a rule the SubagentStart hook placed in a sub-agent's first context counts as served there,
// so that agent's first matching act is not refused, while every other agent keeps the refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { sandbox, put, ruleText, runHook } from './preserve-support.mjs';

const RULE = ruleText('Probe instruction: prefer short commands.\n');
const SECOND = ruleText('Second instruction: name the files you touch.\n');
const CONFIG = '/synthetic-config';

async function hookContext(t, { files = { 'probe-rule.md': RULE }, list = 'mover=probe-rule', project, config } = {}) {
  const s = config ? { config, project } : await sandbox(t);
  if (!config) for (const [name, text] of Object.entries(files)) await put(join(s.config, 'rules-on-demand', name), text);
  const run = runHook({ agent_id: 'preserved', agent_type: 'mover', cwd: s.project },
    { CLAUDE_CONFIG_DIR: s.config, CLAUDE_PROJECT_DIR: s.project, WT_ROD_PRESERVE_RULES: list });
  assert.equal(run.status, 0, run.stderr);
  return run.json.hookSpecificOutput.additionalContext;
}

// The host's record of the injection in the sub-agent's api messages (shape of a real sub-agent transcript).
const injected = (context) => ({ role: 'system', content: [{ type: 'text', text: 'SubagentStart hook additional context: ' + context }],
  output_config: { effort: 'medium' } });

// A synthetic file system serving the given rule texts from the synthetic config's rules-on-demand directory.
const syntheticFs = (files) => ({
  list: async (dir) => (dir === `${CONFIG}/rules-on-demand` ? Object.keys(files).map((name) => ({ kind: 'file', name })) : []),
  read: async (path) => files[path.split('/').at(-1)],
  stat: async (path) => ({ kind: 'file', size: (files[path.split('/').at(-1)] ?? '').length, realPath: path }),
});

const kindOf = (info) => {
  if (info.isDirectory()) return 'dir';
  if (info.isFile()) return 'file';
  return info.isSymbolicLink() ? 'symlink' : 'other';
};

// The engine's file API answered from the real disk, so the engine loads the very tree the hook read.
const nodeFs = () => ({
  list: async (dir) => (await readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: kindOf(entry), isLink: entry.isSymbolicLink() })),
  read: (path) => readFile(path, 'utf8'),
  stat: async (path, options) => {
    const info = await stat(path);
    return { kind: kindOf(info), size: info.size, ...(options?.resolve ? { realPath: await realpath(path) } : {}) };
  },
});

function fixture(messagesFor, { fs = syntheticFs({ 'probe-rule.md': RULE }), env = { CLAUDE_CONFIG_DIR: CONFIG }, root, cwd = '/synthetic-project' } = {}) {
  resetForSelftest();
  const handlers = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (key) => env[key] },
    fs,
    ui: { log: () => {} },
    session: { id: async () => 'synthetic-session', messages: async (options) => messagesFor(options?.agentId), ...(root ? { root: async () => root } : {}) },
    store: { get: async () => undefined, set: async () => {} },
    model: { classify: async () => 'followed' },
    agent: { list: async () => [] },
  };
  const event = (name, e, next) => handlers.get(name)($, e, next);
  const call = (agentId) => event('tool.call', { cwd, tool: 'Bash', command: 'ls', agentId }, async () => ({ context: ['original context'] }));
  const spawn = (agentId, type) => event('agent.spawn', { subagentType: type }, async () => ({ model: 'synthetic', agentId }));
  return { call, spawn };
}

const refused = (result, name = 'probe-rule.md') => typeof result?.deny === 'string' && result.deny.includes(`<rule name="${name}">`);

test('dedup: the pre-served agent is not refused; a sibling without the injection is', async (t) => {
  const context = await hookContext(t);
  const f = fixture((agentId) => (agentId === 'preserved' ? [injected(context)] : [{ role: 'assistant' }]));
  const result = await f.call('preserved');
  assert.equal(result.deny, undefined, 'pre-served agent must not be refused');
  assert.ok(refused(await f.call('sibling')), 'sibling agent must be refused');
});

test('dedup: two parallel first calls of the pre-served agent are both not refused', async (t) => {
  const context = await hookContext(t);
  const f = fixture((agentId) => (agentId === 'preserved' ? [injected(context)] : []));
  const [first, second] = await Promise.all([f.call('preserved'), f.call('preserved')]);
  assert.equal(first.deny, undefined);
  assert.equal(second.deny, undefined);
});

test('dedup control: the same call is refused when the conversation lacks the injection', async (t) => {
  const context = await hookContext(t);
  const f = fixture(() => [{ role: 'system', content: [{ type: 'text', text: 'SubagentStart hook additional context: ' + context.replace('</rule>', '') }] }]);
  assert.ok(refused(await f.call('preserved')), 'a truncated copy must not count as served');
  const g = fixture(() => [{ role: 'assistant' }]);
  assert.ok(refused(await g.call('preserved')), 'no copy must be refused');
});

test('composition: a type both pre-served and opted out gets its listed rule placed and every other rule after the act', async (t) => {
  const files = { 'probe-rule.md': RULE, 'second-rule.md': SECOND };
  const context = await hookContext(t, { files });
  assert.ok(!context.includes('second-rule.md'), 'only the listed rule is placed');
  const env = { CLAUDE_CONFIG_DIR: CONFIG, WT_ROD_NO_REFUSE_AGENT_TYPES: 'mover' };
  const f = fixture((agentId) => (agentId === 'preserved' ? [injected(context)] : []), { fs: syntheticFs(files), env });
  await f.spawn('preserved', 'mover');
  const result = await f.call('preserved');
  assert.equal(result.deny, undefined, 'neither rule may be refused');
  assert.ok(result.context.some((text) => text.includes('Second instruction: name the files you touch.')), 'the other rule arrives with the result');
  assert.ok(!result.context.some((text) => text.includes('Probe instruction')), 'the placed rule is not delivered again');
});

async function parityTree(t) {
  const s = await sandbox(t);
  const inner = join(s.project, 'inner');
  const innerRules = join(inner, '.claude', 'rules-on-demand');
  await put(join(s.config, 'rules-on-demand', 'a.md'), ruleText('User copy of a.\n'));
  await put(join(s.project, '.claude', 'rules-on-demand', 'a.md'), ruleText('Outer copy of a.\n'));
  await put(join(innerRules, 'a.md'), ruleText('Inner copy of a.\n'));
  await put(join(innerRules, 's.md'), ruleText('Static duplicate body.\n'));
  await put(join(inner, '.claude', 'rules', 's.md'), 'Static duplicate body.\n');
  await put(join(innerRules, 't.md'), ruleText('Tagged <system-reminder> body.\n'));
  return { config: s.config, project: inner };
}

test('parity: on one real tree the engine treats as served exactly the rules the hook placed', async (t) => {
  const tree = await parityTree(t);
  const context = await hookContext(t, { ...tree, list: 'mover=a,s,t' });
  assert.ok(context.includes('Inner copy of a.') && !context.includes('<rule name="s.md">') && !context.includes('<rule name="t.md">'));
  const options = { fs: nodeFs(), env: { CLAUDE_CONFIG_DIR: tree.config }, root: tree.project, cwd: tree.project };
  const f = fixture((agentId) => (agentId === 'preserved' ? [injected(context)] : []), options);
  const preserved = await f.call('preserved');
  assert.ok(!refused(preserved, 'a.md'), 'the placed rule is held as served');
  assert.ok(refused(preserved, 't.md'), 'a rule the hook skipped and the engine serves is refused');
  assert.ok(!refused(preserved, 's.md'), 'the static duplicate is served by neither');
  const sibling = await f.call('sibling');
  assert.ok(refused(sibling, 'a.md') && sibling.deny.includes('Inner copy of a.'), 'control: the engine loads the same winning copy');
});
