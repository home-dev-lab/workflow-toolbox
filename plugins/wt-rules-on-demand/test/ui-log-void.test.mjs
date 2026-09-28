import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';

// The host declares `ui.log(message: string): void` — it returns undefined, never a promise.
const rule = `---\non-demand:\n  triggers:\n    - kind: tool\n      tool: ^Write$\n      unconditional: true\n  compliance:\n    kind: none\n    reason: fixture\n---\nFollow this rule.\n`;

function host(files) {
  resetForSelftest();
  const handlers = new Map(), stored = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/config', HOME: '/home' })[name] },
    fs: {
      list: async (dir) => [...files.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => ({ kind: 'file', name: path.slice(dir.length + 1) })),
      read: async (path) => files.get(path),
      stat: async (path) => ({ kind: files.has(path) ? 'file' : 'dir', size: files.get(path)?.length ?? 0, realPath: path }),
    },
    ui: { log: () => undefined },
    store: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value) },
    session: { id: async () => 'fixture', messages: async () => [] },
    model: { classify: async () => 'followed' },
  };
  return { call: (event) => handlers.get('tool.call')($, { cwd: '/project', ...event }, async () => ({})),
    prompt: (event, next) => handlers.get('prompt.submit')($, { cwd: '/project', ...event }, next) };
}

test('a void ui.log never aborts the ride-along: the served rule reaches the result', async () => {
  const f = host(new Map([['/config/rules-on-demand/ride.md', rule]]));
  const result = await f.call({ tool: 'Write', file_path: '/a', content: 'x' });
  assert.match((result?.context ?? []).join('\n'), /<rule name="ride\.md">/);
});

test('a void ui.log never aborts prompt serving', async () => {
  const f = host(new Map([['/config/rules-on-demand/prompt.md', rule.replace('    - kind: tool\n      tool: ^Write$\n      unconditional: true', '    - kind: prompt\n      regex: hello')]]));
  const seen = [];
  await assert.doesNotReject(f.prompt({ text: 'hello' }, async (event) => { seen.push(event); return {}; }));
  assert.match((seen[0]?.context ?? []).join('\n'), /<rule name="prompt\.md">/);
});
