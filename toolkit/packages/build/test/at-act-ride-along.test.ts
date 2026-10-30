import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

type Spec = { triggers: Record<string, unknown>[], compliance: Record<string, unknown> }
type Trigger = { kind: string, beforeFirstAct: boolean }
type Rule = { name: string, triggers: Trigger[] }
type Input = Record<string, unknown>
type Item = { channel: string, tool: string, command: unknown, path: unknown, input: Input }
const engine = (file: string) => new URL(`../../../../plugins/wt-rules-on-demand/${file}`, import.meta.url).href
const { readSpec, frontmatter } = await import(engine('scripts/rule-lifecycle-lib.mjs')) as {
  readSpec: (path: string) => Promise<Spec>, frontmatter: (spec: Spec) => string,
}
const { parseRuntimeRule } = await import(engine('hooks/runtime-rule.js')) as {
  parseRuntimeRule: (name: string, text: string) => Rule,
}
const { triggerMatches } = await import(engine('hooks/trigger-match.js')) as {
  triggerMatches: (trigger: Trigger, item: Item, onError: (error: unknown) => never) => boolean,
}
type Handler = (host: object, event: Input, next: () => Promise<Input>) => Promise<Input>
const { register, resetForSelftest } = await import(engine('hooks/hooks.js')) as {
  register: (on: (event: string, handler: Handler) => void, options: { enabled: boolean }) => void,
  resetForSelftest: () => void,
}
const RULES_DIR = fileURLToPath(new URL('../../../../plugin/rules/', import.meta.url))
const VERIFY = 'wt-verify-by-ground-truth-at-act'
const WORKTREE = 'wt-concurrent-sessions-worktree-at-act'
const DELEGATION = ['wt-delegation-ladder-at-act', 'wt-delegation-routing-at-act', 'wt-delegation-addressing-at-act']
const CHANGED = [VERIFY, WORKTREE, ...DELEGATION, 'wt-proportionate-verification-at-act']
const MESSAGE_RULES = readdirSync(RULES_DIR).filter((file) => {
  if (!file.endsWith('-at-act.spec.json')) return false
  const spec = JSON.parse(readFileSync(join(RULES_DIR, file), 'utf8')) as { 'on-demand': Spec }
  return spec['on-demand'].triggers.some((trigger) => trigger.kind === 'tool'
    && typeof trigger.tool === 'string' && new RegExp(trigger.tool).test('SendMessage'))
}).map((file) => file.replace('.spec.json', ''))
const load = async (name: string) => parseRuntimeRule(name, frontmatter(await readSpec(join(RULES_DIR, `${name}.spec.json`))) + 'body\n')
const matching = (rule: Rule, tool: string, input: Input = {}) => rule.triggers.filter((trigger) => triggerMatches(
  trigger, { channel: 'tool', tool, input, command: input.command, path: input.file_path ?? '' },
  (error) => { throw new Error(JSON.stringify(error)) },
))
const refuses = (rule: Rule, tool: string, input: Input = {}) => matching(rule, tool, input).some((trigger) => trigger.beforeFirstAct)

async function deliveryFixture() {
  const text = frontmatter(await readSpec(join(RULES_DIR, `${VERIFY}.spec.json`))) + 'Read the result.\n'
  resetForSelftest()
  const handlers = new Map<string, Handler>()
  const store = new Map<string, unknown>()
  register((event, handler) => { handlers.set(event, handler) }, { enabled: true })
  const host = {
    env: { get: async (key: string) => key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
    fs: {
      list: async (dir: string) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: `${VERIFY}.md` }] : [],
      read: async () => text,
      stat: async (path: string) => ({ kind: 'file', size: text.length, realPath: path }),
    },
    ui: { log: async () => {} },
    session: { id: async () => 'synthetic-session', messages: async () => [] },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } },
  }
  return (event: Input, next: () => Promise<Input>) => handlers.get('tool.call')!(host, { cwd: '/synthetic-project', ...event }, next)
}

