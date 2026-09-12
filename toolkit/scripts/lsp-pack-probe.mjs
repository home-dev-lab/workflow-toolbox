import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLKIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(TOOLKIT_DIR, '..')
const TIMEOUT_MS = Number(process.env.WT_LSP_PROBE_TIMEOUT_MS ?? 90_000)
export const CAPABILITIES = ['diagnostics', 'symbol-overview', 'symbol-lookup', 'declarations', 'references', 'implementations']

const CAPABILITY_REQUESTS = {
  'symbol-overview': ['textDocument/documentSymbol'],
  'symbol-lookup': ['workspace/symbol', 'textDocument/definition'],
  declarations: ['textDocument/declaration', 'textDocument/definition'],
  references: ['textDocument/references'],
  implementations: ['textDocument/implementation'],
}

export function parseProbeArguments(args) {
  const [pack, ...rest] = args
  let capability = 'diagnostics'
  if (!pack || (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--capability'))) {
    throw new Error('usage: lsp-pack-probe.mjs <pack> [--capability <name>]')
  }
  if (rest.length) capability = rest[1]
  if (!CAPABILITIES.includes(capability)) throw new Error(`unknown capability: ${capability}`)
  return { pack, capability }
}

export function resolveCommand(command, pathValue) {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command)
    try {
      if (lstatSync(candidate).isDirectory()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

export function buildShimDirectory(pathValue, excludedCommand, shimDirectory) {
  mkdirSync(shimDirectory, { recursive: true })
  const linked = new Set()
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    let entries
    try {
      entries = readdirSync(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry === excludedCommand || linked.has(entry)) continue
      const source = join(directory, entry)
      try {
        if (lstatSync(source).isDirectory()) continue
        accessSync(source, constants.X_OK)
        symlinkSync(source, join(shimDirectory, entry))
        linked.add(entry)
      } catch {}
    }
  }
  return [...linked].sort()
}

/**
 * A language server usually needs the language's own toolchain resolvable FROM THE WORKSPACE
 * (typescript-language-server refuses `initialize` with "Could not find a valid TypeScript
 * installation" in a project without a `typescript` module — measured 2026-09-12). A fixture may
 * therefore carry `workspace-modules.txt`, one package name per line; each is symlinked from the
 * toolkit's own `node_modules` into the temporary project, offline. The manifest never travels
 * into the project. An unknown name is refused: a silently missing module would make the
 * available arm fail for a reason the archive could not show.
 */
export function linkWorkspaceModules(projectDir, toolkitDir) {
  const manifest = join(projectDir, 'workspace-modules.txt')
  let names
  try {
    names = readFileSync(manifest, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
  rmSync(manifest, { force: true })
  mkdirSync(join(projectDir, 'node_modules'), { recursive: true })
  for (const name of names) {
    const source = join(toolkitDir, 'node_modules', name)
    try {
      lstatSync(source)
    } catch {
      throw new Error(`workspace module not installed in the toolkit: ${name} (${source})`)
    }
    // A COPY, never a symlink: the headless session may edit anything under its project, and a
    // symlink would hand it the toolkit's real installation (review finding, 2026-09-12).
    cpSync(source, join(projectDir, 'node_modules', name), { recursive: true, dereference: true })
  }
  return names
}

/**
 * Delivery provenance. Measured 2026-09-12 (TypeScript, Claude Code headless, `--output-format
 * stream-json --verbose`): a delivered diagnostic reaches the MODEL as a context attachment, and
 * that attachment is NOT emitted as a `user` tool_result event — the only structural record is
 * Claude Code's own `--debug-file`, which logs `Received notification
 * 'textDocument/publishDiagnostics'` and `LSP Diagnostics: Returning N diagnostic attachment(s)`.
 * So the harness debug log decides WHETHER a diagnostic was delivered, and the session output only
 * corroborates WHICH one (the expected substring, quoted by the model or present in a tool result).
 * Assistant prose alone never passes: a model can write "<new-diagnostics>" from its own inference.
 */
export function deliveredAttachments(debugText) {
  let delivered = 0
  for (const match of debugText.matchAll(/LSP Diagnostics: Returning (\d+) diagnostic attachment/g)) {
    delivered += Number(match[1])
  }
  return delivered
}

export function publishedDiagnostics(debugText) {
  return /Received notification 'textDocument\/publishDiagnostics'/.test(debugText)
}

export function containsDiagnostic(output, expectedSubstring, { includeAssistantText = false } = {}) {
  for (const line of output.split('\n')) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!Array.isArray(event?.message?.content)) continue
    if (event.type !== 'user' && !(includeAssistantText && event.type === 'assistant')) continue
    for (const item of event.message.content) {
      const content =
        item?.type === 'tool_result'
          ? typeof item.content === 'string'
            ? item.content
            : JSON.stringify(item.content)
          : item?.type === 'text'
            ? item.text
            : ''
      if (content.includes('<new-diagnostics>') && content.includes(expectedSubstring)) return true
    }
  }
  return false
}

export function availableVerdict({ commandResolved, output, debug = '', expectedSubstring, exitCode, timedOut }) {
  const delivered = deliveredAttachments(debug) > 0 && publishedDiagnostics(debug)
  const diagnostic = delivered && containsDiagnostic(output, expectedSubstring, { includeAssistantText: true })
  const pass = Boolean(commandResolved) && diagnostic && exitCode === 0 && !timedOut
  return {
    pass,
    diagnostic,
    reason: pass
      ? 'diagnostic delivered by the harness and named in the session'
      : `resolved command, harness-delivered diagnostic naming the planted error, and normal exit required (delivered=${delivered})`,
  }
}

export function missingVerdict({ commandResolved, claudeResolved, nodeResolved, output, debug = '', exitCode, timedOut }) {
  const diagnostic = deliveredAttachments(debug) > 0 || publishedDiagnostics(debug) || containsDiagnostic(output, '')
  const pass = !commandResolved && Boolean(claudeResolved) && Boolean(nodeResolved) && !diagnostic && exitCode === 0 && !timedOut
  return { pass, diagnostic, reason: pass ? 'failed open without diagnostics' : 'isolated PATH, no diagnostic, and normal exit required' }
}

export function assistantText(output) {
  let text = ''
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type !== 'assistant' || !Array.isArray(event?.message?.content)) continue
      for (const item of event.message.content) if (item?.type === 'text' && typeof item.text === 'string') text += `${item.text}\n`
    } catch {}
  }
  return text
}

