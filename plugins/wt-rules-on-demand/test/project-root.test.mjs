import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';

const ruleText = (body = 'Follow this rule.') => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'no mechanical check'\n---\n${body}\n`;

// A host whose filesystem models MISSING directories: a directory exists only when a file lies under it.
function host({ files = {}, root, rootThrows = false, noRoot = false, repo = null, config = '/sample-config', home = '/sample-home', real = {} } = {}) {
  resetForSelftest();
  const handlers = new Map();
  register((event, handler) => handlers.set(event, handler), { enabled: true });
  const tree = new Map(Object.entries(files));
  const calls = { list: 0, stat: 0, read: 0 };
  const isDir = (path) => path in real || [...tree.keys()].some((file) => file.startsWith(path === '/' ? '/' : `${path}/`));
  const missing = (op, path) => new Error(`${op} ${path} failed: ENOENT`);
  const logs = [];
  const stored = new Map();
  let currentRoot = root;
  const session = { id: async () => 'sample-session', messages: async () => [],
    repo: async () => (repo ? { root: repo, remote: null, internal: false, name: null } : null) };
  if (!noRoot) session.root = async () => { if (rootThrows) throw new Error('root unavailable in this host'); return currentRoot; };
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: config, HOME: home })[name] },
    fs: {
      list: async (dir) => {
        calls.list++;
        if (!isDir(dir)) throw missing('list', dir);
        const out = new Map();
        for (const file of tree.keys()) if (file.startsWith(`${dir}/`)) {
          const rest = file.slice(dir.length + 1);
          out.set(rest.split('/')[0], { name: rest.split('/')[0], kind: rest.includes('/') ? 'dir' : 'file' });
        }
        return [...out.values()];
      },
      read: async (path) => { calls.read++; if (!tree.has(path)) throw missing('read', path); return tree.get(path); },
      stat: async (path) => {
        calls.stat++;
        if (tree.has(path)) return { kind: 'file', size: tree.get(path).length, realPath: real[path] ?? path };
        if (isDir(path)) return { kind: 'dir', size: 0, realPath: real[path] ?? path };
        throw missing('stat', path);
      },
    },
    ui: { log: async (line) => { logs.push(line); } },
    store: { get: async (name) => stored.get(name), set: async (name, value) => stored.set(name, value) },
    session,
  };
  const call = (event) => handlers.get('tool.call')($, { tool: 'Agent', ...event }, async () => ({}));
  const identities = (contextKey) => Object.keys(stored.get('sessions')?.['sample-session']?.contexts?.[contextKey]?.servedIdentity ?? {}).sort();
  return { call, logs, calls, identities, setRoot: (value) => { currentRoot = value; } };
}

test('T1: a sub-agent in a nested worktree is served the session root project rule', async () => {
  const h = host({ root: '/sample-project', files: {
    '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.'),
    '/sample-project/.claude/worktrees/wt/.git': 'gitdir: /sample-project/.git/worktrees/wt\n',
  } });
  const result = await h.call({ agentId: 'a1', cwd: '/sample-project/.claude/worktrees/wt' });
  assert.match(result.deny ?? '', /proj\.md/);
  assert.deepEqual(h.identities('agent:a1'), ['project:/sample-project/.claude/rules-on-demand:proj.md']);
});

test('T2: rules at every ancestor of the session root are served, outer and inner', async () => {
  const h = host({ root: '/sample-project/sub', repo: '/sample-project', files: {
    '/sample-project/.git/HEAD': 'ref: refs/heads/main\n',
    '/sample-project/.claude/rules-on-demand/outer.md': ruleText('Outer.'),
    '/sample-project/sub/.claude/rules-on-demand/inner.md': ruleText('Inner.'),
  } });
  const result = await h.call({ cwd: '/sample-project/sub' });
  assert.match(result.deny ?? '', /outer\.md/);
  assert.match(result.deny ?? '', /inner\.md/);
  assert.deepEqual(h.identities('0'), ['project:/sample-project/.claude/rules-on-demand:outer.md', 'project:/sample-project/sub/.claude/rules-on-demand:inner.md']);
});

test('T3: a worktree nested in its main repository does not see the main repository rules', async () => {
  const wt = '/sample-project/.claude/worktrees/wt';
  const h = host({ root: wt, repo: '/sample-project', files: {
    '/sample-project/.git/HEAD': 'ref: refs/heads/main\n',
    '/sample-project/.claude/rules-on-demand/main.md': ruleText('Main checkout.'),
    [`${wt}/.git`]: 'gitdir: /sample-project/.git/worktrees/wt\n',
    [`${wt}/.claude/rules-on-demand/own.md`]: ruleText('Worktree.'),
  } });
  const result = await h.call({ cwd: wt });
  assert.match(result.deny ?? '', /own\.md/);
  assert.doesNotMatch(result.deny ?? '', /main\.md/);
  assert.deepEqual(h.identities('0'), [`project:${wt}/.claude/rules-on-demand:own.md`]);
});

test('T4: the nearest copy wins a name collision, names the shadowed copy, and project still beats user', async () => {
  const h = host({ root: '/sample-project/sub', files: {
    '/sample-config/rules-on-demand/shared.md': ruleText('User body.'),
    '/sample-project/.claude/rules-on-demand/shared.md': ruleText('Outer body.'),
    '/sample-project/sub/.claude/rules-on-demand/shared.md': ruleText('Inner body.'),
  } });
  const result = await h.call({ cwd: '/sample-project/sub' });
  assert.match(result.deny ?? '', /Inner body\./);
  assert.doesNotMatch(result.deny ?? '', /Outer body\.|User body\./);
  assert.deepEqual(h.identities('0'), ['project:/sample-project/sub/.claude/rules-on-demand:shared.md']);
  assert.ok(h.logs.some((line) => line.includes('shadowed: /sample-project/.claude/rules-on-demand/shared.md by /sample-project/sub/.claude/rules-on-demand/shared.md')), h.logs.join('\n'));
});

test('T4b: a suppressed nearest copy does not let an outer copy through', async () => {
  const h = host({ root: '/sample-project/sub', files: {
    '/sample-project/.claude/rules-on-demand/shared.md': ruleText('Outer body.'),
    '/sample-project/sub/.claude/rules-on-demand/shared.md': ruleText('Inner body.'),
    '/sample-project/sub/.claude/rules/shared.md': 'Inner body.\n',
  } });
  const result = await h.call({ cwd: '/sample-project/sub' });
  assert.equal(result.deny, undefined);
  assert.ok(h.logs.some((line) => line.includes('loaded twice: /sample-project/sub/.claude/rules/shared.md and /sample-project/sub/.claude/rules-on-demand/shared.md')), h.logs.join('\n'));
});

test('T5: an identical static copy in an OUTER ancestor suppresses the inner on-demand copy', async () => {
  const h = host({ root: '/sample-project/sub', files: {
    '/sample-project/.claude/rules/wt/dup.md': 'Same text.\n',
    '/sample-project/sub/.claude/rules-on-demand/dup.md': ruleText('Same text.'),
  } });
  const result = await h.call({ cwd: '/sample-project/sub' });
  assert.equal(result.deny, undefined);
  assert.ok(h.logs.some((line) => line.includes('loaded twice: /sample-project/.claude/rules/wt/dup.md and /sample-project/sub/.claude/rules-on-demand/dup.md')), h.logs.join('\n'));
});

test('T6a: the active config directory, reached as an ancestor, keeps its user identity', async () => {
  const h = host({ root: '/sample-home/p', config: '/sample-home/.claude', files: {
    '/sample-home/.claude/rules-on-demand/mine.md': ruleText('Mine.'),
  } });
  const result = await h.call({ cwd: '/sample-home/p' });
  assert.match(result.deny ?? '', /mine\.md/);
  assert.deepEqual(h.identities('0'), ['user:/sample-home/.claude/rules-on-demand:mine.md']);
});

test('T6b: the config directory reached through another spelling is still recognised physically', async () => {
  const h = host({ root: '/sample-home/p', config: '/sample-alias', real: { '/sample-alias': '/sample-home/.claude' }, files: {
    '/sample-alias/rules-on-demand/mine.md': ruleText('Mine.'),
    '/sample-home/.claude/rules-on-demand/mine.md': ruleText('Mine.'),
  } });
  await h.call({ cwd: '/sample-home/p' });
  assert.deepEqual(h.identities('0'), ['user:/sample-alias/rules-on-demand:mine.md']);
});

test('T6c: with the config directory elsewhere, the home .claude is an ordinary project ancestor', async () => {
  const h = host({ root: '/sample-home/p', config: '/sample-config', files: {
    '/sample-home/.claude/rules-on-demand/homeproj.md': ruleText('Home as ancestor.'),
  } });
  const result = await h.call({ cwd: '/sample-home/p' });
  assert.match(result.deny ?? '', /homeproj\.md/);
  assert.deepEqual(h.identities('0'), ['project:/sample-home/.claude/rules-on-demand:homeproj.md']);
});

for (const [label, options] of [['throws', { rootThrows: true }], ['is missing', { noRoot: true }]]) {
  test(`T7: when session root ${label}, rules come from the event cwd with one named notice`, async () => {
    const h = host({ ...options, files: { '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.') } });
    const result = await h.call({ cwd: '/sample-project' });
    assert.match(result.deny ?? '', /proj\.md/);
    assert.equal(h.logs.filter((line) => line.includes('session root unavailable; project rules resolved from event cwd')).length, 1, h.logs.join('\n'));
  });
}

test('T8: a session root change between two events reloads the context rules', async () => {
  const h = host({ root: '/sample-a', files: {
    '/sample-a/.claude/rules-on-demand/a.md': ruleText('A.'),
    '/sample-b/.claude/rules-on-demand/b.md': ruleText('B.'),
  } });
  assert.match((await h.call({ cwd: '/sample-a' })).deny ?? '', /a\.md/);
  h.setRoot('/sample-b');
  assert.match((await h.call({ cwd: '/sample-b' })).deny ?? '', /b\.md/);
});

test('cost: one load at an eight-level session root stays within a fixed number of host calls', async () => {
  const user = '/sample-home/user';
  const suite = `${user}/projects/suite`;
  const wt = `${suite}/.claude/worktrees/x`;
  const h = host({ root: wt, home: user, config: `${user}/.claude`, repo: '/sample-elsewhere/toolbox', files: {
    [`${user}/.claude/rules/a.md`]: 'A static rule.\n',
    [`${user}/.claude/rules-on-demand/u.md`]: ruleText('User.'),
    [`${suite}/.claude/rules/s.md`]: 'Suite static.\n',
    [`${suite}/.claude/rules-on-demand/p.md`]: ruleText('Suite project.'),
    [`${wt}/.git`]: 'gitdir: /sample-elsewhere/toolbox/.git/worktrees/x\n',
    [`${wt}/.claude/rules/w.md`]: 'Worktree static.\n',
  } });
  const result = await h.call({ cwd: wt });
  assert.match(result.deny ?? '', /u\.md/);
  assert.match(result.deny ?? '', /p\.md/);
  const total = h.calls.list + h.calls.stat + h.calls.read;
  console.log(`host fs calls for one load at depth 8: list=${h.calls.list} stat=${h.calls.stat} read=${h.calls.read} total=${total}`);
  // 8 `.claude` stats + 1 config stat; absent directories are never listed twice nor stat'ed after an empty list.
  assert.deepEqual(h.calls, { list: 6, stat: 15, read: 2 });
});