it.each(['Bash', 'Agent'])('delivers verify guidance beside the actual %s result without refusing', async (tool) => {
  const call = await deliveryFixture()
  let executed = false
  const result = await call({ tool, command: 'pnpm test', input: { command: 'pnpm test' } }, async () => {
    executed = true
    return { output: 'original result', context: ['prior context'] }
  })
  expect(executed, `${tool} must execute before guidance is delivered`).toBe(true)
  expect(result.deny).toBeUndefined()
  expect(result.output).toBe('original result')
  expect(result.context).toEqual(['prior context', expect.stringContaining('Read the result.')])
})

const GATES = [
  'pnpm test', 'tsc --noEmit', 'eslint .', 'curl http://localhost:5174/x', 'node --test x.test.mjs',
  'vitest run', 'jest', 'pytest', 'bun test', 'make test', 'mypy src', 'ruff check .', 'ps aux > processes.log',
  'curl -s http://127.0.0.1:5174/', 'node plugin/bin/wt-observe.mjs start', 'go test ./...',
  'cargo test', 'cargo clippy', 'pnpm build', 'npm run check', 'git merge topic',
]
it.each(GATES)('verify rides alongside Bash %s', async (command) => {
  const rule = await load(VERIFY)
  expect(matching(rule, 'Bash', { command }).length, command).toBeGreaterThan(0)
  expect(refuses(rule, 'Bash', { command }), command).toBe(false)
  expect(matching(rule, 'Bash', { command: 'git diff --check' })).toEqual([])
  expect(matching(rule, 'Bash', { command: 'ps aux' })).toEqual([])
  for (const trigger of rule.triggers.filter((entry) => entry.kind === 'bash')) expect(trigger.beforeFirstAct).toBe(false)
})

it('verify rides alongside Agent but still refuses source edits', async () => {
  const rule = await load(VERIFY)
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    expect(refuses(rule, tool, { file_path: 'src/example.ts' }), tool).toBe(true)
  }
  expect(matching(rule, 'Read', { file_path: 'src/example.ts' })).toEqual([])
  expect(matching(rule, 'Agent', { prompt: 'Inspect source' }).length).toBeGreaterThan(0)
  expect(refuses(rule, 'Agent', { prompt: 'Inspect source' })).toBe(false)
})

const NAMED = [
  'alice', 'team[workers]', 'mainline', 'Main', 'main-2', 'team-leader', 'parent',
  'a', 'a0123456789abcde', 'a0123456789abcdef0', 'a0123456789abcdeF',
  'worker-a0123456789abcdef', 'a0123456789abcdef-worker', 'a0123456789abcdef [worker]',
]
it.each(MESSAGE_RULES)('every SendMessage at-act rule excludes only exact raw ids: %s', async (name) => {
  const rule = await load(name)
  for (const to of ['a0123456789abcdef', 'a0000000000000000', 'affffffffffffffff']) {
    expect(matching(rule, 'SendMessage', { to, message: 'progress' }), `${name}: ${to}`).toEqual([])
  }
  for (const to of NAMED) {
    expect(matching(rule, 'SendMessage', { to, message: 'progress' }).length, `${name}: ${to}`).toBeGreaterThan(0)
  }
  for (const to of ['main', 'team-lead', 'main [worker]', 'team-lead  [worker]']) {
    expect(matching(rule, 'SendMessage', { to }), `${name}: ${to}`).toEqual([])
  }
})

it.each(DELEGATION)('delegation retains named recipients and excludes exact raw ids: %s', async (name) => {
  const rule = await load(name)
  for (const tool of ['Agent', 'Workflow']) expect(refuses(rule, tool), `${name}: ${tool}`).toBe(true)
  for (const to of NAMED) {
    expect(refuses(rule, 'SendMessage', { to, message: 'progress' }), `${name}: ${to}`).toBe(true)
  }
  for (const to of ['main', 'team-lead', 'main [worker]', 'team-lead  [worker]']) {
    expect(matching(rule, 'SendMessage', { to }), `${name}: ${to}`).toEqual([])
  }
  for (const to of ['a0123456789abcdef', 'a0000000000000000', 'affffffffffffffff']) {
    expect(matching(rule, 'SendMessage', { message: 'progress', to }), `${name}: ${to}`).toEqual([])
  }
})