export function serverStartFailure(debug, language) {
  if (!language) return undefined
  const prefix = `[LSP SERVER plugin:workflow-toolbox:${language}]`
  const start = `Starting LSP server instance: plugin:workflow-toolbox:${language}`
  const failure = debug.split('\n').find((line) => line.includes(prefix) && /Traceback|Exception|exited|failed/.test(line))
  if (failure) return failure.trim().slice(0, 160)
  if (!debug.includes(start)) return `missing ${start}`
  return undefined
}

export function navigationVerdict({ commandResolved = true, output, debug = '', expectedSubstrings, capability, exitCode, timedOut, language }) {
  if (!commandResolved) return { verdict: 'unmeasured', reason: 'language-server binary missing' }
  if (timedOut || exitCode === null) return { verdict: 'unmeasured', reason: timedOut ? 'probe timed out' : 'probe did not run' }
  const serverFailure = serverStartFailure(debug, language)
  if (serverFailure) return { verdict: 'unmeasured', reason: `server failed to start: ${serverFailure}` }
  const answer = expectedSubstrings.every((substring) => assistantText(output).includes(substring))
  const requests = CAPABILITY_REQUESTS[capability] ?? []
  const observedRequests = requests.filter((request) => debug.includes(request))
  if (answer && observedRequests.length) return { verdict: 'parity', reason: `assistant answer corroborated by ${observedRequests.join(', ')}`, requests: observedRequests }
  if (!answer) return { verdict: 'no parity', reason: 'planted answer absent from assistant session text', requests: observedRequests }
  return { verdict: 'no parity', reason: 'planted answer present without matching LSP request', requests: observedRequests }
}

function commandVersion(command, env) {
  const result = spawnSync(command, ['--version'], { env, encoding: 'utf8', timeout: 10_000 })
  return `${result.stdout ?? ''}${result.stderr ?? ''}` || `--version exited ${result.status}\n`
}

function runtimeVersion(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 10_000 })
  return `${result.stdout ?? ''}${result.stderr ?? ''}` || `${args.join(' ')} exited ${result.status}\n`
}

function runtimeDetails(pack, env) {
  const pathValue = env.PATH ?? ''
  if (pack === 'java') {
    const java = resolveCommand('java', pathValue)
    return `command -v java: ${java ?? 'not found'}\n${java ? runtimeVersion(java, ['-version'], env) : ''}`
  }
  const command = pack === 'typescript' ? 'tsserver' : 'pyright'
  const resolved = resolveCommand(command, pathValue)
  return `command -v ${command}: ${resolved ?? 'not found'}\n${resolved ? commandVersion(resolved, env) : ''}`
}

