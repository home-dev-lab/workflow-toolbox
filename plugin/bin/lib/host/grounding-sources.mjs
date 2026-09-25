import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginName, resolvePluginDataDir } from '../plugin-data-dir.mjs'
import { resolveWorkflowToolboxOption } from '../plugin-options.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))))
const PROJECT_REGISTRY = path.join('.claude', 'grounding-sources.json')
const TRANSCRIPT_BYTE_CAP = 2 * 1024 * 1024
const MAX_STATE_FILES = 100
const MAX_FAMILY_LENGTH = 80

function jsonFile(file) {
  if (!file) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function parsedJsonFile(file) {
  if (!file || !existsSync(file)) return { value: null, warning: null }
  try { return { value: JSON.parse(readFileSync(file, 'utf8')), warning: null } } catch { return { value: null, warning: 'is unreadable or malformed' } }
}

export function groundingConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
}

function userRegistryPath(env) {
  const configured = env.CLAUDE_PLUGIN_OPTION_GROUNDING_SOURCES
    || resolveWorkflowToolboxOption('grounding_sources', { env }).value
  return configured || path.join(groundingConfigDir(env), 'grounding-sources.json')
}

function validEntry(entry) {
  return entry && typeof entry === 'object' && typeof entry.family === 'string' && entry.family.trim()
    && typeof entry.query === 'string' && entry.query.trim() && typeof entry.holds === 'string'
    && Number.isFinite(entry.stale_after_days) && entry.stale_after_days >= 0
    && (entry.applies_when === undefined || typeof entry.applies_when === 'string')
}