const GOVERNED = [
  'git worktree add ../x', 'git worktree remove ../x', 'git worktree move ../x ../y',
  'git reset --hard HEAD', 'git rebase main', 'git merge topic', 'git pull', 'gh pr merge 123',
  'git -c color.ui=false worktree add ../x', String.raw`git -C C:\x worktree add ../x`,
]
it.each(['git worktree list', 'git worktree prune', 'git worktree list --porcelain', String.raw`git -C C:\x worktree list`])(
  'worktree reads do not trigger isolation: %s', async (command) => {
    const rule = await load(WORKTREE)
    for (const act of GOVERNED) expect(refuses(rule, 'Bash', { command: act }), act).toBe(true)
    expect(refuses(rule, 'Agent')).toBe(true)
    expect(matching(rule, 'Bash', { command }), command).toEqual([])
    for (const unrelated of ['git worktree addendum', 'git worktree add-extra', 'git WORKTREE add ../x', 'git merge-base main HEAD']) {
      expect(matching(rule, 'Bash', { command: unrelated }), unrelated).toEqual([])
    }
  },
)

function classify(rules: Rule[], tool: string, input: Input = {}) {
  const result: { refuses: string[], rides: string[] } = { refuses: [], rides: [] }
  for (const rule of rules) {
    const selected = matching(rule, tool, input)
    if (selected.some((trigger) => trigger.beforeFirstAct)) result.refuses.push(rule.name)
    else if (selected.length) result.rides.push(rule.name)
  }
  return result
}

it('classifies refusing and riding rules across the shipped family', async () => {
  const names = readdirSync(RULES_DIR).filter((name) => name.endsWith('-at-act.spec.json')).sort()
  const rules = await Promise.all(names.map((name) => load(name.replace('.spec.json', ''))))
  for (const command of GATES.filter((command) => command !== 'git merge topic')) {
    expect(classify(rules, 'Bash', { command }), command).toEqual({ refuses: [], rides: [VERIFY] })
  }
  for (const command of ['git worktree list', 'git worktree prune']) {
    expect(classify(rules, 'Bash', { command }), command).toEqual({ refuses: [], rides: [] })
  }
  for (const command of GOVERNED.slice(0, 5)) {
    expect(classify(rules, 'Bash', { command }), command).toEqual({ refuses: [WORKTREE], rides: [] })
  }
  expect(classify(rules, 'SendMessage', { to: 'a0123456789abcdef' })).toEqual({ refuses: [], rides: [] })
  const spawn = classify(rules, 'Agent')
  expect(spawn.rides).toEqual([VERIFY])
  expect(spawn.refuses).toEqual(expect.arrayContaining([WORKTREE, ...DELEGATION]))
  expect(classify(rules, 'Workflow').refuses).toEqual(expect.arrayContaining(DELEGATION))
  expect(classify(rules, 'Edit', { file_path: 'src/example.ts' }).refuses).toContain(VERIFY)
  expect(classify(rules, 'SendMessage', { to: 'alice' }).refuses).toEqual(expect.arrayContaining(DELEGATION))
})

it.each(CHANGED)('keeps the revised contract through CRLF JSON and frontmatter: %s', async (name) => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-ride-along-'))
  try {
    const path = join(dir, 'rule.spec.json')
    writeFileSync(path, readFileSync(join(RULES_DIR, `${name}.spec.json`), 'utf8').replace(/\r?\n/g, '\r\n'))
    const spec = await readSpec(path)
    const rule = parseRuntimeRule(name, frontmatter(spec).replace(/\n/g, '\r\n') + 'body\r\n')
    expect(rule.triggers.map((trigger) => trigger.beforeFirstAct)).toEqual(spec.triggers.map((trigger) => trigger['before-first-act']))
    if (name === VERIFY) expect(refuses(rule, 'Bash', { command: 'pnpm test' })).toBe(false)
    else if (name === WORKTREE) expect(matching(rule, 'Bash', { command: 'git worktree list' })).toEqual([])
    else expect(matching(rule, 'SendMessage', { to: 'a0123456789abcdef' })).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