function runClaude(cwd, pluginDir, env, debugFile, prompt = [
    'Read the single source file in this project.',
    'Make one harmless whitespace-only edit to that file so language-server diagnostics can arrive.',
    'Then run the Bash command `sleep 15` (diagnostics are delivered asynchronously, on a later tool result), then read the file again with the Read tool.',
    'Do not diagnose the code yourself. If and only if a <new-diagnostics> block is delivered, quote that block verbatim; otherwise say no diagnostics arrived.',
  ].join(' ')) {
  const args = [
    '-p',
    '--plugin-dir',
    pluginDir,
    '--permission-mode',
    'acceptEdits',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--debug-file',
    debugFile,
    prompt,
  ]

  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ stdout, stderr: `${stderr}${error.stack ?? error.message}\n`, exitCode: null, timedOut, elapsedMs: Date.now() - started })
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolveRun({ stdout, stderr, exitCode, timedOut, elapsedMs: Date.now() - started })
    })
  })
}

function readDebug(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function archiveArm(directory, resolution, version, runtime, run, prompt) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'stdout.log'), run.stdout)
  writeFileSync(join(directory, 'stderr.log'), run.stderr)
  writeFileSync(join(directory, 'elapsed-ms.txt'), `${run.elapsedMs}\n`)
  writeFileSync(join(directory, 'command-v.txt'), resolution ? `${resolution}\n` : 'not found\n')
  writeFileSync(join(directory, 'version.txt'), version)
  writeFileSync(join(directory, 'runtime.txt'), runtime)
  writeFileSync(join(directory, 'workspace-modules.txt'), `${run.workspaceModules.join('\n')}\n`)
  if (prompt) writeFileSync(join(directory, 'prompt.txt'), `${prompt}\n`)
}