function executable(query) {
  if (query.startsWith('mcp__')) return null
  const unquoted = query.trim().replace(/^(['"])(.*?)\1/, '$2')
  return unquoted.split(/\s+/)[0]?.split('{{')[0] || null
}

function binaryOnPath(binary, env) {
  if (!binary) return false
  if (binary.includes('/') || binary.includes('\\')) {
    try { accessSync(binary, constants.X_OK); return true } catch { return false }
  }
  const pathKey = process.platform === 'win32'
    ? Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
    : 'PATH'
  const pathValue = pathKey ? env[pathKey] : null
  if (!pathValue) return false
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  return pathValue.split(path.delimiter).some((directory) => extensions.some((extension) => {
    try { accessSync(path.join(directory || '.', `${binary}${extension}`), constants.X_OK); return true } catch { return false }
  }))
}

function toolPatternMatches(pattern, toolName) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  try { return new RegExp(`^${escaped}$`, 'i').test(toolName) } catch { return false }
}

function queryMissing(query, env, availableTools, installedMcpNames) {
  if (query.startsWith('mcp__')) {
    const tools = Array.isArray(availableTools) ? availableTools : []
    const server = query.split('__')[1]
    const knownServer = installedMcpNames?.includes(server)
    return tools.length > 0 ? !tools.some((tool) => toolPatternMatches(query, tool)) : knownServer === false
  }
  return !binaryOnPath(executable(query), env)
}

export function loadGroundingRegistryReport({ cwd = process.cwd(), env = process.env, availableTools, installedMcpNames } = {}) {
  const defaults = env.WT_GROUNDING_DEFAULT_REGISTRY || path.join(PLUGIN_ROOT, 'config', 'grounding-sources.json')
  const layers = [
    ['plugin', defaults],
    ['user', userRegistryPath(env)],
    ['project', path.join(cwd, PROJECT_REGISTRY)],
  ]
  const merged = new Map()
  const warnings = []
  for (const [layer, file] of layers) {
    const parsed = parsedJsonFile(file)
    if (parsed.warning) warnings.push(`${layer} layer ${file} ${parsed.warning}`)
    if (parsed.value !== null && !Array.isArray(parsed.value)) warnings.push(`${layer} layer ${file} is not a JSON array`)
    const entries = Array.isArray(parsed.value) ? parsed.value : []
    for (const [index, entry] of entries.entries()) {
      if (!validEntry(entry)) { warnings.push(`${layer} entry ${index + 1} in ${file} is invalid`); continue }
      if (layer === 'project' && merged.has(entry.family)) {
        warnings.push(`project entry ${index + 1} cannot override family ${entry.family}`)
        continue
      }
      merged.set(entry.family, { ...entry, layer, source: file })
    }
  }
  const entries = [...merged.values()]
    .sort((a, b) => a.family.localeCompare(b.family))
    .map((entry) => ({
      ...entry,
      missing: queryMissing(entry.query, env, availableTools, installedMcpNames),
    }))
  return { entries, warnings }
}

export function loadGroundingRegistry(options = {}) {
  return loadGroundingRegistryReport(options).entries
}

export function applicableGroundingSources(entries, prompt) {
  return entries.filter((entry) => {
    if (!entry.applies_when) return true
    try { return new RegExp(entry.applies_when, 'i').test(prompt) } catch { return false }
  })
}

export function detectedMcpServerNames(configDirPath, { cwd } = {}) {
  const candidates = [
    path.join(configDirPath, 'settings.json'),
    path.join(configDirPath, '.claude.json'),
    ...(cwd ? [path.join(cwd, '.mcp.json')] : []),
  ]
  const settings = jsonFile(path.join(configDirPath, 'settings.json'))
  const installed = jsonFile(path.join(configDirPath, 'plugins', 'installed_plugins.json'))?.plugins
  if (installed && typeof installed === 'object') {
    for (const [id, records] of Object.entries(installed)) {
      if (settings?.enabledPlugins?.[id] === false) continue
      const record = Array.isArray(records) ? records[0] : records
      if (typeof record?.installPath !== 'string') continue
      candidates.push(path.join(record.installPath, '.mcp.json'), path.join(record.installPath, '.claude-plugin', 'plugin.json'))
    }
  }
  const names = new Set()
  for (const file of candidates) {
    const value = jsonFile(file)
    for (const name of Object.keys(value?.mcpServers ?? {})) names.add(name)
  }
  return [...names].sort()
}

export function detectedUserRegistry({ env = process.env, configDir: configDirPath = groundingConfigDir(env) } = {}) {
  const nonKnowledgeServers = new Set(['excalidraw', 'time'])
  const entries = detectedMcpServerNames(configDirPath).filter((name) => !nonKnowledgeServers.has(name.toLowerCase())).map((name) => ({
    family: name,
    query: `mcp__${name}__*`,
    holds: `Information available through the ${name} MCP server.`,
    stale_after_days: 7,
  }))
  for (const binary of ['gh', 'jira']) {
    if (!binaryOnPath(binary, env)) continue
    entries.push({
      family: binary === 'gh' ? 'github-cli' : 'jira-cli',
      query: binary === 'gh' ? 'gh search code {{query}}' : 'jira issue list --query {{query}}',
      holds: `Information available through the ${binary} command-line client.`,
      stale_after_days: 7,
    })
  }
  return entries
}

export function initUserRegistry({ target, env = process.env, configDir: configDirPath = groundingConfigDir(env), dryRun = false } = {}) {
  const destination = target || userRegistryPath(env)
  if (existsSync(destination)) return { written: false, reason: 'exists', target: destination, entries: null }
  const entries = detectedUserRegistry({ env, configDir: configDirPath })
  if (!dryRun) {
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(entries, null, 2)}\n`, { flag: 'wx' })
  }
  return { written: !dryRun, reason: dryRun ? 'dry-run' : 'created', target: destination, entries }
}

function contentBlocks(record) {
  const content = record?.message?.content
  return Array.isArray(content) ? content : []
}

function textContent(record) {
  const content = record?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some((block) => block?.type === 'tool_result')) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

const MACHINE_ENVELOPE = /^(?:\s*<(?:task-notification|system-reminder)|\s*(?:Stop hook feedback|Another Claude session sent|This session is being continued))/i

export function humanPromptText(record) {
  if (record?.isMeta) return ''
  if (record?.type === 'attachment' && record?.attachment?.type === 'queued_command') {
    const prompt = String(record.attachment.prompt || '')
    return record.attachment.commandMode === 'task-notification' || MACHINE_ENVELOPE.test(prompt) ? '' : prompt
  }
  if (record?.type !== 'user' || record?.message?.role !== 'user') return false
  const text = textContent(record)
  return !text || MACHINE_ENVELOPE.test(text) ? '' : text
}

function shellWords(command) {
  return String(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, '$2')) ?? []
}

function commandMatchesTemplate(command, template) {
  const actual = shellWords(command)
  const expected = shellWords(template).filter((word) => word !== '{{query}}' && !word.includes('{{query}}'))
  const executableName = path.basename(expected[0] || '')
  if (!executableName || !actual.some((word) => path.basename(word) === executableName)) return false
  const keyTokens = expected.slice(1).filter((word) => word.startsWith('-') || ['log', 'grep', 'show'].includes(word))
  return keyTokens.every((token) => token === '-S' ? actual.some((word) => word === '-S' || word === '-G') : actual.includes(token))
}

function registeredMcpRead(toolName, entries, installedMcpNames) {
  if (!toolName.startsWith('mcp__') || !/(?:^|_)(?:get|find|search|list|read|query)(?:_|$)/i.test(toolName.split('__').at(-1) || '')) return false
  if (entries.some((entry) => entry.query.startsWith('mcp__') && toolPatternMatches(entry.query, toolName))) return true
  const lower = toolName.toLowerCase()
  return (installedMcpNames || []).some((name) => lower.includes(String(name).toLowerCase()))
}

function evidenceFor(record, entries, installedMcpNames) {
  for (const block of contentBlocks(record)) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
    if (['Read', 'Grep', 'Glob', 'LSP'].includes(block.name) || block.name.startsWith('LSP')) return block.name
    if (registeredMcpRead(block.name, entries, installedMcpNames)) return block.name
    const command = String(block.input?.command ?? block.input?.code ?? '')
    const shellTool = block.name === 'Bash' || /(?:shell|bash|execute)/i.test(block.name)
    if (shellTool && entries.some((entry) => !entry.query.startsWith('mcp__') && commandMatchesTemplate(command, entry.query))) return block.name
  }
  return null
}

function transcriptTail(transcriptPath, byteCap = TRANSCRIPT_BYTE_CAP) {
  let fd
  try {
    const size = statSync(transcriptPath).size
    const start = Math.max(0, size - byteCap)
    const buffer = Buffer.alloc(size - start)
    fd = openSync(transcriptPath, 'r')
    readSync(fd, buffer, 0, buffer.length, start)
    closeSync(fd); fd = undefined
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return { lines, truncated: start > 0 }
  } catch {
    if (fd !== undefined) try { closeSync(fd) } catch { /* best-effort cleanup */ }
    return null
  }
}

export function transcriptGroundingStatus(transcriptPath, entries, { installedMcpNames = [], byteCap = TRANSCRIPT_BYTE_CAP } = {}) {
  const tail = transcriptTail(transcriptPath, byteCap)
  if (!tail) return { sourceQueried: 'unknown', lastUserKey: 'unknown', evidence: [] }
  const evidence = []
  for (let index = tail.lines.length - 1; index >= 0; index--) {
    let record
    try { record = JSON.parse(tail.lines[index]) } catch { continue }
    const human = humanPromptText(record)
    if (human) {
      const key = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16)
      return { sourceQueried: evidence.length > 0, lastUserKey: key, evidence: [...new Set(evidence)] }
    }
    const found = evidenceFor(record, entries, installedMcpNames)
    if (found) evidence.push(found)
  }
  if (tail.truncated) return { sourceQueried: 'unknown', lastUserKey: 'unknown', evidence }
  return { sourceQueried: evidence.length > 0, lastUserKey: 'no-user-record', evidence: [...new Set(evidence)] }
}

export function transcriptContextKey(transcriptPath) {
  const tail = transcriptTail(transcriptPath)
  if (!tail) return 'unknown'
  for (let index = tail.lines.length - 1; index >= 0; index--) {
    try {
      const record = JSON.parse(tail.lines[index])
      if (record?.type === 'system' && record?.subtype === 'compact_boundary') return String(record.uuid || record.timestamp || createHash('sha256').update(tail.lines[index]).digest('hex').slice(0, 16))
    } catch { /* malformed transcript lines are skipped */ }
  }
  return tail.truncated ? 'unknown' : 'initial'
}

function stateRoot(env) {
  return env.WT_GROUNDING_STATE_DIR || path.join(resolvePluginDataDir({ env, pluginName: pluginName() }).dir, 'grounding')
}

function safeSession(sessionId) {
  return String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
}

function statePath(sessionId, agentId, env) {
  return path.join(stateRoot(env), `${safeSession(sessionId)}--${safeSession(agentId || 'main')}.json`)
}

export function readGroundingState(sessionId, agentId, env = process.env) {
  return jsonFile(statePath(sessionId, agentId, env)) ?? {}
}

export function writeGroundingState(sessionId, agentId, state, env = process.env) {
  const root = stateRoot(env)
  mkdirSync(root, { recursive: true })
  writeFileSync(statePath(sessionId, agentId, env), `${JSON.stringify(state)}\n`)
  try {
    const files = readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => ({ name, mtime: statSync(path.join(root, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)
    for (const old of files.slice(MAX_STATE_FILES)) unlinkSync(path.join(root, old.name))
  } catch { /* state cleanup is bounded bookkeeping and stays fail-open */ }
}

export function outboundClaimTool(payload, configured = '') {
  const tool = String(payload?.tool_name ?? '')
  const patterns = String(configured || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
  if (patterns.some((pattern) => toolPatternMatches(pattern, tool))) return true
  if (tool.startsWith('mcp__')) {
    const action = tool.split('__').at(-1) || ''
    if (/atrium/i.test(tool) && action === 'speak') return true
    if (/slack/i.test(tool) && /(?:^|_)send(?:_|$)/i.test(action)) return true
    if (/(?:comment|message|reply)/i.test(action) && /(?:^|_)(?:add|create|post|send|speak|update)(?:_|$)/i.test(action)) return true
    return false
  }
  if (tool !== 'Bash') return false
  const segments = String(payload?.tool_input?.command ?? '').split(/[;&|]/).map((part) => part.trim())
  return segments.some((segment) => {
    const words = segment.split(/\s+/)
    return (words[0] === 'gh' && ['pr', 'issue'].includes(words[1]) && words[2] === 'comment')
      || (words[0] === 'jira' && words.includes('comment'))
  })
}

export function retryKey(payload, lastUserKey) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    return value
  }
  return createHash('sha256')
    .update(`${lastUserKey}\0${payload?.tool_name ?? ''}\0${JSON.stringify(canonical(payload?.tool_input ?? {}))}`)
    .digest('hex')
}

export function boundedFamilyNames(entries, maxLength = 300) {
  const names = entries.map((entry) => String(entry.family).slice(0, MAX_FAMILY_LENGTH))
  let text = ''
  for (const name of names) {
    const candidate = text ? `${text}, ${name}` : name
    if (candidate.length > maxLength) return `${text}, ...`
    text = candidate
  }
  return text
}

export function readHookPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8')) } catch { return null }
}
