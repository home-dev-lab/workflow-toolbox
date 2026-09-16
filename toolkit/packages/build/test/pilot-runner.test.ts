import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createSdkMcpServer, query as sdkQuery, tool } from '@anthropic-ai/claude-agent-sdk'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { defaultArchiveRoot, lifecycleCanUseTool, loadProfileEnv, parsePilotRunnerArgs, runPilot } from '../../../../plugin/bin/lib/pilot-runner-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { AWAITING_FIDELITY_RESULT, LIFECYCLE_MCP_KEY, lifecycleToolName } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { MAX_CRITIC_ROUNDS, PLAN_SHAPE_DESCRIPTION } from '../../../../plugin/bin/lib/lifecycle-state-machine.mjs'
const CONTEXT_PREFIX = 'mcp__plugin_context-mode_context-mode__'
const CONTEXT_MODE_TOOLS = {
  batchExecute: `${CONTEXT_PREFIX}ctx_batch_execute`, doctor: `${CONTEXT_PREFIX}ctx_doctor`, execute: `${CONTEXT_PREFIX}ctx_execute`,
  executeFile: `${CONTEXT_PREFIX}ctx_execute_file`, fetchAndIndex: `${CONTEXT_PREFIX}ctx_fetch_and_index`, index: `${CONTEXT_PREFIX}ctx_index`,
  insight: `${CONTEXT_PREFIX}ctx_insight`, purge: `${CONTEXT_PREFIX}ctx_purge`, search: `${CONTEXT_PREFIX}ctx_search`, stats: `${CONTEXT_PREFIX}ctx_stats`,
}
const resolveContextModeRoot = (env: NodeJS.ProcessEnv) => join(env.CLAUDE_CONFIG_DIR || join(env.HOME ?? '', '.claude'), 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.177')

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-pilot-runner.mjs')
const PLUGIN_ROOT = join(ROOT, 'plugin')
const SDK_RESOLVER = join(PLUGIN_ROOT, 'bin/lib/sdk-resolution.mjs')
// The runner now REQUIRES a valid first `system:init` receipt: a fake stream without one used to
// pass while proving nothing about whether any plugin or lifecycle tool ever loaded.
const initMessage = (model?: string) => ({
  type: 'system',
  subtype: 'init',
  ...(model === undefined ? {} : { model }),
  tools: ['Read', 'Glob', 'Grep', ...Object.values(CONTEXT_MODE_TOOLS), lifecycleToolName('transition'), lifecycleToolName('write_artifact'), lifecycleToolName('route_finding'), lifecycleToolName('run')],
  plugins: [{ path: join(PLUGIN_ROOT, 'hooks-modules', 'pilot-guard') }, { path: resolveContextModeRoot(process.env) }, { name: 'wt-sdk-pilot' }],
  skills: ['wt-sdk-pilot:stale-card-sweep', 'wt-sdk-pilot:lesson-harvest', 'wt-sdk-pilot:deep-grounding'],
})
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-pilot-runner-')); roots.push(root)
  // The card tree is a real WORKTREE of the project, as in production: the runner's default archive
  // root is the checkout that owns the worktree, and a nested standalone repo would have no outside.
  writeFileSync(join(root, '.gitignore'), '.claude/reports/\n.lane/\n'); writeFileSync(join(root, 'tracked.txt'), 'base\n')
  const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Pilot Runner'); git('config', 'commit.gpgSign', 'false')
  git('add', '-A'); git('commit', '-qm', 'base')
  const dir = join(root, 'worktree'); git('worktree', 'add', '-q', '-b', 'card', dir)
  mkdirSync(join(dir, '.lane'), { recursive: true })
  const contract = join(root, 'contract.md'); writeFileSync(contract, '# contract\n')
  const cardFile = join(root, 'card.md'); writeFileSync(cardFile, 'Route: LITE\n## Definition of done\n- exercise the runner\n')
  return { root, dir, contract, cardFile }
}
function freshFixture() {
  const f = fixture()
  mkdirSync(join(f.dir, 'toolkit'))
  writeFileSync(join(f.dir, 'toolkit', 'package.json'), JSON.stringify({ devDependencies: { '@anthropic-ai/claude-agent-sdk': '*' } }))
  spawnSync('git', ['add', 'toolkit/package.json'], { cwd: f.dir })
  return f
}
function fakeSdk(root: string, marker: string) {
  const packageDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', main: 'index.cjs' }))
  writeFileSync(join(packageDir, 'index.cjs'), `module.exports = { marker: ${JSON.stringify(marker)} }\n`)
}
function resolveSdkInChild(options: Record<string, unknown>) {
  const script = `const { resolveAgentSdkRequire } = await import(${JSON.stringify(SDK_RESOLVER)}); try { const require = resolveAgentSdkRequire(${JSON.stringify(options)}); process.stdout.write(JSON.stringify({ marker: require('@anthropic-ai/claude-agent-sdk').marker, path: require.resolve('@anthropic-ai/claude-agent-sdk') })) } catch (error) { process.stdout.write(error.message) }`
  const env = { ...process.env }
  delete env.NODE_PATH
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env })
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('SDK pilot runner', () => {
  it('records the launching session id and replaces an existing env log', () => {
    for (const [sessionId, expected] of [['session-set', 'CLAUDE_CODE_SESSION_ID=session-set\n'], [undefined, 'CLAUDE_CODE_SESSION_ID=\n']] as const) {
      const started = fixture()
      const env = { ...process.env }
      if (sessionId === undefined) delete env.CLAUDE_CODE_SESSION_ID
      else env.CLAUDE_CODE_SESSION_ID = sessionId
      spawnSync(process.execPath, [CLI, '--card', '1', '--dir', started.dir, '--card-file', started.cardFile, '--contract', join(started.root, 'missing-contract.md')], { env, encoding: 'utf8' })
      expect(readFileSync(join(started.dir, '.lane', 'env.log'), 'utf8')).toBe(expected)
    }

    const existing = fixture()
    writeFileSync(join(existing.dir, '.lane', 'env.log'), 'CLAUDE_CODE_SESSION_ID=lane-session\n')
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'runner-session' }
    spawnSync(process.execPath, [CLI, '--card', '1', '--dir', existing.dir, '--card-file', existing.cardFile, '--contract', join(existing.root, 'missing-contract.md')], { env, encoding: 'utf8' })
    expect(readFileSync(join(existing.dir, '.lane', 'env.log'), 'utf8')).toBe('CLAUDE_CODE_SESSION_ID=runner-session\n')
  })

  it('has no up-front lane-consent refusal path', () => {
    const source = readFileSync(CLI, 'utf8')
    expect(source).not.toContain('sdk-runner-consent')
    expect(source).not.toContain('sdkRunnerConsentRefusal')
  })

  it('parses required arguments and refuses absent card, bad timeout, and malformed profile env', () => {
    expect(parsePilotRunnerArgs(['--dir', '/tmp/a'])).toMatchObject({ error: 'missing required --card or --dir' })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a'])).toMatchObject({ error: '--card-file is required: the route is derived from the card' })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md', '--timeout', '0'])).toMatchObject({ error: '--timeout must be a positive number of seconds' })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md'])).toMatchObject({ cardFile: '/tmp/card.md' })
    const f = fixture(); const profile = join(f.root, 'profile.json'); writeFileSync(profile, '{"env":{"X":3}}')
    expect(() => loadProfileEnv(profile)).toThrow('--profile-env env.X must be a string')
    const result = spawnSync(process.execPath, [CLI, '--dir', f.dir], { encoding: 'utf8' })
    expect(result.status).toBe(2); expect(result.stderr).toContain('missing required --card or --dir')
  })

  it('parses repeatable absolute plugin directories and refuses a relative one', () => {
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md', '--plugin-dir', '/tmp/rules', '--plugin-dir', '/tmp/lsp']))
      .toMatchObject({ pluginDirs: ['/tmp/rules', '/tmp/lsp'] })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md', '--plugin-dir', 'relative/plugin']))
      .toEqual({ error: '--plugin-dir must be an absolute path: relative/plugin' })
  })

  it('parses --board-contract and leaves it optional until route_finding is called', () => {
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md', '--board-contract', 'board.json']))
      .toMatchObject({ boardContract: resolve('board.json') })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md'])).toMatchObject({ boardContract: null })
  })

  it('parses --archive-root as an absolute path and defaults the archive root to the checkout that owns the worktree', () => {
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md', '--archive-root', 'rel/project'])).toMatchObject({ archiveRoot: resolve('rel/project') })
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md'])).toMatchObject({ archiveRoot: null })
    // An explicit project root wins outright.
    expect(defaultArchiveRoot({ dir: '/tmp/a', projectRoot: '/srv/project' })).toBe('/srv/project')
    // A real worktree resolves to the main checkout that owns it, never to itself.
    const main = mkdtempSync(join(tmpdir(), 'wt-archive-root-main-')); roots.push(main)
    const git = (...args: string[]) => spawnSync('git', args, { cwd: main, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Archive Root'); git('config', 'commit.gpgSign', 'false')
    writeFileSync(join(main, 'tracked.txt'), 'base\n'); git('add', '-A'); git('commit', '-qm', 'base')
    const worktree = join(main, 'wt'); expect(git('worktree', 'add', '-q', '-b', 'archive-root-proof', worktree).status).toBe(0)
    expect(realpathSync(defaultArchiveRoot({ dir: worktree }))).toBe(realpathSync(main))
    // A plain repository has no outside: it resolves to itself, and the preflight refuses it.
    expect(realpathSync(defaultArchiveRoot({ dir: main }))).toBe(realpathSync(main))
  })

  it('rejects the removed lane-silence option and omits it from usage', () => {
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md'])).not.toHaveProperty('laneSilence')
    expect(parsePilotRunnerArgs(['--card', '1', '--dir', '/tmp/a', '--card-file', '/tmp/card.md', '--lane-silence', '3'])).toMatchObject({ error: 'unknown argument: --lane-silence' })
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0); expect(result.stdout).not.toContain('--lane-silence')
  })

  it.each([
    ['prompt', (f: ReturnType<typeof fixture>) => ({ option: join(f.root, 'kb-prompt', 'MEMORY.md'), env: { WT_KNOWLEDGE_BASE_INDEX: join(f.root, 'kb-env', 'MEMORY.md') } })],
    ['environment', (f: ReturnType<typeof fixture>) => ({ env: { WT_KNOWLEDGE_BASE_INDEX: join(f.root, 'kb-env', 'MEMORY.md') } })],
    ['derived', (f: ReturnType<typeof fixture>) => ({ env: { CLAUDE_CONFIG_DIR: join(f.root, 'config') } })],
  ])('names the %s knowledge-base index in the pilot prompt and allows Read for that index and its fiches only', async (_source, setup) => {
    const f = fixture()
    const configured = setup(f) as { option?: string, env: Record<string, string> }
    if (configured.env.CLAUDE_CONFIG_DIR) {
      const parent = join(configured.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'context-mode', 'context-mode')
      mkdirSync(parent, { recursive: true })
      symlinkSync(resolveContextModeRoot(process.env), join(parent, '1.0.177'))
    }
    const derived = join(configured.env.CLAUDE_CONFIG_DIR ?? '', 'projects', f.dir.replace(/[^A-Za-z0-9-]/g, '-'), 'memory', 'MEMORY.md')
    const index = configured.option ?? configured.env.WT_KNOWLEDGE_BASE_INDEX ?? derived
    mkdirSync(join(index, '..'), { recursive: true }); writeFileSync(index, '# Memory\n')
    const prompts: string[] = []; let canUseTool: ((name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>) | undefined
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { canUseTool: typeof canUseTool, plugins: Array<{ path: string }> } }) => (async function* () {
      canUseTool = options.canUseTool
      yield { ...initMessage(), plugins: options.plugins }
      prompts.push((await prompt.next()).value.message.content)
    })()
    await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false, knowledgeBaseIndex: configured.option }, { query, resolvePilotModels: models, env: configured.env })
    expect(prompts[0]).toContain(`KNOWLEDGE_BASE_INDEX: ${index}`)
    expect((await canUseTool?.('Read', { file_path: index }))?.behavior).toBe('allow')
    expect((await canUseTool?.('Read', { file_path: join(f.root, 'other.md') }))?.behavior).toBe('deny')
    const fiche = join(index, '..', 'archive', 'a-fiche.md'); mkdirSync(join(fiche, '..'), { recursive: true }); writeFileSync(fiche, 'fiche\n')
    expect((await canUseTool?.('Read', { file_path: fiche }))?.behavior).toBe('allow')
    writeFileSync(join(index, '..', 'notes.txt'), 'x\n')
    expect((await canUseTool?.('Read', { file_path: join(index, '..', 'notes.txt') }))?.behavior).toBe('deny')
    symlinkSync(join(f.root, 'outside.md'), join(index, '..', 'escape.md')); writeFileSync(join(f.root, 'outside.md'), 'x\n')
    expect((await canUseTool?.('Read', { file_path: join(index, '..', 'escape.md') }))?.behavior).toBe('deny')
  })

  it('places the required arbiter card file verbatim in the first prompt and states an absent knowledge index', async () => {
    const f = fixture(); const cardFile = join(f.root, 'card.md'); const card = '# Card title\n\nDefinition of done: ship it.\n'
    writeFileSync(cardFile, card)
    const prompts: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage()
      const first = await prompt.next(); prompts.push(first.value.message.content)
    })()
    const models = () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } })
    await runPilot({ card: '186', cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query, resolvePilotModels: models })
    expect(prompts[0]).toContain(`## The card, verbatim\n\n${card}`)
    expect(prompts[0]).toContain('do not re-read the card from the board; the text above is the card')
    expect(prompts[0]).toContain('Lanes run synchronously through the lifecycle run tool')
    expect(prompts[0]).not.toContain('end your turn immediately after launch')
    expect(prompts[0]).toContain('KNOWLEDGE_BASE_INDEX: none (no index exists at ')

  })

  it('refuses a card with no DoD criterion before query starts', async () => {
    const f = fixture(); writeFileSync(f.cardFile, 'Route: LITE\n## Notes\n- no acceptance here\n')
    let queried = false
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 1, hard: false }, {
      query: () => { queried = true; return (async function* () {})() }, resolvePilotModels: models,
    })).rejects.toThrow('add a Definition of done to the card')
    expect(queried).toBe(false)
  })

  it('freezes the selected executor family and role models once in route.json', async () => {
    const f = fixture(); let resolutions = 0
    const query = () => (async function* () { yield initMessage() })()
    await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }, {
      query,
      resolvePilotModels: () => ({ pilot: { value: 'opus', effective: 'opus' }, pilotHard: { value: 'fable', effective: 'fable' } }),
      resolveExecutorProfile: () => { resolutions += 1; return { executor: 'claude-sdk', models: { code: 'sonnet', review: 'opus', refutation: 'opus' } } },
    })
    expect(resolutions).toBe(1)
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'route.json'), 'utf8'))).toMatchObject({ executor: 'claude-sdk', models: { code: 'sonnet', review: 'opus', refutation: 'opus' } })
  })

  it('refuses relaunch on an interrupted lifecycle with one complete reset remedy', async () => {
    const f = fixture()
    const query = () => (async function* () { yield initMessage() })()
    const options = { card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }
    await runPilot(options, { query, resolvePilotModels: models })
    const refusal = await runPilot(options, { query, resolvePilotModels: models }).then(() => null, (error: Error) => error.message)
    expect(refusal).toMatch(new RegExp(`interrupted lifecycle.*node -e .*${join(f.dir, '.lane').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    // The printed remedy KEEPS the interrupted run's evidence: executing it moves .lane aside as a sibling and
    // leaves a fresh empty .lane; a remedy that deleted the directory would destroy the only record of a crash.
    const remedy = /node -e (".*?") (".*")$/.exec(String(refusal))!
    const before = readFileSync(join(f.dir, '.lane', 'route.json'), 'utf8')
    const executed = spawnSync(process.execPath, ['-e', JSON.parse(remedy[1]!), JSON.parse(remedy[2]!)], { encoding: 'utf8' })
    expect(executed.status, executed.stderr).toBe(0)
    const kept = readdirSync(f.dir).filter((name) => name.startsWith('.lane.interrupted-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(f.dir, kept[0]!, 'route.json'), 'utf8')).toBe(before)
    expect(readdirSync(join(f.dir, '.lane'))).toEqual([])
  })

  it('uses the runner install when a fresh target tracks toolkit/package.json without node_modules', async () => {
    const f = freshFixture(); let reachedQuery = false
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      reachedQuery = true
      yield initMessage()
      await prompt.next()
    })()
    await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
    })
    expect(reachedQuery).toBe(true)
  })

  it('resolves the SDK from the target project before plugin data', () => {
    const f = fixture(); const pluginData = join(f.root, 'workflow-toolbox-test data')
    fakeSdk(f.dir, 'project'); fakeSdk(pluginData, 'plugin-data')
    const result = resolveSdkInChild({ ownToolkitManifest: join(f.root, 'missing-own/package.json'), projectDir: f.dir, env: { CLAUDE_PLUGIN_DATA: pluginData }, npmRoot: null })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ marker: 'project', path: expect.stringContaining(join(f.dir, 'node_modules')) })
  })

  it('resolves the SDK from CLAUDE_PLUGIN_DATA after the target project', () => {
    const f = fixture(); const pluginData = join(f.root, 'workflow-toolbox-test data'); fakeSdk(pluginData, 'plugin-data')
    const result = resolveSdkInChild({ ownToolkitManifest: join(f.root, 'missing-own/package.json'), projectDir: f.dir, env: { CLAUDE_PLUGIN_DATA: pluginData }, npmRoot: null })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ marker: 'plugin-data', path: expect.stringContaining(join(pluginData, 'node_modules')) })
  })

  it('resolves the SDK from the global npm root after local candidates', () => {
    const f = fixture(); const globalPrefix = join(f.root, 'global'); fakeSdk(globalPrefix, 'global')
    const result = resolveSdkInChild({ ownToolkitManifest: join(f.root, 'missing-own/package.json'), projectDir: f.dir, env: {}, npmRoot: join(globalPrefix, 'node_modules') })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ marker: 'global', path: expect.stringContaining(join(globalPrefix, 'node_modules')) })
  })

  it('keeps the development toolkit install ahead of project dependencies', () => {
    const f = fixture(); fakeSdk(f.dir, 'project')
    const result = resolveSdkInChild({ projectDir: f.dir, env: {}, npmRoot: null })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ path: expect.stringContaining(join(ROOT, 'toolkit', 'node_modules')) })
    expect(JSON.parse(result.stdout).marker).not.toBe('project')
  })

  it('ignores a CLAUDE_PLUGIN_DATA that belongs to another plugin, for resolution and for the remedy', () => {
    const f = fixture(); const foreign = join(f.root, 'codex-openai-codex'); fakeSdk(foreign, 'foreign')
    const common = { ownToolkitManifest: join(f.root, 'missing-own/package.json'), projectDir: f.dir, npmRoot: null }
    const result = resolveSdkInChild({ ...common, env: { CLAUDE_PLUGIN_DATA: foreign } })
    expect(result.stdout).toBe('@anthropic-ai/claude-agent-sdk is not installed; run: npm install -g @anthropic-ai/claude-agent-sdk')
  })

  it('refuses unresolved SDK installs with the exact global or plugin-data one-line remedy', () => {
    const f = fixture(); const pluginData = join(f.root, 'workflow-toolbox-test data')
    const common = { ownToolkitManifest: join(f.root, 'missing-own/package.json'), projectDir: f.dir, npmRoot: null }
    const global = resolveSdkInChild({ ...common, env: {} })
    expect(global.stdout).toBe('@anthropic-ai/claude-agent-sdk is not installed; run: npm install -g @anthropic-ai/claude-agent-sdk')
    expect(global.stdout).not.toContain('\n')
    const local = resolveSdkInChild({ ...common, env: { CLAUDE_PLUGIN_DATA: pluginData } })
    // The literal path, never "$CLAUDE_PLUGIN_DATA": that variable is not set in the terminal where the remedy is pasted.
    expect(local.stdout).toBe(`@anthropic-ai/claude-agent-sdk is not installed; run: npm install --prefix "${pluginData}" @anthropic-ai/claude-agent-sdk`)
    expect(local.stdout).not.toContain('\n')
    const windows = resolveSdkInChild({ ...common, env: { CLAUDE_PLUGIN_DATA: pluginData }, platform: 'win32' })
    expect(windows.stdout).toBe(`@anthropic-ai/claude-agent-sdk is not installed; run: npm install --prefix "${pluginData}" @anthropic-ai/claude-agent-sdk`)
  })

  it('starts SDK resolution from an installed plugin using the target project', () => {
    const f = fixture(); fakeSdk(f.dir, 'project')
    const installed = join(f.root, 'installed-plugin'); cpSync(PLUGIN_ROOT, installed, { recursive: true })
    const configDir = join(f.root, 'config'); mkdirSync(configDir); writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {} }))
    const profile = join(f.root, 'bad-profile.json'); writeFileSync(profile, '{bad')
    const result = spawnSync(process.execPath, [join(installed, 'bin/wt-pilot-runner.mjs'), '--card', '1', '--dir', f.dir, '--card-file', f.cardFile, '--contract', f.contract, '--profile-env', profile], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, NODE_PATH: '', NPM_CONFIG_PREFIX: join(f.root, 'empty-global') } })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot read --profile-env')
    expect(result.stderr).not.toContain('@anthropic-ai/claude-agent-sdk is not installed')
  })

  it('derives plan-phase guidance and invalid-plan refusal from one grammar description', async () => {
    const f = fixture(); writeFileSync(f.cardFile, 'Route: FULL\n## Definition of done\n- plan it\n')
    let continuation = ''; let refusal = ''
    type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { mcpServers: Record<string, unknown> } }) => (async function* () {
      const server = options.mcpServers[LIFECYCLE_MCP_KEY] as RegisteredServer
      const transition = server.instance._registeredTools.transition!.handler
      const artifact = server.instance._registeredTools.write_artifact!.handler
      yield initMessage(); await prompt.next()
      await transition({ phase: 'discovery', record: 'test discovery\n', tool_use_id: 'discovery' })
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      continuation = (await prompt.next()).value.message.content
      await artifact({ kind: 'plan', content: '## Tasks\n- incomplete\n' })
      refusal = (await transition({ phase: 'plan', tool_use_id: 'invalid-plan' })).content[0]!.text
    })()
    await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }, { query, resolvePilotModels: models, sleep: async () => {} })
    expect(continuation).toContain(PLAN_SHAPE_DESCRIPTION)
    expect(refusal).toContain(PLAN_SHAPE_DESCRIPTION)
  })

  it('logs a timeout injection and counts it in the summary', async () => {
    const f = fixture(); const logged: string[] = []; let calls = 0
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage()
      await prompt.next()
      const timeout = await prompt.next()
      expect(timeout.value.message.content).toContain('Runner timeout reached')
    })()
    const result = await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 1, hard: false }, {
      query,
      resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }),
      resolveExecutorProfile: () => ({ executor: 'gpt-lane', models: {} }),
      now: () => calls++ === 0 ? 0 : 1001,
      log: (line: string) => logged.push(line),
    })
    expect(logged).toEqual([
      'route=LITE reasons=human Route: LITE model=sonnet effective=sonnet executor=gpt-lane',
      'injected: timeout Runner timeout reached. Write .lane/pilot-report.md with the current state and end your turn.',
      'served model: unknown (requested sonnet)',
    ])
    expect(result.summary.injected_turns).toBe(1)
  })

  it('records requested and SDK-served models without trusting pilot prose', async () => {
    const run = async (initModel?: string, firstAssistantModel?: string) => {
      const f = fixture()
      const query = () => (async function* () {
        yield initMessage(initModel)
        yield { type: 'assistant', message: { model: firstAssistantModel, content: [] } }
      })()
      return runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: true }, {
        query,
        resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet', source: 'default' }, pilotHard: { value: 'opus', effective: 'opus', source: 'env' } }),
      })
    }

    // A remapped profile serves a different id than the requested alias ON PURPOSE: the two SDK
    // readings agree, so agreement is true and the request stays visible beside them.
    await expect(run('gpt-5.6-sol', 'gpt-5.6-sol')).resolves.toMatchObject({ summary: {
      requested_model: 'opus', served_model: 'gpt-5.6-sol', served_model_first_turn: 'gpt-5.6-sol', served_model_agreement: true,
    } })
    // The two SDK readings disagree with each other: that is the signal the field exists for.
    await expect(run('gpt-5.6-sol', 'claude-opus-5')).resolves.toMatchObject({ summary: {
      requested_model: 'opus', served_model: 'gpt-5.6-sol', served_model_first_turn: 'claude-opus-5',
      served_model_agreement: 'false (served_model=gpt-5.6-sol, served_model_first_turn=claude-opus-5; requested_model=opus)',
    } })
    await expect(run(undefined, 'opus')).resolves.toMatchObject({ summary: {
      requested_model: 'opus', served_model_agreement: 'unknown (init receipt carries no model)',
    } })
    await expect(run('opus', 'opus')).resolves.toMatchObject({ summary: {
      requested_model: 'opus', served_model: 'opus', served_model_first_turn: 'opus', served_model_agreement: true,
    } })
  })

  it('records assistant usage arrivals and attributes exact numbers across streamed phases', async () => {
    const f = fixture(); let clock = 1000
    type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<unknown> }> } }
    const query = ({ options }: { options: { mcpServers: Record<string, unknown> } }) => (async function* () {
      const transition = (options.mcpServers[LIFECYCLE_MCP_KEY] as RegisteredServer).instance._registeredTools.transition!.handler
      yield initMessage('claude-test')
      yield { type: 'assistant', message: { model: 'claude-test', usage: { input_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 11 }, content: [] } }
      await transition({ phase: 'discovery', record: 'discovery\n', tool_use_id: 'discovery' })
      // The SDK repeats one assistant message per content block with the same id and usage (measured: 121 entries, 65 ids
      // on the 2026-09-14 FULL run); a repeat must replace, never add.
      yield { type: 'assistant', message: { id: 'msg_b', model: 'claude-test', usage: { input_tokens: 13, cache_creation_input_tokens: 17, cache_read_input_tokens: 19, output_tokens: 20 }, content: [] } }
      yield { type: 'assistant', message: { id: 'msg_b', model: 'claude-test', usage: { input_tokens: 13, cache_creation_input_tokens: 17, cache_read_input_tokens: 19, output_tokens: 23 }, content: [] } }
      yield { type: 'result', usage: { input_tokens: 16, cache_creation_input_tokens: 22, cache_read_input_tokens: 26, output_tokens: 35 }, modelUsage: {
        'claude-test': { inputTokens: 16, cacheCreationInputTokens: 22, cacheReadInputTokens: 26, outputTokens: 35 },
        'claude-haiku-test': { inputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1 },
      } }
    })()
    await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query,
      now: () => clock += 100,
      resolvePilotModels: models,
      resolveExecutorProfile: () => ({ executor: 'claude-sdk', models: { code: 'sonnet', review: 'opus', refutation: 'opus' } }),
      lifecycleOptions: { now: () => clock += 100 },
    })
    const cost = JSON.parse(readFileSync(join(f.dir, '.lane', 'cost.json'), 'utf8'))
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'discovery').models['claude-test']).toMatchObject({ input: 3, cache_write: 5, output: 11, fresh_tokens: 19 })
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'tdd').models['claude-test']).toMatchObject({ input: 13, cache_write: 17, output: 23, fresh_tokens: 53 })
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'reconciled').models['claude-test']).toMatchObject({ output: 1, fresh_tokens: 1 })
    expect(cost.reconciled).toEqual([expect.objectContaining({ kind: 'terminal_result_output', tokens: 1 })])
    expect(cost.cross_checks.pilot_result).toMatchObject({ agrees: true, message_sum: { output: 34 }, attributed_sum: { output: 35 }, difference: { input: 0, cache_write: 0, cache_read: 0, output: 0, first_pass_input: 0, fresh_tokens: 0 } })
    expect(cost.cross_checks.model_usage).toMatchObject({ agrees: true, primary_model: 'claude-test', difference: { input: 0, output: 0, fresh_tokens: 0 } })
    expect(cost.phases.find((phase: { phase: string }) => phase.phase === 'unattributed').models['claude-haiku-test']).toMatchObject({ input: 2, output: 1, fresh_tokens: 3 })
  })

  it('defaults the contract and mailbox paths when called programmatically without them (the orchestrator driver)', async () => {
    const f = fixture(); let seen: Record<string, unknown> = {}
    const query = ({ options }: { options: Record<string, unknown> }) => (async function* () { seen = options; yield initMessage(); yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } } })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, timeout: 2, hard: false } as never, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), sleep: async () => {},
    })
    expect(typeof seen.systemPrompt).toBe('string'); expect(String(seen.systemPrompt)).toContain('lifecycle')
    expect(String(seen.systemPrompt)).toContain('## Standing rules (authoritative)')
    expect(String(seen.systemPrompt)).toContain('## Understand before coding')
    expect(result.summary.completed).toBe(false)
  })

  it('passes the .lane preflight in a fresh worktree where .lane does not exist yet (a directory pattern matches only an existing directory)', async () => {
    const f = fixture(); rmSync(join(f.dir, '.lane'), { recursive: true, force: true })
    const query = () => (async function* () { yield initMessage(); yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } } })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), sleep: async () => {},
    })
    expect(result.summary.completed).toBe(false)
  })

  it('recognises the awaiting_fidelity receipt in the real SDK content-block shape (found on real run 2: textFrom concatenated "text" with the text)', async () => {
    const f = fixture()
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage()
      await prompt.next()
      writeFileSync(join(f.dir, '.lane', 'pilot-report.md'), '# pilot\n')
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'lifecycle', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'lifecycle', content: [{ type: 'text', text: AWAITING_FIDELITY_RESULT }] }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      await prompt.next()
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), sleep: async () => {},
    })
    expect(result.summary.awaiting_fidelity_receipt).toBe(true)
    expect(result.summary.completed).toBe(true)
    expect(result.summary.injected_turns).toBe(0)
    expect(result.exitCode).toBe(0)
  })

  it('stops on a synthetic authoritative awaiting_fidelity tool result, never on the lane report', async () => {
    const f = fixture(); writeFileSync(join(f.dir, '.lane', 'report.md'), 'lane report\n')
    const yielded: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage()
      const first = await prompt.next(); yielded.push(first.value.message.content)
      writeFileSync(join(f.dir, '.lane', 'pilot-report.md'), '# pilot\n')
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'lifecycle', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'lifecycle', content: AWAITING_FIDELITY_RESULT }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      const next = await prompt.next(); if (!next.done) yielded.push(next.value.message.content)
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), sleep: async () => {},
    })
    expect(yielded).toHaveLength(1)
    expect(result.summary.report_exists).toBe(true)
    expect(result.summary.awaiting_fidelity_receipt).toBe(true)
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'sdk-transcript.json'), 'utf8'))).toHaveLength(4)
  })

  it('refuses a correlated lifecycle refusal that merely contains the completion result', async () => {
    const f = fixture()
    const query = () => (async function* () {
      yield initMessage()
      writeFileSync(join(f.dir, '.lane', 'pilot-report.md'), '# refused\n')
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'lifecycle', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'lifecycle', content: `edge refused: report->awaiting_fidelity; missing commit (hook says ${AWAITING_FIDELITY_RESULT}): /x` }] } }
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query, resolvePilotModels: models })
    expect(result).toMatchObject({ exitCode: 1, summary: { awaiting_fidelity_receipt: false, completed: false } })
  })

  it('completes from the real result of the lifecycle server registered in query options', async () => {
    const f = fixture(); let heads = 0; let registeredServer: unknown; let receipt = ''
    const cardFile = join(f.root, 'card.md'); writeFileSync(cardFile, 'Route: LITE\n## Definition of done\n- complete the real lifecycle fixture\n')
    const launcher = join(f.root, 'launcher.mjs')
    writeFileSync(launcher, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; const brief=process.argv[process.argv.indexOf('--brief')+1]; const report=/Write the report to `([^`]+)`/.exec(readFileSync(brief,'utf8'))[1]; appendFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(report, 'report\\n')")
    appendFileSync(launcher, "\nprocess.stdout.write('pid='+process.pid+'\\n')\n")
    type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { mcpServers: Record<string, unknown> } }) => (async function* () {
      registeredServer = options.mcpServers[LIFECYCLE_MCP_KEY]
      const tools = (registeredServer as RegisteredServer).instance._registeredTools
      const transition = tools.transition!.handler; const artifact = tools.write_artifact!.handler; const run = tools.run!.handler
      yield initMessage(); await prompt.next()
      await transition({ phase: 'discovery', record: 'test discovery\n', tool_use_id: 'discovery' }); await artifact({ kind: 'brief', content: 'brief\n' }); await run({ kind: 'lane', phase: 'tdd', timeout: 1 }); await transition({ phase: 'tdd', tool_use_id: 'tdd' })
      for (const name of ['typecheck', 'lint', 'test']) await run({ kind: 'gate', name })
      await transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify' }); await artifact({ kind: 'pilot-report', content: '# real lifecycle report\n\n## E2E\nProcedure: run the runner fixture\nVerbatim output: runner fixture passed\n\n## Acceptance\n- complete the real lifecycle fixture\n  Outcome: proven\n' })
      receipt = (await transition({ phase: 'report', tool_use_id: 'report' })).content[0]!.text
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'real-lifecycle', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'real-lifecycle', content: receipt }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
    const result = await runPilot({ card: '1', cardFile, dir: f.dir, knowledgeBaseProjectRoot: f.root, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), resolveExecutorProfile: () => ({ executor: 'gpt-lane', models: {} }), costSessions: [], lifecycleOptions: { laneLauncher: launcher, laneWaitMs: 100, gateRunner: ({ log }: { log: string }) => { writeFileSync(log, 'gate\n'); return 0 }, git: (_program: string, args: string[]) => args[0] === 'rev-parse' ? `${++heads === 1 ? 'base' : 'next'}\n` : '' }, sleep: async () => {} })
    expect(registeredServer).toMatchObject({ type: 'sdk', name: LIFECYCLE_MCP_KEY })
    expect(receipt).toBe(AWAITING_FIDELITY_RESULT)
    expect(result).toMatchObject({ exitCode: 0, summary: { awaiting_fidelity_receipt: true } })
    const usage = JSON.parse(readFileSync(join(f.dir, '.lane', 'usage.json'), 'utf8') as string)
    expect(usage.turns[0]).toMatchObject({ model: 'sonnet', input: 1, output: 1, ended_at: expect.stringMatching(/^\d{4}-/) })
    const timeline = JSON.parse(readFileSync(join(f.dir, '.lane', 'lifecycle.json'), 'utf8') as string)
    expect(timeline.phases.map((phase: { phase: string }) => phase.phase)).toEqual(['discovery', 'tdd', 'verify', 'report'])
    expect(timeline.lanes[0]).toMatchObject({ phase: 'tdd', started_at: expect.any(Number), ended_at: expect.any(Number) })
    const cost = JSON.parse(readFileSync(join(f.dir, '.lane', 'cost.json'), 'utf8') as string)
    expect(cost).toMatchObject({ route: 'LITE', outcome: { status: 'complete' }, unknown: [expect.stringContaining('no OpenCode session matched')] })
    expect(readFileSync(join(f.dir, '.lane', 'pilot-report.md'), 'utf8')).toContain('<!-- run-cost -->')
    expect(readFileSync(join(result.summary.archive.path, 'cost.json'), 'utf8')).toBe(readFileSync(join(f.dir, '.lane', 'cost.json'), 'utf8'))
    expect(readFileSync(join(result.summary.archive.path, 'pilot-report.md'), 'utf8')).toContain('<!-- run-cost -->')
  })

  it.each([
    ['a not-done criterion', 'Procedure: run the runner fixture\nVerbatim output: runner fixture passed', 'Outcome: not done: blocked upstream', 'complete the delivery fixture'],
    ['an unrun E2E', 'e2e not run: unavailable host', 'Outcome: proven', 'E2E: e2e not run: unavailable host'],
  ])('returns exit 2 when the report records %s', async (_name, e2e, outcome, unmet) => {
    const f = fixture(); let heads = 0
    const cardFile = join(f.root, 'delivery-card.md'); writeFileSync(cardFile, 'Route: LITE\n## Definition of done\n- complete the delivery fixture\n')
    const launcher = join(f.root, 'delivery-launcher.mjs')
    writeFileSync(launcher, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'; const log=process.argv[process.argv.indexOf('--log')+1]; const brief=process.argv[process.argv.indexOf('--brief')+1]; const report=/Write the report to `([^`]+)`/.exec(readFileSync(brief,'utf8'))[1]; appendFileSync(log,'done\\nEXIT=0\\n'); writeFileSync(report,'report\\n'); process.stdout.write('pid='+process.pid+'\\n')")
    type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { mcpServers: Record<string, unknown> } }) => (async function* () {
      const tools = (options.mcpServers[LIFECYCLE_MCP_KEY] as RegisteredServer).instance._registeredTools
      const transition = tools.transition!.handler; const artifact = tools.write_artifact!.handler; const run = tools.run!.handler
      yield initMessage(); await prompt.next()
      await transition({ phase: 'discovery', record: 'test discovery\n', tool_use_id: 'discovery' }); await artifact({ kind: 'brief', content: 'brief\n' }); await run({ kind: 'lane', phase: 'tdd', timeout: 1 }); await transition({ phase: 'tdd', tool_use_id: 'tdd' })
      for (const name of ['typecheck', 'lint', 'test']) await run({ kind: 'gate', name })
      await transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify' })
      const report = `# report\n\n## E2E\n${e2e}\n\n## Acceptance\n- complete the delivery fixture\n  ${outcome}\n`
      await artifact({ kind: 'pilot-report', content: report })
      const refused = (await transition({ phase: 'report', tool_use_id: 'classify' })).content[0]!.text
      const partialLine = /add the line "(Partial: [^"]+)"/.exec(refused)?.[1]
      if (!partialLine) throw new Error(`missing partial refusal: ${refused}`)
      await artifact({ kind: 'pilot-report', content: `${report}${partialLine}\n` })
      const receipt = (await transition({ phase: 'report', tool_use_id: 'complete' })).content[0]!.text
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'complete', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'complete', content: receipt }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
    const result = await runPilot({ card: '1', cardFile, dir: f.dir, knowledgeBaseProjectRoot: f.root, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }, {
      query, resolvePilotModels: models, lifecycleOptions: { laneLauncher: launcher, laneWaitMs: 100, gateRunner: ({ log }: { log: string }) => { writeFileSync(log, 'gate\n'); return 0 }, git: (_program: string, args: string[]) => args[0] === 'rev-parse' ? `${++heads === 1 ? 'base' : 'next'}\n` : '' }, sleep: async () => {},
    })
    expect(result).toMatchObject({ exitCode: 2, summary: { completed: true, partial: { phase: 'report', round: null, reason: 'delivered partially: 1 unmet criteria', findings: [unmet] } } })
    expect(JSON.parse(readFileSync(join(result.summary.archive.path, 'manifest.json'), 'utf8')).partial).toEqual(result.summary.partial)
  })

  it('H14-3 lock: completes a registered-server partial run with its continuation and exit code 2', async () => {
    const f = fixture(); let heads = 0
    const reason = `plan not approved after ${MAX_CRITIC_ROUNDS} critic rounds`
    writeFileSync(f.cardFile, 'Route: FULL\n## Definition of done\n- exercise partial completion\n')
    const launcher = join(f.root, 'launcher.mjs')
    writeFileSync(launcher, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'; const args=process.argv; const log=args[args.indexOf('--log')+1]; const brief=readFileSync(args[args.indexOf('--brief')+1],'utf8'); const report=/Write the report to `([^`]+)`/.exec(brief)[1]; writeFileSync(report,'VERDICT: changes-requested\\nFINDINGS:\\n- tighten the proof\\n'); appendFileSync(log,'done\\nEXIT=0\\n'); process.stdout.write('pid='+process.pid+'\\n')")
    const continuations: string[] = []
    type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const plan = '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task. DoD: green\n## Gates\n- test\n## Acceptance\n- exercise partial completion\n  Proof: test fixture\n'
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { mcpServers: Record<string, unknown> } }) => (async function* () {
      const server = options.mcpServers[LIFECYCLE_MCP_KEY] as RegisteredServer
      const transition = server.instance._registeredTools.transition!.handler
      const artifact = server.instance._registeredTools.write_artifact!.handler
      const run = server.instance._registeredTools.run!.handler
      yield initMessage(); await prompt.next()
      await transition({ phase: 'discovery', record: 'test discovery\n', tool_use_id: 'discovery' })
      for (let round = 1; round <= MAX_CRITIC_ROUNDS; round += 1) {
        await artifact({ kind: 'plan', content: plan }); await transition({ phase: 'plan', tool_use_id: `plan-${round}` })
        await artifact({ kind: 'critic-brief', content: `critic ${round}` }); await run({ kind: 'lane', phase: 'critic', timeout: 1 })
        await transition({ phase: 'critic', outcome: 'changes-requested', findings: ['tighten the proof'], tool_use_id: `critic-${round}` })
      }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      const continuation = await prompt.next(); continuations.push(continuation.value.message.content)
      await artifact({ kind: 'pilot-report', content: `# partial\nPartial: ${reason}\n\n## E2E\ne2e not run: runner fixture\n\n## Independent Review\nLenses: plan completeness\nConfirmed findings: plan remained unapproved\nRefuted findings: none\n\n## Acceptance\n- exercise partial completion\n  Outcome: not done: plan remained unapproved\n` })
      const receipt = (await transition({ phase: 'report', tool_use_id: 'report' })).content[0]!.text
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'complete', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'complete', content: receipt }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, knowledgeBaseProjectRoot: f.root, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }, {
      query, resolvePilotModels: models, lifecycleOptions: { laneLauncher: launcher, laneWaitMs: 100, git: (_program: string, args: string[]) => args[0] === 'rev-parse' ? `${++heads === 1 ? 'base' : 'next'}\n` : '' }, sleep: async () => {},
    })
    expect(continuations).toEqual([`The run is partial (${reason}): write the pilot report with the line "Partial: ${reason}", then transition report.`])
    expect(result).toMatchObject({ exitCode: 2, summary: { completed: true, partial: { phase: 'critic', round: 4, reason, findings: ['tighten the proof'] } } })
  })

  it('re-prompts after a tdd-lane end_turn and completes on the next turn', async () => {
    const f = fixture(); const continuations: string[] = []; let heads = 0
    const launcher = join(f.root, 'launcher.mjs')
    writeFileSync(launcher, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'; const log=process.argv[process.argv.indexOf('--log')+1]; const brief=process.argv[process.argv.indexOf('--brief')+1]; const report=/Write the report to `([^`]+)`/.exec(readFileSync(brief,'utf8'))[1]; appendFileSync(log,'done\\nEXIT=0\\n'); writeFileSync(report,'report\\n'); process.stdout.write('pid='+process.pid+'\\n')")
    type RegisteredServer = { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }
    const query = ({ prompt, options }: { prompt: AsyncGenerator<{ message: { content: string } }>, options: { mcpServers: Record<string, unknown> } }) => (async function* () {
      const server = options.mcpServers[LIFECYCLE_MCP_KEY] as RegisteredServer
      const transition = server.instance._registeredTools.transition!.handler
      const artifact = server.instance._registeredTools.write_artifact!.handler
      const run = server.instance._registeredTools.run!.handler
      yield initMessage(); await prompt.next()
      await transition({ phase: 'discovery', record: 'test discovery\n', tool_use_id: 'discovery' }); await artifact({ kind: 'brief', content: 'brief\n' }); await run({ kind: 'lane', phase: 'tdd', timeout: 1 })
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      const continuation = await prompt.next(); if (continuation.done) return; continuations.push(continuation.value.message.content)
      await transition({ phase: 'tdd', tool_use_id: 'tdd' }); for (const name of ['typecheck', 'lint', 'test']) await run({ kind: 'gate', name })
      await transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify' }); await artifact({ kind: 'pilot-report', content: '# report\n\n## E2E\nProcedure: run the runner fixture\nVerbatim output: runner fixture passed\n\n## Acceptance\n- exercise the runner\n  Outcome: proven\n' })
      const receipt = (await transition({ phase: 'report', tool_use_id: 'report' })).content[0]!.text
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'complete', name: lifecycleToolName('transition'), input: {} }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'complete', content: receipt }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, knowledgeBaseProjectRoot: f.root, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }, {
      query, resolvePilotModels: models, lifecycleOptions: { laneLauncher: launcher, laneWaitMs: 100, gateRunner: ({ log }: { log: string }) => { writeFileSync(log, 'gate\n'); return 0 }, git: (_program: string, args: string[]) => args[0] === 'rev-parse' ? `${++heads === 1 ? 'base' : 'next'}\n` : '' },
    })
    expect(result).toMatchObject({ exitCode: 0, summary: { completed: true, injected_turns: 1 } })
    expect(continuations).toEqual([expect.stringContaining('current phase tdd')])
  })

  it('fails after three continuation prompts without lifecycle progress', async () => {
    const f = fixture(); const continuations: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage(); await prompt.next()
      for (let turn = 0; turn < 3; turn += 1) {
        yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
        const continuation = await prompt.next(); continuations.push(continuation.value.message.content)
      }
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 10, hard: false }, { query, resolvePilotModels: models })
    expect(continuations).toHaveLength(3)
    expect(result).toMatchObject({ exitCode: 1, summary: { completed: false, injected_turns: 3, reason: 'pilot ended its turn 3 times without progress' } })
    expect(result.summary.partial).toMatchObject({ reason: 'pilot ended its turn 3 times without progress' })
    expect(readFileSync(join(result.summary.archive.path, 'summary.json'), 'utf8')).toContain('pilot ended its turn 3 times without progress')
  }, 2_000)

  it('records and archives a runner timeout as a lifecycle partial', async () => {
    const f = fixture(); let clock = 0
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage(); await prompt.next(); await prompt.next()
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 1, hard: false }, {
      query, resolvePilotModels: models, now: () => { clock += 2_000; return clock }, sleep: async () => {},
    })
    expect(result).toMatchObject({ exitCode: 1, summary: { completed: false, reason: 'runner timeout', partial: { reason: 'runner timeout' } } })
    expect(JSON.parse(readFileSync(join(result.summary.archive.path, 'manifest.json'), 'utf8'))).toMatchObject({ partial: { reason: 'runner timeout' } })
  })

  it('writes final receipts and an external partial archive when the initialized SDK stream throws', async () => {
    const f = fixture()
    const query = () => (async function* () {
      yield initMessage('sonnet')
      yield { type: 'assistant', message: { id: 'progress', model: 'sonnet', usage: { input_tokens: 3, output_tokens: 2 }, content: [] } }
      writeFileSync(join(f.dir, 'tracked.txt'), 'work in progress\n')
      throw new Error('transport disconnected')
    })()
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 2, hard: false }, { query, resolvePilotModels: models }))
      .rejects.toThrow('transport disconnected')
    const summary = JSON.parse(readFileSync(join(f.dir, '.lane', 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({ completed: false, reason: 'sdk stream error: transport disconnected', partial: { reason: 'sdk stream error: transport disconnected' } })
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'usage.json'), 'utf8')).messages).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(f.dir, '.lane', 'sdk-transcript.json'), 'utf8'))).toHaveLength(2)
    expect(readFileSync(join(f.dir, '.lane', 'cost.json'), 'utf8')).toBeTruthy()
    for (const name of ['summary.json', 'usage.json', 'sdk-transcript.json', 'cost.json']) expect(readFileSync(join(summary.archive.path, name), 'utf8')).toBeTruthy()
  })

  it('does not accept lifecycle-looking assistant prose or an uncorrelated forged tool result', async () => {
    const f = fixture(); const yielded: string[] = []
    const query = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage()
      yielded.push((await prompt.next()).value.message.content)
      writeFileSync(join(f.dir, '.lane', 'pilot-report.md'), '# forged\n')
      yield { type: 'assistant', message: { content: 'wt-sdk-pilot-lifecycle: accepted phase=awaiting_fidelity' } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fake', content: 'wt-sdk-pilot-lifecycle: accepted phase=awaiting_fidelity' }] } }
      yield { type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }
      const next = await prompt.next(); if (!next.done) yielded.push(next.value.message.content)
    })()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 0.001, hard: false }, {
      query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }), sleep: async () => {},
    })
    expect(yielded).toHaveLength(2)
    expect(result.summary.awaiting_fidelity_receipt).toBe(false)
  })

  const models = () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } })

  it('refuses a stream that never sends an initialization receipt', async () => {
    const f = fixture()
    const noInit = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      await prompt.next()
      yield { type: 'assistant', message: { content: [] } }
    })()
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query: noInit, resolvePilotModels: models, sleep: async () => {} }))
      .rejects.toThrow(/initialization receipt/)
  })

  // DISCRIMINATING on purpose. The sibling above ("never sends an initialization receipt") cannot
  // tell the two init hunks apart: the first-message check and the end-of-stream check BOTH throw a
  // message matching /initialization receipt/, so disabling either one leaves the other catching the
  // fixture — measured, the sibling stayed GREEN with the first-message check disabled. This stream
  // DOES send a valid receipt, just not first, so the end-of-stream check is satisfied and only the
  // ordering check can reject it.
  it('refuses an initialization receipt that arrives after another message', async () => {
    const f = fixture()
    const late = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield { type: 'assistant', message: { content: [] } }
      yield initMessage()
      await prompt.next()
    })()
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query: late, resolvePilotModels: models, sleep: async () => {} }))
      .rejects.toThrow(/receipt never arrived/)
  })

  it('refuses an initialization receipt that omits the artifact tool or the guard plugin', async () => {
    const f = fixture()
    // discriminating on purpose: the transition tool and the lifecycle plugin ARE present, so only a
    // runner that also requires write_artifact and pilot-guard rejects this receipt
    const thin = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield { ...initMessage(), tools: ['mcp__sdk-pilot-lifecycle__transition'], plugins: [] }
      await prompt.next()
    })()
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query: thin, resolvePilotModels: models, sleep: async () => {} }))
      .rejects.toThrow(/missing plugins or lifecycle tools/)
  })

  it('refuses an initialization receipt that omits the lifecycle run tool', async () => {
    const f = fixture()
    const thin = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield { ...initMessage(), tools: ['mcp__sdk-pilot-lifecycle__transition', 'mcp__sdk-pilot-lifecycle__write_artifact'] }
      await prompt.next()
    })()
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, { query: thin, resolvePilotModels: models, sleep: async () => {} }))
      .rejects.toThrow(/missing plugins or lifecycle tools/)
  })

  it('refuses startup when the retired lifecycle hook directory exists', async () => {
    const f = fixture()
    const oldHook = join(f.root, 'sdk-pilot-lifecycle'); mkdirSync(oldHook)
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 2, hard: false }, {
      query: () => (async function* () { yield initMessage() })(), resolvePilotModels: models, oldLifecycleHook: oldHook,
    })).rejects.toThrow(/old lifecycle hook is still present/)
  })

  it('refuses to start on a lane that already holds a pilot report', async () => {
    const stale = fixture()
    writeFileSync(join(stale.dir, '.lane', 'pilot-report.md'), '# stale\n')
    const ok = ({ prompt }: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      yield initMessage()
      await prompt.next()
    })()
    await expect(runPilot({ card: '1', cardFile: stale.cardFile, dir: stale.dir, contract: stale.contract, mailbox: join(stale.root, 'none.txt'), timeout: 2, hard: false }, { query: ok, resolvePilotModels: models, sleep: async () => {} }))
      .rejects.toThrow(/already exists/)
  })

  it('documents lifecycle-only lane delegation in the adopted contract', () => {
    const contract = readFileSync(join(ROOT, 'plugin/autonomy/PILOT-CONTRACT.md'), 'utf8')
    const runner = readFileSync(join(ROOT, 'plugin/autonomy/PILOT-RUNNER.md'), 'utf8')
    expect(contract).toContain("run { kind: 'lane', phase, timeout }")
    expect(contract).toContain('You have no Bash, Write, or Edit.')
    for (const tool of ['get_card', 'get_comments', 'add_comment', 'update_card', 'move_card', 'add_label_to_card']) {
      expect(contract).toContain(`mcp__planka__${tool}`)
      expect(runner).toContain(`mcp__planka__${tool}`)
    }
    expect(`${contract}\n${runner}`).not.toContain('Atrium')
    expect(`${contract}\n${runner}`).not.toContain('--room')
  })

  it('keeps the adopted contract under 6 KB', () => {
    expect(readFileSync(join(ROOT, 'plugin/autonomy/PILOT-CONTRACT.md')).byteLength).toBeLessThanOrEqual(6 * 1024)
    expect(readFileSync(join(ROOT, 'plugin/skills/adopt/scripts/install.mjs'), 'utf8')).toContain("{ file: 'PILOT-CONTRACT.md' }")
  })

  it('registers the runner-hosted lifecycle server and composes the pilot role profile', async () => {
    type QueryOptions = { plugins: Array<{ path: string }>, tools: string[], mcpServers: Record<string, unknown>, permissionMode?: string, allowDangerouslySkipPermissions?: boolean }
    const f = fixture(); let options: QueryOptions | undefined
    const query = ({ options: received }: { options: QueryOptions }) => { options = received; return (async function* () {
      yield initMessage()})() }
    await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 1, hard: false }, { query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }) })
    expect(options!.plugins.map((plugin) => plugin.path)).toEqual([expect.stringContaining('pilot-guard'), resolveContextModeRoot(process.env), expect.stringContaining(join('.lane', 'sdk-plugins', 'pilot'))])
    expect(options!.tools).toEqual(['Read', 'Glob', 'Grep', ...Object.values(CONTEXT_MODE_TOOLS)])
    expect(options!.mcpServers[LIFECYCLE_MCP_KEY]).toMatchObject({ type: 'sdk', name: LIFECYCLE_MCP_KEY })
    expect(options!.permissionMode).toBe('default')
    expect(options!).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('loads every configured plugin and refuses an init receipt that omits one', async () => {
    const complete = fixture(); const first = join(complete.root, 'rules-plugin'); const second = join(complete.root, 'lsp-plugin')
    mkdirSync(first); mkdirSync(second)
    let queryPlugins: string[] = []
    const query = ({ options }: { options: { plugins: Array<{ path: string }> } }) => (async function* () {
      queryPlugins = options.plugins.map((plugin) => plugin.path)
      yield { ...initMessage(), plugins: options.plugins }
    })()
    await runPilot({ card: '1', cardFile: complete.cardFile, dir: complete.dir, contract: complete.contract, mailbox: join(complete.root, 'none'), timeout: 1, hard: false, pluginDirs: [first, second] }, { query, resolvePilotModels: models })
    expect(queryPlugins).toEqual([expect.stringContaining('pilot-guard'), resolveContextModeRoot(process.env), expect.stringContaining(join('.lane', 'sdk-plugins', 'pilot')), first, second])

    const missing = fixture(); const omitted = join(missing.root, 'omitted-plugin'); mkdirSync(omitted)
    await expect(runPilot({ card: '1', cardFile: missing.cardFile, dir: missing.dir, contract: missing.contract, mailbox: join(missing.root, 'none'), timeout: 1, hard: false, pluginDirs: [omitted] }, {
      query: () => (async function* () { yield initMessage() })(), resolvePilotModels: models,
    })).rejects.toThrow(new RegExp(`absentPlugins.*${omitted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('matches configured plugins to receipt paths through symlinks and trailing separators', async () => {
    const f = fixture(); const target = join(f.root, 'plugin-target'); const linked = join(f.root, 'plugin-link')
    mkdirSync(target); symlinkSync(target, linked)
    const query = ({ options }: { options: { plugins: Array<{ path: string }> } }) => (async function* () {
      yield { ...initMessage(), plugins: [...options.plugins.slice(0, 3), { path: `${realpathSync(target)}/` }] }
    })()
    await expect(runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 1, hard: false, pluginDirs: [linked] }, { query, resolvePilotModels: models })).resolves.toBeDefined()
  })

  it('runs the SDK pilot on the SDK pilot keys, never the harness pilot keys (harness hard = fable, SDK hard = opus)', async () => {
    const f = fixture(); const seen: string[] = []
    const query = ({ options: received }: { options: { model: string } }) => { seen.push(received.model); return (async function* () { yield initMessage() })() }
    const models = () => ({ pilot: { value: 'opus', effective: 'opus' }, pilotHard: { value: 'fable', effective: 'fable' }, sdkPilot: { value: 'opus', effective: 'opus' }, sdkPilotHard: { value: 'opus', effective: 'opus' } })
    await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 1, hard: true }, { query, resolvePilotModels: models })
    expect(seen).toEqual(['opus'])
  })

  it('points the Planka MCP at the planka_mcp_url setting, not a hard-coded port', async () => {
    const f = fixture(); let options: { mcpServers: Record<string, { url?: string }> } | undefined
    const configDir = join(f.root, 'config'); mkdirSync(join(configDir, 'plugins', 'cache', 'context-mode', 'context-mode'), { recursive: true })
    symlinkSync(resolveContextModeRoot(process.env), join(configDir, 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.177'))
    const query = ({ options: received }: { options: { mcpServers: Record<string, { url?: string }>, plugins: Array<{ path: string }> } }) => { options = received; return (async function* () { yield { ...initMessage(), plugins: received.plugins } })() }
    const env = { CLAUDE_CONFIG_DIR: configDir, WT_PLANKA_MCP_URL: 'http://board.example:9999/mcp' }
    await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none.txt'), timeout: 1, hard: false }, { env, query, resolvePilotModels: () => ({ pilot: { value: 'sonnet', effective: 'sonnet' }, pilotHard: { value: 'opus', effective: 'opus' } }) })
    expect(options!.mcpServers.planka?.url).toBe('http://board.example:9999/mcp')
  })

  it('fails closed after an initialized stream ends without lifecycle completion', async () => {
    const f = fixture()
    const result = await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 1, hard: false }, { query: () => (async function* () { yield initMessage() })(), resolvePilotModels: models })
    expect(result).toMatchObject({ exitCode: 1, summary: { completed: false, reason: expect.stringContaining('without awaiting_fidelity') } })
  })

  it('confines real Read, Glob, and Grep authorization inputs', () => {
    const f = fixture(); const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret'), 'x')
    symlinkSync(outside, join(f.dir, 'outside-link'))
    for (const tool of ['Read', 'Glob', 'Grep']) {
      expect(lifecycleCanUseTool(f.dir, tool, { path: outside }).behavior).toBe('deny')
      expect(lifecycleCanUseTool(f.dir, tool, { path: '../outside' }).behavior).toBe('deny')
      expect(lifecycleCanUseTool(f.dir, tool, { path: 'missing/child' }).behavior).toBe('allow')
    }
    expect(lifecycleCanUseTool(f.dir, 'Glob', { pattern: join(outside, '*') }).behavior).toBe('deny')
    expect(lifecycleCanUseTool(f.dir, 'Glob', { pattern: '../outside/*' }).behavior).toBe('deny')
    expect(lifecycleCanUseTool(f.dir, 'Glob', { pattern: 'outside-link/*' }).behavior).toBe('deny')
    expect(lifecycleCanUseTool(f.dir, 'Glob', { pattern: 'src/**/*.ts' }).behavior).toBe('allow')
    expect(lifecycleCanUseTool(f.dir, 'Grep', { path: '.', glob: 'outside-link/*.ts' }).behavior).toBe('deny')
    expect(lifecycleCanUseTool(f.dir, 'Read', null).behavior).toBe('deny')
  })

  it('admits only the exact Planka contract through the real authorization seam', () => {
    const f = fixture()
    expect(lifecycleCanUseTool(f.dir, 'mcp__planka__get_card', {}).behavior).toBe('allow')
    expect(lifecycleCanUseTool(f.dir, 'mcp__planka__delete_card', {}).behavior).toBe('deny')
    expect(lifecycleCanUseTool(f.dir, 'mcp__plugin_atrium_atrium__speak', {}).behavior).toBe('deny')
  })

  it('writes the routing receipt first and denies pilot board moves only when orchestrated', async () => {
    const f = fixture(); const logged: string[] = []; let permission: { behavior: string, message?: string } | undefined
    const query = ({ options }: { options: { canUseTool: (name: string, input: unknown) => Promise<{ behavior: string, message?: string }> } }) => (async function* () {
      permission = await options.canUseTool('mcp__planka__move_card', {})
      yield initMessage()
    })()
    await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 1, hard: false, boardMoves: false }, { query, resolvePilotModels: models, resolveExecutorProfile: () => ({ executor: 'gpt-lane', models: {} }), log: (line: string) => logged.push(line) })
    expect(logged[0]).toBe('route=LITE reasons=human Route: LITE model=sonnet effective=sonnet executor=gpt-lane')
    expect(permission).toEqual({ behavior: 'deny', message: "board moves are the orchestrator's" })
    expect(lifecycleCanUseTool(f.dir, 'mcp__planka__move_card', {}, { boardMoves: true }).behavior).toBe('allow')
  })

  it.skipIf(process.env.WT_REAL_SDK_LOCKS !== '1')('refuses forbidden tools through a real SDK query without shadowing canUseTool', async () => {
    const f = fixture()
    writeFileSync(f.cardFile, [
      'Route: LITE',
      'This is an SDK permission transport test. In your first response, issue exactly these two tool calls in parallel and no prose:',
      '1. Read the absolute file /etc/hostname.',
      '2. Call mcp__planka__delete_card with no arguments.',
    ].join('\n'))
    writeFileSync(f.contract, 'Follow the card tool-call instructions exactly. Do not call lifecycle tools.\n')
    let deleteExecuted = false
    const planka = createSdkMcpServer({
      name: 'planka',
      version: '1.0.0',
      tools: [tool('delete_card', 'Delete a card for the permission lock.', {}, async () => {
        deleteExecuted = true
        return { content: [{ type: 'text', text: 'delete executed' }] }
      })],
    })
    const warnings: string[] = []
    const stderr: string[] = []
    const onWarning = (warning: Error & { code?: string }) => warnings.push(`${warning.code ?? ''}: ${warning.message}`)
    process.on('warning', onWarning)
    try {
      await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 30, hard: false }, {
        query: ({ prompt, options }: Parameters<typeof sdkQuery>[0]) => (async function* () {
          try {
            yield* sdkQuery({
              prompt,
              options: { ...options, maxTurns: 1, mcpServers: { ...options?.mcpServers, planka }, stderr: (line) => stderr.push(line) },
            })
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('Reached maximum number of turns (1)')) throw error
          }
        })(),
        resolvePilotModels: () => ({ pilot: { value: 'haiku', effective: 'haiku' }, pilotHard: { value: 'haiku', effective: 'haiku' } }),
      })
    } finally {
      process.off('warning', onWarning)
    }
    await new Promise((resolve) => setImmediate(resolve))
    const transcript = readFileSync(join(f.dir, '.lane', 'sdk-transcript.json'), 'utf8')
    const readRefused = transcript.includes('path outside worktree: /etc/hostname')
    const deleteRefused = transcript.includes('tool refused: mcp__planka__delete_card')
    const shadowed = [...warnings, ...stderr].some((line) => line.includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'))
    process.stdout.write(`REAL_SDK_READ_REFUSED=${readRefused}\nREAL_SDK_DELETE_REFUSED=${deleteRefused}\nREAL_SDK_DELETE_EXECUTED=${deleteExecuted}\nREAL_SDK_SHADOWED_WARNING=${shadowed}\n`)
    expect(readRefused).toBe(true)
    expect(deleteRefused).toBe(true)
    expect(deleteExecuted).toBe(false)
    expect(shadowed).toBe(false)
  }, 120_000)

  it.skipIf(process.env.WT_REAL_SDK_LOCKS !== '1')('measures wildcard-first Glob and Grep matches through an in-worktree symlink with a real SDK query', async () => {
    const f = fixture(); const outside = join(f.root, 'outside'); const marker = 'WILDCARD_FIRST_ESCAPE_MARKER'
    mkdirSync(outside); writeFileSync(join(outside, 'x'), 'outside x\n'); writeFileSync(join(outside, 'marker'), marker)
    mkdirSync(join(f.dir, 'inside')); writeFileSync(join(f.dir, 'inside', 'x'), 'inside x\n'); symlinkSync(outside, join(f.dir, 'link'))
    writeFileSync(f.cardFile, [
      'Route: LITE',
      'This is an SDK wildcard-first Glob/Grep measurement. In your first response, issue exactly these two tool calls in parallel and no prose:',
      '1. Glob with pattern `*/x` and no path argument.',
      `2. Grep with pattern \`${marker}\`, glob \`*/*\`, and output mode \`files_with_matches\`.`,
    ].join('\n'))
    writeFileSync(f.contract, 'Follow the card tool-call instructions exactly. Do not call lifecycle tools.\n')
    const warnings: string[] = []; const stderr: string[] = []
    const onWarning = (warning: Error & { code?: string }) => warnings.push(`${warning.code ?? ''}: ${warning.message}`)
    process.on('warning', onWarning)
    try {
      await runPilot({ card: '1', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 30, hard: false }, {
        query: ({ prompt, options }: Parameters<typeof sdkQuery>[0]) => (async function* () {
          try {
            yield* sdkQuery({ prompt, options: { ...options, maxTurns: 1, stderr: (line) => stderr.push(line) } })
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('Reached maximum number of turns (1)')) throw error
          }
        })(),
        resolvePilotModels: () => ({ pilot: { value: 'haiku', effective: 'haiku' }, pilotHard: { value: 'haiku', effective: 'haiku' } }),
      })
    } finally {
      process.off('warning', onWarning)
    }
    await new Promise((resolve) => setImmediate(resolve))
    const transcript = JSON.parse(readFileSync(join(f.dir, '.lane', 'sdk-transcript.json'), 'utf8'))
    const resultText = transcript.flatMap((message: { message?: { content?: Array<{ type?: string, content?: unknown }> } }) =>
      message.message?.content?.filter((item) => item.type === 'tool_result').map((item) => JSON.stringify(item.content)) ?? []).join('\n')
    const outsideRealpath = realpathSync(outside)
    const reachesOutside = (name: string) => {
      const outsideFile = join(outside, name)
      const linkFile = join(f.dir, 'link', name)
      return realpathSync(outsideFile) === join(outsideRealpath, name) &&
        (resultText.includes(outsideFile) || resultText.includes(linkFile) || resultText.includes(join(outsideRealpath, name)) || resultText.includes(`link/${name}`))
    }
    const globEscaped = reachesOutside('x')
    const grepEscaped = reachesOutside('marker') && resultText.includes(marker)
    const seamRefused = transcript.some((message: unknown) => JSON.stringify(message).includes('path outside worktree: */x'))
    const shadowed = [...warnings, ...stderr].some((line) => line.includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'))
    process.stdout.write(`REAL_SDK_WILDCARD_FIRST_GLOB_ESCAPED=${globEscaped}\nREAL_SDK_WILDCARD_FIRST_GREP_ESCAPED=${grepEscaped}\n`)
    expect(seamRefused).toBe(false)
    expect(resultText).toContain('inside/x')
    expect(globEscaped).toBe(false)
    expect(grepEscaped).toBe(false)
    expect(shadowed).toBe(false)
  }, 120_000)

  it.each([['LITE', 'Route: LITE\nDoD: small\n'], ['FULL', 'Route: FULL\nDoD: risky\n']])('registers a lifecycle server routed %s from the required card', async (route, card) => {
    const f = fixture(); writeFileSync(f.cardFile, card); let registered: { lifecycle: { route: string } } | undefined
    const query = ({ options }: { options: { mcpServers: Record<string, unknown> } }) => { registered = options.mcpServers[LIFECYCLE_MCP_KEY] as typeof registered; return (async function* () { yield initMessage() })() }
    await runPilot({ card: '186', cardFile: f.cardFile, dir: f.dir, contract: f.contract, mailbox: join(f.root, 'none'), timeout: 1, hard: false }, { query, resolvePilotModels: models })
    expect(registered!.lifecycle.route).toBe(route)
  })
})
