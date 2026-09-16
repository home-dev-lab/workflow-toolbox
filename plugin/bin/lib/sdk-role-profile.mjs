import { spawn } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { absentPluginPaths } from './plugin-receipt.mjs'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN_ROOT = path.resolve(MODULE_DIR, '../..')
const CONTEXT_MODE_VERSION = '1.0.177'
const CONTEXT_PREFIX = 'mcp__plugin_context-mode_context-mode__'

// Initial support covers TypeScript and JavaScript worktrees. Add another table entry to extend
// detection, binary resolution, and the generated Claude Code LSP plugin together.
const LSP_SERVERS = Object.freeze([{
  name: 'typescript',
  binary: 'typescript-language-server',
  override: 'WT_LSP_TYPESCRIPT_SERVER',
  args: Object.freeze(['--stdio']),
  languages: Object.freeze([
    { name: 'typescript', extensions: Object.freeze(['.ts']), markers: Object.freeze(['tsconfig.json']) },
    { name: 'javascript', extensions: Object.freeze(['.mjs']), markers: Object.freeze(['package.json']) },
  ]),
}])

const CONTEXT_MODE_TOOLS = Object.freeze({
  batchExecute: `${CONTEXT_PREFIX}ctx_batch_execute`,
  doctor: `${CONTEXT_PREFIX}ctx_doctor`,
  execute: `${CONTEXT_PREFIX}ctx_execute`,
  executeFile: `${CONTEXT_PREFIX}ctx_execute_file`,
  fetchAndIndex: `${CONTEXT_PREFIX}ctx_fetch_and_index`,
  index: `${CONTEXT_PREFIX}ctx_index`,
  insight: `${CONTEXT_PREFIX}ctx_insight`,
  purge: `${CONTEXT_PREFIX}ctx_purge`,
  search: `${CONTEXT_PREFIX}ctx_search`,
  stats: `${CONTEXT_PREFIX}ctx_stats`,
})

const WRITER_GUARDS = Object.freeze([
  { script: 'wt-unquoted-tool-glob-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'refuse shell-expanded tool-option globs' },
  { script: 'wt-merge-chain-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'warn before a stale tree is certified after merge' },
  { script: 'wt-concurrent-test-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'prevent load-induced concurrent suite failures' },
  { script: 'wt-piped-gate-exit-code-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'preserve the gate process exit code' },
  { script: 'wt-pgrep-env-dump-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'prevent environment disclosure through process inspection' },
  { script: 'wt-git-commit-backtick-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'prevent shell substitution in commit messages' },
  { script: 'wt-var-colon-modifier-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'catch zsh variable modifier ambiguity' },
  { script: 'wt-find-newermt-format-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'catch malformed find date operands' },
  { script: 'wt-pipestatus-bash-only-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'keep PIPESTATUS checks in bash' },
  { script: 'wt-missing-package-script-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'refuse package scripts absent from the manifest' },
  { script: 'wt-main-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'protect integration-only operations on main' },
  { script: 'wt-gate-evidence-guard-hook.mjs', event: 'PreToolUse', matcher: 'Bash', reason: 'require auditable gate evidence' },
  { script: 'wt-stale-date-guard-hook.mjs', event: 'PostToolUse', matcher: 'Write|Edit', reason: 'surface stale dates introduced by writes' },
  { script: 'wt-rule-convention-guard-hook.mjs', event: 'PreToolUse', matcher: 'Edit|Write', reason: 'preserve shipped rule conventions' },
  { script: 'wt-shipped-twin-check-hook.mjs', event: 'PostToolUse', matcher: 'Write|Edit', reason: 'detect drift between canonical and shipped twins' },
])

const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'LSP', CONTEXT_MODE_TOOLS.search])
const WRITE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'LSP', 'Edit', 'Write', 'Bash', ...Object.values(CONTEXT_MODE_TOOLS)])
const writer = (skills) => Object.freeze({ tools: WRITE_TOOLS, guards: WRITER_GUARDS, skills: Object.freeze(skills), mcpServers: Object.freeze(['context-mode']), readOnly: false })
const reader = Object.freeze({ tools: READ_TOOLS, guards: Object.freeze([]), skills: Object.freeze([]), mcpServers: Object.freeze(['context-mode']), readOnly: true })
// The pilot arbitrates and delegates every increment through the lifecycle `run` tool: it reads, analyses
// (all context-mode tools, bounded reads) and invokes its skills, but never edits, writes or runs a shell.
const ANALYST_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'LSP', ...Object.values(CONTEXT_MODE_TOOLS)])
const analyst = (skills) => Object.freeze({ tools: ANALYST_TOOLS, guards: Object.freeze([]), skills: Object.freeze(skills), mcpServers: Object.freeze(['context-mode']), readOnly: false })
const PROFILES = Object.freeze({
  pilot: analyst(['stale-card-sweep', 'lesson-harvest', 'deep-grounding']),
  judge: reader,
  tdd: writer(['changelog']),
  harden: writer(['changelog']),
  critic: reader,
  review: reader,
  refutation: reader,
})

function roleProfile(role) {
  const profile = PROFILES[role]
  if (!profile) throw new Error(`unknown SDK role: ${role}`)
  return {
    tools: [...profile.tools],
    guards: profile.guards.map((guard) => ({ ...guard })),
    skills: [...profile.skills],
    mcpServers: [...profile.mcpServers],
    readOnly: profile.readOnly,
  }
}

function resolveContextModeRoot(env = process.env) {
  if (env.WT_CONTEXT_MODE_ROOT) return env.WT_CONTEXT_MODE_ROOT
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), '.claude')
  return path.join(configDir, 'plugins', 'cache', 'context-mode', 'context-mode', CONTEXT_MODE_VERSION)
}

function isExecutable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch { return false }
}

function resolveCommand(server, env, platform) {
  const override = env[server.override]
  if (override) return path.isAbsolute(override) && isExecutable(override, platform) ? override : null
  const separator = platform === 'win32' ? ';' : path.delimiter
  const suffixes = platform === 'win32' ? ['', '.cmd', '.exe'] : ['']
  for (const directory of String(env.PATH ?? '').split(separator).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, `${server.binary}${suffix}`)
      if (isExecutable(candidate, platform)) return candidate
    }
  }
  return null
}