export async function probePack(pack, options = {}) {
  const capability = options.capability ?? 'diagnostics'
  if (!CAPABILITIES.includes(capability)) throw new Error(`unknown capability: ${capability}`)
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const originalPath = options.pathValue ?? process.env.PATH ?? ''
  const packDir = join(repoRoot, 'plugin', 'packs', pack)
  const declarations = JSON.parse(readFileSync(join(packDir, '.lsp.json'), 'utf8'))
  const declarationEntries = Object.entries(declarations)
  if (declarationEntries.length !== 1) throw new Error(`${pack}: probe requires exactly one LSP declaration`)
  const [, declaration] = declarationEntries[0]
  if (/[\\/]/.test(declaration.command)) throw new Error(`${pack}: command must be a bare executable name, not a path`)
  const fixtureDir = join(packDir, 'probe')
  if (capability !== 'diagnostics') return probeNavigation(pack, capability, { ...options, repoRoot, originalPath, packDir, declaration, fixtureDir })
  const expectedSubstring = readFileSync(join(fixtureDir, 'expected-diagnostic.txt'), 'utf8').trim()
  if (!expectedSubstring) throw new Error(`${pack}: expected diagnostic substring is empty`)

  const temporary = mkdtempSync(join(tmpdir(), `wt-lsp-${pack}-`))
  try {
    const projectDir = join(temporary, 'project')
    const shimDir = join(temporary, 'shim')
    // The session loads a DISPOSABLE copy of the plugin: everything it can reach lives under `temporary`.
    const pluginCopy = join(temporary, 'plugin')
    cpSync(join(repoRoot, 'plugin'), pluginCopy, { recursive: true, dereference: true })
    cpSync(fixtureDir, projectDir, { recursive: true })
    rmSync(join(projectDir, 'expected-diagnostic.txt'), { force: true })
    const workspaceModules = linkWorkspaceModules(projectDir, options.toolkitDir ?? TOOLKIT_DIR)
    const archiveRoot =
      options.archiveRoot ?? process.env.WT_LSP_PROBE_ARCHIVE_ROOT ?? join(repoRoot, '.claude', 'reports', '1861821660-lsp-probes')
    const availableDir = join(archiveRoot, pack, 'available')
    const missingDir = join(archiveRoot, pack, 'missing')
    mkdirSync(availableDir, { recursive: true })
    mkdirSync(missingDir, { recursive: true })

    const availableResolution = resolveCommand(declaration.command, originalPath)
    const availableEnv = { ...process.env, PATH: originalPath }
    const availableRun = await runClaude(projectDir, pluginCopy, availableEnv, join(availableDir, 'debug.log'))
    availableRun.workspaceModules = workspaceModules
    const availableOutput = `${availableRun.stdout}\n${availableRun.stderr}`
    const available = availableVerdict({
      commandResolved: availableResolution,
      output: availableOutput,
      debug: readDebug(join(availableDir, 'debug.log')),
      expectedSubstring,
      exitCode: availableRun.exitCode,
      timedOut: availableRun.timedOut,
    })
    archiveArm(
      availableDir,
      availableResolution,
      availableResolution ? commandVersion(availableResolution, availableEnv) : 'unavailable\n',
      runtimeDetails(pack, availableEnv),
      availableRun,
    )
    const availableServerFailure = serverStartFailure(readDebug(join(availableDir, 'debug.log')), pack)
    writeFileSync(join(availableDir, 'verdict.json'), `${JSON.stringify({ capability, verdict: available.pass ? 'parity' : availableRun.timedOut || availableRun.exitCode === null || !availableResolution || availableServerFailure ? 'unmeasured' : 'no parity', reason: availableServerFailure ? `server failed to start: ${availableServerFailure}` : available.reason }, null, 2)}\n`)
    console.log(`available: ${available.pass ? 'PASS' : 'FAIL'} - ${available.reason}`)

    buildShimDirectory(originalPath, declaration.command, shimDir)
    const missingEnv = { ...process.env, PATH: shimDir }
    const missingResolution = resolveCommand(declaration.command, shimDir)
    const claudeResolution = resolveCommand('claude', shimDir)
    const nodeResolution = resolveCommand('node', shimDir)
    if (missingResolution || !claudeResolution || !nodeResolution) {
      throw new Error(
        `missing arm PATH precondition failed: ${declaration.command}=${missingResolution ?? 'absent'} claude=${claudeResolution ?? 'absent'} node=${nodeResolution ?? 'absent'}`,
      )
    }
    const missingRun = await runClaude(projectDir, pluginCopy, missingEnv, join(missingDir, 'debug.log'))
    missingRun.workspaceModules = workspaceModules
    const missingOutput = `${missingRun.stdout}\n${missingRun.stderr}`
    const missing = missingVerdict({
      commandResolved: missingResolution,
      claudeResolved: claudeResolution,
      nodeResolved: nodeResolution,
      output: missingOutput,
      debug: readDebug(join(missingDir, 'debug.log')),
      exitCode: missingRun.exitCode,
      timedOut: missingRun.timedOut,
    })
    archiveArm(
      missingDir,
      missingResolution,
      'unavailable by design\n',
      runtimeDetails(pack, missingEnv),
      missingRun,
    )
    console.log(`missing: ${missing.pass ? 'PASS' : 'FAIL'} - ${missing.reason}`)
    return available.pass && missing.pass
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

async function probeNavigation(pack, capability, { repoRoot, originalPath, declaration, fixtureDir, ...options }) {
  const navigationDir = join(fixtureDir, 'nav')
  const expected = JSON.parse(readFileSync(join(navigationDir, 'expected-navigation.json'), 'utf8'))[capability]
  if (!expected?.prompt || !Array.isArray(expected.expectedSubstrings) || expected.expectedSubstrings.length === 0) {
    throw new Error(`${pack}: ${capability} requires prompt and expectedSubstrings`)
  }
  const temporary = mkdtempSync(join(tmpdir(), `wt-lsp-${pack}-`))
  const archiveRoot = options.archiveRoot ?? process.env.WT_LSP_PROBE_ARCHIVE_ROOT ?? join(repoRoot, '.claude', 'reports', '1861821660-lsp-probes')
  const armDir = join(archiveRoot, pack, capability, 'available')
  mkdirSync(armDir, { recursive: true })
  try {
    const projectDir = join(temporary, 'project')
    const pluginCopy = join(temporary, 'plugin')
    cpSync(join(repoRoot, 'plugin'), pluginCopy, { recursive: true, dereference: true })
    cpSync(navigationDir, projectDir, { recursive: true })
    rmSync(join(projectDir, 'expected-navigation.json'), { force: true })
    const workspaceModules = linkWorkspaceModules(projectDir, options.toolkitDir ?? TOOLKIT_DIR)
    const resolution = resolveCommand(declaration.command, originalPath)
    const run = resolution
      ? await runClaude(projectDir, pluginCopy, { ...process.env, PATH: originalPath }, join(armDir, 'debug.log'), expected.prompt)
      : { stdout: '', stderr: '', exitCode: null, timedOut: false, elapsedMs: 0 }
    run.workspaceModules = workspaceModules
    const env = { ...process.env, PATH: originalPath }
    const verdict = navigationVerdict({ commandResolved: resolution, output: `${run.stdout}\n${run.stderr}`, debug: readDebug(join(armDir, 'debug.log')), expectedSubstrings: expected.expectedSubstrings, capability, exitCode: run.exitCode, timedOut: run.timedOut, language: pack })
    archiveArm(armDir, resolution, resolution ? commandVersion(resolution, env) : 'unavailable\n', runtimeDetails(pack, env), run, expected.prompt)
    writeFileSync(join(armDir, 'verdict.json'), `${JSON.stringify({ capability, ...verdict }, null, 2)}\n`)
    console.log(`${capability}: ${verdict.verdict} - ${verdict.reason}`)
    return verdict.verdict === 'parity'
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed
  try {
    parsed = parseProbeArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
  if (parsed) {
    probePack(parsed.pack, { capability: parsed.capability })
      .then((pass) => {
        if (!pass) process.exitCode = 1
      })
      .catch((error) => {
        console.error(error.stack ?? error.message)
        process.exitCode = 1
      })
  }
}
