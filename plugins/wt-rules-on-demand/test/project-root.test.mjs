import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';

const ruleText = (body = 'Follow this rule.') => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'true'\n  compliance:\n    kind: 'none'\n    reason: 'no mechanical check'\n---\n${body}\n`;

const servedNames = (result) => [...String(result?.deny ?? '').matchAll(/<rule name="([^"]+)">/g)].map((match) => match[1]).sort();
// Measured at the eight-level root of the cost test below; a change that adds host calls must raise these knowingly.
const COST = { list: 6, stat: 17, read: 4 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// A linked worktree `wt` of the main checkout `main`, as git writes it: a `.git` file naming a gitdir whose
// `commondir` leads back to the main `.git` directory.
const linked = (main, wt, name = 'wt') => ({
  [`${main}/.git/HEAD`]: 'ref: refs/heads/main\n',
  [`${main}/.git/worktrees/${name}/commondir`]: '../..\n',
  [`${wt}/.git`]: `gitdir: ${main}/.git/worktrees/${name}\n`,
});

// A host whose filesystem models MISSING directories: a directory exists only when a file lies under it.
// `fail` maps a path to the error its stat/read rejects with; `gate` runs at the start of every load (config read).
function host({ files = {}, root, rootThrows = false, noRoot = false, repo = null, config = '/sample-config', home = '/sample-home', real = {}, fail = {}, gate = null } = {}) {
  resetForSelftest();
  const handlers = new Map();
  register((event, handler) => handlers.set(event, handler), { enabled: true });
  const tree = new Map(Object.entries(files));
  const calls = { list: 0, stat: 0, read: 0, loads: 0 };
  const isDir = (path) => path in real || [...tree.keys()].some((file) => file.startsWith(path === '/' ? '/' : `${path}/`));
  const missing = (op, path) => new Error(`${op} ${path} failed: ENOENT`);
  const logs = [];
  const stored = new Map();
  let currentRoot = root;
  const session = { id: async () => 'sample-session', messages: async () => [],
    repo: async () => (repo ? { root: repo, remote: null, internal: false, name: null } : null) };
  if (!noRoot) session.root = async () => { if (rootThrows) throw new Error('root unavailable in this host'); return currentRoot; };
  const $ = {
    env: { get: async (name) => {
      if (name === 'CLAUDE_CONFIG_DIR') { calls.loads++; if (gate) await gate(calls.loads); }
      return ({ CLAUDE_CONFIG_DIR: config, HOME: home })[name];
    } },
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
      read: async (path) => { calls.read++; if (fail[path]) throw fail[path]; if (!tree.has(path)) throw missing('read', path); return tree.get(path); },
      stat: async (path) => {
        calls.stat++;
        if (fail[path]) throw fail[path];
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
  const health = () => stored.get('health')?.lastErrors ?? [];
  return { call, logs, calls, identities, handlers, $, stored, health, setRoot: (value) => { currentRoot = value; } };
}

test('T1: a sub-agent whose cwd lies outside the project is served the session root rules, not its cwd rules', async () => {
  const h = host({ root: '/sample-project', files: {
    '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.'),
    '/sample-elsewhere/wt/.claude/rules-on-demand/local.md': ruleText('Cwd-local rule.'),
  } });
  const result = await h.call({ agentId: 'a1', cwd: '/sample-elsewhere/wt' });
  assert.deepEqual(servedNames(result), ['proj.md']);
  assert.deepEqual(h.identities('agent:a1'), ['project:/sample-project/.claude/rules-on-demand:proj.md']);
});

test('T1b: a sub-agent of a nested-worktree session keeps the worktree set even when its cwd is in the main checkout', async () => {
  const wt = '/sample-project/.claude/worktrees/wt';
  const h = host({ root: wt, files: {
    ...linked('/sample-project', wt),
    '/sample-project/.claude/rules-on-demand/main.md': ruleText('Main checkout.'),
    [`${wt}/.claude/rules-on-demand/own.md`]: ruleText('Worktree.'),
  } });
  assert.deepEqual(servedNames(await h.call({ agentId: 'a1', cwd: '/sample-project/other' })), ['own.md']);
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
  const h = host({ root: wt, files: {
    ...linked('/sample-project', wt),
    '/sample-project/.claude/rules-on-demand/main.md': ruleText('Main checkout.'),
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
  assert.ok(h.logs.some((line) => line.includes('shadowed: /sample-config/rules-on-demand/shared.md by /sample-project/sub/.claude/rules-on-demand/shared.md')), h.logs.join('\n'));
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
  const h = host({ root: wt, home: user, config: `${user}/.claude`, files: {
    [`/sample-elsewhere/toolbox/.git/worktrees/x/commondir`]: '../..\n',
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
  // Upper bounds. The 17 stats: 1 config, 8 ancestor `.claude`, 2 for the worktree check (`.git`, common directory), and
  // the rest for non-empty static dirs and the two winners; the 4 reads: `.git`, `commondir`, the two winners.
  assert.ok(h.calls.list <= COST.list && h.calls.stat <= COST.stat && h.calls.read <= COST.read, JSON.stringify(h.calls));
});

test('T4c: a nearest copy whose static twin has a DIFFERENT body is served, with the different-rule notice', async () => {
  const h = host({ root: '/sample-project/sub', files: {
    '/sample-project/sub/.claude/rules-on-demand/shared.md': ruleText('Inner body.'),
    '/sample-project/sub/.claude/rules/shared.md': 'Another text.\n',
  } });
  assert.deepEqual(servedNames(await h.call({ cwd: '/sample-project/sub' })), ['shared.md']);
  assert.ok(h.logs.some((line) => line.includes('same name, different rule: /sample-project/sub/.claude/rules/shared.md and /sample-project/sub/.claude/rules-on-demand/shared.md')), h.logs.join('\n'));
});

test('T5b: a DIFFERENT static body in an outer ancestor does not suppress the inner on-demand copy', async () => {
  const h = host({ root: '/sample-project/sub', files: {
    '/sample-project/.claude/rules/wt/dup.md': 'Older text.\n',
    '/sample-project/sub/.claude/rules-on-demand/dup.md': ruleText('Same text.'),
  } });
  assert.deepEqual(servedNames(await h.call({ cwd: '/sample-project/sub' })), ['dup.md']);
});

const nested = '/sample-project/.claude/worktrees/wt';
const mainAndOwn = { '/sample-project/.claude/rules-on-demand/main.md': ruleText('Main checkout.'), [`${nested}/.claude/rules-on-demand/own.md`]: ruleText('Worktree.') };
const accessDenied = Object.assign(new Error(`stat ${nested}/.git failed: EACCES`), { code: 'EACCES' });
const worktreeTable = [
  ['a linked worktree nested in its main checkout drops the main checkout', { root: nested, files: { ...linked('/sample-project', nested), ...mainAndOwn } }, ['own.md'], null],
  ['a linked worktree outside its main checkout keeps every ancestor', { root: '/sample-suite/wt', files: {
    ...linked('/sample-elsewhere', '/sample-suite/wt'),
    '/sample-suite/.claude/rules-on-demand/outer.md': ruleText('Outer.'), '/sample-suite/wt/.claude/rules-on-demand/own.md': ruleText('Own.') } }, ['outer.md', 'own.md'], null],
  ['a submodule-style .git file without commondir is no worktree', { root: '/sample-project/mod', files: {
    '/sample-project/.git/HEAD': 'ref\n', '/sample-project/.git/modules/mod/HEAD': 'ref\n', '/sample-project/mod/.git': 'gitdir: ../.git/modules/mod\n',
    '/sample-project/.claude/rules-on-demand/main.md': ruleText('Main.'), '/sample-project/mod/.claude/rules-on-demand/own.md': ruleText('Own.') } }, ['main.md', 'own.md'], null],
  ['a .git directory is a checkout of its own, no exclusion', { root: '/sample-project/mod', files: {
    '/sample-project/mod/.git/HEAD': 'ref\n',
    '/sample-project/.claude/rules-on-demand/main.md': ruleText('Main.'), '/sample-project/mod/.claude/rules-on-demand/own.md': ruleText('Own.') } }, ['main.md', 'own.md'], null],
  ['an unreadable .git means no exclusion and a named notice', { root: nested, files: { ...linked('/sample-project', nested), ...mainAndOwn }, fail: { [`${nested}/.git`]: accessDenied } },
    ['main.md', 'own.md'], /nested-worktree check unknown: .*EACCES/],
  ['a malformed .git file means no exclusion and a named notice', { root: nested, files: { ...linked('/sample-project', nested), ...mainAndOwn, [`${nested}/.git`]: 'not a pointer\n' } },
    ['main.md', 'own.md'], /nested-worktree check unknown: malformed/],
];
for (const [label, options, expected, unknown] of worktreeTable) {
  test(`F2 hook: ${label}`, async () => {
    const h = host(options);
    assert.deepEqual(servedNames(await h.call({ cwd: options.root })), expected);
    const notices = h.logs.filter((line) => line.includes('nested-worktree check unknown'));
    if (unknown) { assert.equal(notices.length, 1, h.logs.join('\n')); assert.match(notices[0], unknown); }
    else assert.deepEqual(notices, []);
  });
}

for (const raw of ['', 'C:', 'C:foo', '\\p\\x', 'rel/a']) {
  test(`F3: root() answering ${JSON.stringify(raw)} falls back to the event cwd with the named notice`, async () => {
    const h = host({ root: raw, files: { '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.') } });
    assert.deepEqual(servedNames(await h.call({ cwd: '/sample-project' })), ['proj.md']);
    assert.equal(h.logs.filter((line) => line.includes('session root unavailable; project rules resolved from event cwd')).length, 1, h.logs.join('\n'));
  });
}

test('F5: in fallback, a relative cwd (.) reuses the context set: one load and one health error per context', async () => {
  const h = host({ rootThrows: true, files: { '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.') } });
  const fallbackErrors = () => h.health().filter((entry) => entry.message.includes('session root unavailable')).length;
  await h.call({ cwd: '/sample-project' });
  await h.call({ cwd: '.' });
  await h.call({ cwd: '/sample-project' });
  await tick();
  assert.equal(h.calls.loads, 1);
  assert.equal(fallbackErrors(), 1);
  await h.call({ agentId: 'a1', cwd: '/sample-project' });
  await tick();
  assert.equal(fallbackErrors(), 2);
});

test('F6: a root change that gives a name another identity makes that name servable again', async () => {
  const h = host({ root: '/sample-a', files: {
    '/sample-a/.claude/rules-on-demand/shared.md': ruleText('A body.'),
    '/sample-b/.claude/rules-on-demand/shared.md': ruleText('B body.'),
  } });
  assert.match((await h.call({ cwd: '/sample-a' })).deny ?? '', /A body\./);
  h.setRoot('/sample-b');
  assert.match((await h.call({ cwd: '/sample-b' })).deny ?? '', /B body\./);
});

test('F7: a load that finishes after a newer load for another root never publishes into the context', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const h = host({ root: '/sample-a', gate: async (load) => { if (load === 1) await held; }, files: {
    '/sample-a/.claude/rules-on-demand/a.md': ruleText('A.'),
    '/sample-b/.claude/rules-on-demand/b.md': ruleText('B.'),
  } });
  const first = h.call({ cwd: '/sample-a' });
  while (h.calls.loads < 1) await tick();
  h.setRoot('/sample-b');
  assert.deepEqual(servedNames(await h.call({ cwd: '/sample-b' })), ['b.md']);
  release();
  assert.deepEqual(servedNames(await first), ['a.md']);
  await h.call({ cwd: '/sample-b' });
  assert.equal(h.calls.loads, 2, 'the late /sample-a load overwrote the /sample-b rules and forced a reload');
});

test('T11: after compaction, a main context whose cwd drifted into a nested worktree is served from the session root', async () => {
  const wt = '/sample-project/.claude/worktrees/wt';
  const h = host({ root: '/sample-project', files: { ...linked('/sample-project', wt), '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.') } });
  assert.deepEqual(servedNames(await h.call({ cwd: '/sample-project' })), ['proj.md']);
  await h.handlers.get('session.compact')(h.$, {}, async () => ({}));
  assert.deepEqual(servedNames(await h.call({ cwd: wt })), ['proj.md']);
});

test('G1: a name served under one identity is servable again under another, even across a root without it', async () => {
  const h = host({ root: '/sample-a', files: {
    '/sample-a/.claude/rules-on-demand/shared.md': ruleText('A body.'),
    '/sample-b/.claude/rules-on-demand/other.md': ruleText('B other.'),
    '/sample-c/.claude/rules-on-demand/shared.md': ruleText('C body.'),
  } });
  assert.match((await h.call({ cwd: '/sample-a' })).deny ?? '', /A body\./);
  h.setRoot('/sample-b');
  await h.call({ cwd: '/sample-b' });
  h.setRoot('/sample-c');
  assert.match((await h.call({ cwd: '/sample-c' })).deny ?? '', /C body\./);
});

test('G2: a root change that keeps a rule identity does not serve it again', async () => {
  const h = host({ root: '/sample-common/a', files: {
    '/sample-common/.claude/rules-on-demand/shared.md': ruleText('Common body.'),
    '/sample-common/b/.claude/rules-on-demand/b.md': ruleText('B only.'),
  } });
  assert.deepEqual(servedNames(await h.call({ cwd: '/sample-common/a' })), ['shared.md']);
  h.setRoot('/sample-common/b');
  assert.deepEqual(servedNames(await h.call({ cwd: '/sample-common/b' })), ['b.md']);
});

test('G3: a cache hit for the published root retires a load still in flight for another root', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const h = host({ root: '/sample-a', gate: async (load) => { if (load === 2) await held; }, files: {
    '/sample-a/.claude/rules-on-demand/a.md': ruleText('A.'),
    '/sample-b/.claude/rules-on-demand/b.md': ruleText('B.'),
  } });
  await h.call({ cwd: '/sample-a' });
  h.setRoot('/sample-b');
  const second = h.call({ cwd: '/sample-b' });
  while (h.calls.loads < 2) await tick();
  h.setRoot('/sample-a');
  await h.call({ cwd: '/sample-a' });
  release();
  await second;
  await h.call({ cwd: '/sample-a' });
  assert.equal(h.calls.loads, 2, 'the retired /sample-b load published and forced a reload of /sample-a');
});

test('G4: in fallback, spellings of one absolute cwd share one load', async () => {
  const h = host({ rootThrows: true, files: {
    '/sample-project/.claude/rules-on-demand/proj.md': ruleText('Project rule.'),
    'C:/sample-win/.claude/rules-on-demand/win.md': ruleText('Windows rule.'),
  } });
  for (const cwd of ['/sample-project', '/sample-project/', '/sample-project/./', '/sample-x/../sample-project']) await h.call({ cwd });
  assert.equal(h.calls.loads, 1);
  for (const cwd of ['C:\\sample-win', 'C:/sample-win', 'C:\\sample-win\\']) await h.call({ agentId: 'w', cwd });
  assert.equal(h.calls.loads, 2);
  assert.deepEqual(h.identities('agent:w'), ['project:C:/sample-win/.claude/rules-on-demand:win.md']);
});

test('G1b: a claim made from an overtaken load does not block the same name in the newest set', async () => {
  const gates = [];
  const opened = [new Promise((resolve) => { gates[0] = resolve; }), new Promise((resolve) => { gates[1] = resolve; })];
  const h = host({ root: '/sample-a', gate: async (load) => { if (load <= 2) await opened[load - 1]; }, files: {
    '/sample-a/.claude/rules-on-demand/shared.md': ruleText('A body.'),
    '/sample-b/.claude/rules-on-demand/shared.md': ruleText('B body.'),
  } });
  const first = h.call({ cwd: '/sample-a' });
  while (h.calls.loads < 1) await tick();
  h.setRoot('/sample-b');
  const second = h.call({ cwd: '/sample-b' });
  while (h.calls.loads < 2) await tick();
  gates[0]();
  assert.match((await first).deny ?? '', /A body\./);
  gates[1]();
  assert.match((await second).deny ?? '', /B body\./);
});