function detectedLanguages(worktree, server) {
  const detected = new Set()
  for (const language of server.languages) {
    if (language.markers.some((marker) => existsSync(path.join(worktree, marker)))) detected.add(language.name)
  }
  const wantedExtensions = new Map(server.languages.flatMap((language) => language.extensions.map((extension) => [extension, language.name])))
  const pending = [worktree]
  while (pending.length > 0 && detected.size < server.languages.length) {
    const directory = pending.pop()
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isDirectory() && !['.git', '.lane', 'node_modules'].includes(entry.name)) pending.push(path.join(directory, entry.name))
      else if (entry.isFile()) {
        const language = wantedExtensions.get(path.extname(entry.name))
        if (language) detected.add(language)
      }
    }
  }
  return server.languages.filter((language) => detected.has(language.name))
}

function prepareLsp(worktree, env, platform) {
  const server = LSP_SERVERS[0]
  const command = resolveCommand(server, env, platform)
  if (!command) return { state: { available: false, reason: `${server.binary} not found on PATH` }, config: null }
  const languages = detectedLanguages(worktree, server)
  if (languages.length === 0) return { state: { available: false, reason: 'no supported TypeScript or JavaScript files detected' }, config: null }
  const extensionToLanguage = Object.fromEntries(languages.flatMap((language) => language.extensions.map((extension) => [extension, language.name])))
  return {
    state: { available: true, command, languages: languages.map((language) => language.name) },
    config: { [server.name]: { command, args: [...server.args], extensionToLanguage } },
  }
}

function defaultRunScript(script, input, { signal, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (value) => { stdout += value })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (value) => { stderr += value })
    child.on('error', (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify(input))
  })
}

function createGuardHook(script, { runScript = defaultRunScript, log = (line) => process.stderr.write(`${line}\n`), env = process.env } = {}) {
  return async (input, _toolUseId, options = {}) => {
    let result
    try { result = await runScript(script, input, { ...options, env }) } catch (error) {
      const line = `SDK guard ${script} failed to launch: ${error instanceof Error ? error.message : String(error)}`
      log(line)
      return { systemMessage: line }
    }
    const detail = result.stderr.trim()
    if (result.code !== 0) {
      const line = `SDK guard ${script} exited ${String(result.code)}` + (detail ? `: ${detail}` : '')
      log(line)
      return { systemMessage: line }
    }
    if (!result.stdout.trim()) return {}
    try { return JSON.parse(result.stdout) } catch (error) {
      const line = `SDK guard ${script} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      log(line)
      return { systemMessage: line }
    }
  }
}

function guardHooks(profile, guardPaths, adapterOptions) {
  const hooks = {}
  profile.guards.forEach((guard, index) => {
    const matchers = hooks[guard.event] ?? []
    matchers.push({ matcher: guard.matcher, hooks: [createGuardHook(guardPaths[index], adapterOptions)] })
    hooks[guard.event] = matchers
  })
  return hooks
}

export function prepareSdkRole(role, { worktree, env = process.env, pluginRoot = DEFAULT_PLUGIN_ROOT, exists = existsSync, adapterOptions, platform = process.platform } = {}) {
  const profile = roleProfile(role)
  const pilotGuard = path.join(pluginRoot, 'hooks-modules', 'pilot-guard')
  const required = [path.join(pilotGuard, 'hooks', 'hooks.json'), path.join(pilotGuard, 'hooks', 'hooks.js')]
  for (const file of required) if (!exists(file)) throw new Error(`SDK role ${role} refuses to start: required pilot guard path is absent: ${file}`)

  const contextMode = resolveContextModeRoot(env)
  for (const file of [path.join(contextMode, '.claude-plugin', 'plugin.json'), path.join(contextMode, 'hooks', 'hooks.json')]) {
    if (!exists(file)) throw new Error(`SDK role ${role} refuses to start: required context-mode path is absent: ${file}`)
  }

  const guardPaths = profile.guards.map((guard) => path.join(pluginRoot, 'bin', guard.script))
  guardPaths.forEach((file) => { if (!exists(file)) throw new Error(`SDK role ${role} refuses to start: selected guard path is absent: ${file}`) })

  const lspPrepared = prepareLsp(worktree, env, platform)
  let skillPlugin = null
  if (profile.skills.length > 0 || lspPrepared.config) {
    skillPlugin = path.join(worktree, '.lane', 'sdk-plugins', role)
    const skillsDir = path.join(skillPlugin, 'skills')
    rmSync(skillPlugin, { recursive: true, force: true })
    mkdirSync(path.join(skillPlugin, '.claude-plugin'), { recursive: true })
    mkdirSync(skillsDir, { recursive: true })
    for (const skill of profile.skills) {
      const source = path.join(pluginRoot, 'skills', skill)
      if (!exists(path.join(source, 'SKILL.md'))) throw new Error(`SDK role ${role} refuses to start: selected skill path is absent: ${source}`)
      cpSync(source, path.join(skillsDir, skill), { recursive: true })
    }
    const manifest = { name: `wt-sdk-${role}`, version: '0.0.0', ...(profile.skills.length > 0 ? { skills: './skills/' } : {}) }
    writeFileSync(path.join(skillPlugin, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (lspPrepared.config) writeFileSync(path.join(skillPlugin, '.lsp.json'), JSON.stringify(lspPrepared.config, null, 2) + '\n')
  }

  const pluginPaths = [pilotGuard, contextMode, ...(skillPlugin ? [skillPlugin] : [])]
  const log = adapterOptions?.log ?? ((line) => process.stderr.write(`${line}\n`))
  log(lspPrepared.state.available
    ? `SDK role ${role}: LSP available (${lspPrepared.state.command})`
    : `SDK role ${role}: LSP absent: ${lspPrepared.state.reason}`)
  return { profile, pluginPaths, guardPaths, skillPlugin, lsp: lspPrepared.state, hooks: guardHooks(profile, guardPaths, { env, ...adapterOptions }) }
}

export function composeSdkRoleQueryOptions(base, prepared) {
  const disallowedTools = prepared.profile.readOnly
    ? Object.values(CONTEXT_MODE_TOOLS).filter((tool) => tool !== CONTEXT_MODE_TOOLS.search)
    : []
  return {
    ...base,
    plugins: prepared.plugins ?? prepared.pluginPaths.map((pluginPath) => ({ type: 'local', path: pluginPath })),
    pluginDelivery: 'initialize',
    tools: [...prepared.profile.tools],
    ...(disallowedTools.length ? { disallowedTools } : {}),
    hooks: prepared.hooks,
  }
}

export function assertSdkRoleReceipt(role, message, prepared) {
  const tools = Array.isArray(message.tools) ? message.tools : []
  const plugins = Array.isArray(message.plugins) ? message.plugins : []
  const skills = Array.isArray(message.skills) ? message.skills : []
  const pathCheckedPlugins = prepared.pluginPaths.filter((pluginPath) => pluginPath !== prepared.skillPlugin)
  const absentPlugins = absentPluginPaths(pathCheckedPlugins, plugins)
  if (prepared.skillPlugin && !plugins.some((plugin) => plugin?.name === `wt-sdk-${role}` || plugin?.path === prepared.skillPlugin)) absentPlugins.push(prepared.skillPlugin)
  const requiredTools = prepared.lsp?.available ? prepared.profile.tools : prepared.profile.tools.filter((tool) => tool !== 'LSP')
  const missingTools = requiredTools.filter((tool) => !tools.includes(tool))
  const forbiddenTools = prepared.profile.readOnly
    ? Object.values(CONTEXT_MODE_TOOLS).filter((tool) => tool !== CONTEXT_MODE_TOOLS.search && tools.includes(tool))
    : []
  const missingSkills = prepared.profile.skills.filter((skill) => !skills.some((loaded) => loaded === skill || loaded.endsWith(`:${skill}`)))
  if (absentPlugins.length || missingTools.length || forbiddenTools.length || missingSkills.length) {
    throw new Error(`SDK role ${role} initialization receipt is incomplete: ${JSON.stringify({ absentPlugins, missingTools, forbiddenTools, missingSkills, tools, plugins, skills })}`)
  }
}
