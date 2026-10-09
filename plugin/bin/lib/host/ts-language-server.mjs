import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 1024 * 1024
const FOLDERS = ['node_modules/typescript/lib', '.vscode/pnpify/typescript/lib', '.yarn/sdks/typescript/lib', '.pnpm/sdks/typescript/lib']
const REFUSAL = 'wt-tsls: no TypeScript LSP backend available. Install TypeScript 7 (native platform package) or typescript-language-server on PATH.'
const SEARCH_DEPTH = 3
const SEARCH_LIMIT = 2000
const SEARCH_SKIP = new Set(['node_modules', '.git'])
const NO_TYPESCRIPT = `wt-tsls: typescript-language-server is installed but no TypeScript was found: not in the workspace or its parents, not in the node_modules of its sub-folders (${SEARCH_DEPTH} levels deep, ${SEARCH_LIMIT} folders at most), not where typescript-language-server resolves its own, behind tsc on PATH, or in the global npm or pnpm root. Install it in the project (npm install -D typescript) or globally (npm install -g typescript).`

function realHost() {
  return {
    platform: process.platform, arch: process.arch, env: process.env, execPath: process.execPath, home: homedir(), cwd: process.cwd(),
    isFile(file) { try { return statSync(file).isFile() } catch { return false } },
    exists(file) { try { statSync(file); return true } catch { return false } },
    readText(file) { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    realpath(file) { try { return realpathSync.native(file) } catch { return undefined } },
    // Symbolic links are not followed, so the bounded sub-folder search cannot loop.
    readdir(dir) { try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) } catch { return [] } },
  }
}

const pathFor = (host) => host.platform === 'win32' ? win32 : posix

function onPath(name, host) {
  const path = pathFor(host)
  const entries = (host.platform === 'win32' ? host.env.Path ?? host.env.PATH ?? '' : host.env.PATH ?? '').split(path.delimiter)
  for (const dir of entries.filter(Boolean)) {
    for (const suffix of host.platform === 'win32' ? ['.cmd', ''] : ['']) {
      const candidate = path.join(dir, name + suffix)
      if (host.isFile(candidate)) return { candidate, dir, real: host.realpath(candidate) ?? candidate }
    }
  }
  return undefined
}

function packageRoot(binary, name, host) {
  const path = pathFor(host)
  const real = binary.real
  if (name === 'typescript-language-server' && path.basename(real) === 'cli.mjs' && path.basename(path.dirname(real)) === 'lib' && path.basename(path.dirname(path.dirname(real))) === name) return path.dirname(path.dirname(real))
  if (path.basename(real) === (name === 'typescript' ? 'tsc' : name) && path.basename(path.dirname(real)) === 'bin' && path.basename(path.dirname(path.dirname(real))) === name) return path.dirname(path.dirname(real))
  // Only npm's adjacent node_modules shim is recognized; other wrappers never execute.
  const executableName = name === 'typescript' ? 'tsc' : name
  if (host.platform === 'win32' && binary.candidate === path.join(binary.dir, `${executableName}.cmd`)) {
    const root = path.join(binary.dir, 'node_modules', name)
    if (host.isFile(path.join(root, name === 'typescript' ? 'bin/tsc' : 'lib/cli.mjs'))) return root
  }
  return undefined
}

function metadata(file, host) {
  try { return JSON.parse(host.readText(file)) } catch { return undefined }
}

function workspaceRoot(params, host) {
  try { return params.rootUri ? fileURLToPath(params.rootUri, { windows: host.platform === 'win32' }) : params.rootPath } catch { return undefined }
}

function workspaceVersion(params, host) {
  const path = pathFor(host)
  const root = workspaceRoot(params, host)
  if (!root) return false
  for (let dir = path.resolve(root);;) {
    // tls picks the first folder that exists, even if it is unusable; it then stops walking.
    const folder = FOLDERS.map((name) => path.resolve(dir, name)).find((name) => host.exists(name))
    if (folder) {
      const pkg = metadata(path.join(path.dirname(folder), 'package.json'), host)
      return host.isFile(path.join(folder, 'tsserver.js')) && Boolean(pkg?.version)
    }
    const parent = path.resolve(dir, '..')
    if (parent === dir) return false
    dir = parent
  }
}

function tlsBackend(host) {
  const bin = onPath('typescript-language-server', host)
  if (!bin) return undefined
  const root = packageRoot(bin, 'typescript-language-server', host)
  const script = root && pathFor(host).join(root, 'lib', 'cli.mjs')
  return script && host.isFile(script) ? { status: 'launch', backend: 'typescript-language-server', command: host.execPath, args: [script, '--stdio'], root } : undefined
}

function typescriptAt(root, host) {
  if (!root) return undefined
  const path = pathFor(host)
  const server = path.join(root, 'lib', 'tsserver.js')
  const pkg = metadata(path.join(root, 'package.json'), host)
  return host.isFile(server) && pkg?.name === 'typescript' && pkg.version ? server : undefined
}

// `.claude` first, then code-unit name order: the same tree always yields the same TypeScript.
function byCodeUnit(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const searchOrder = (names) => names.filter((name) => !SEARCH_SKIP.has(name)).sort((a, b) => Number(b === '.claude') - Number(a === '.claude') || byCodeUnit(a, b))

// Breadth-first from `level`, so the shallowest project wins; `budget.left` bounds the folders read.
function searchLevels(level, depth, host, budget) {
  const path = pathFor(host)
  for (; depth <= SEARCH_DEPTH && level.length; depth++) {
    const next = []
    for (const dir of level) {
      for (const child of searchOrder(host.readdir(dir)).map((name) => path.join(dir, name))) {
        if (--budget.left < 0) return undefined
        const found = typescriptAt(path.join(child, 'node_modules', 'typescript'), host)
        if (found) return found
        next.push(child)
      }
    }
    level = next
  }
  return undefined
}

// Shallowest first, so a nested checkout under `.claude` never beats a project at the top. A session rooted
// at the home directory is no project: its sub-folders hold host caches (~/.npm/_npx), so they are not searched.
function subfolderTypescript(root, host) {
  const path = pathFor(host)
  const top = path.resolve(root)
  if (host.home && top === path.resolve(host.home)) return undefined
  const found = searchLevels([top], 1, host, { left: SEARCH_LIMIT })
  return found && { path: found, source: 'workspace sub-folder' }
}

// The node_modules folders Node's resolution visits from `start`, nearest first.
function moduleDirs(start, host) {
  const path = pathFor(host)
  const dirs = []
  for (let directory = start;;) {
    dirs.push(path.basename(directory) === 'node_modules' ? directory : path.join(directory, 'node_modules'))
    const parent = path.dirname(directory)
    if (parent === directory) return dirs
    directory = parent
  }
}

function globalModuleDirs(host) {
  const path = pathFor(host)
  if (host.platform === 'win32') return [path.join(path.dirname(host.execPath), 'node_modules'), host.env.APPDATA && path.join(host.env.APPDATA, 'npm', 'node_modules')]
  return [path.join(path.dirname(path.dirname(host.execPath)), 'lib', 'node_modules')]
}

function pnpmGlobalDirs(host) {
  if (!host.env.PNPM_HOME) return []
  const path = pathFor(host)
  const store = path.join(host.env.PNPM_HOME, 'global')
  return host.readdir(store).map((name) => path.join(store, name, 'node_modules'))
}

// Host package roots: those tls's own `require.resolve('typescript')` would visit from its lib folder, then the
// global npm and pnpm roots of the running node. Symbolic links (pnpm global) are resolved to the real package.
function hostRoots(host, tls) {
  const path = pathFor(host)
  const typescriptIn = (dirs) => dirs.filter(Boolean).map((dir) => {
    const root = path.join(dir, 'typescript')
    return host.realpath(root) ?? root
  })
  return { tls: typescriptIn(tls ? moduleDirs(path.join(tls.root, 'lib'), host) : []), global: typescriptIn([...globalModuleDirs(host), ...pnpmGlobalDirs(host)]) }
}

// tls's own fallback first (the TypeScript it would resolve itself), then tsc on PATH, then the global roots.
function hostTypescript(host, roots) {
  const tsc = onPath('tsc', host)
  const tscRoot = tsc && packageRoot(tsc, 'typescript', host)
  for (const root of [...roots.tls, tscRoot, ...roots.global]) {
    const found = typescriptAt(root, host)
    if (found) return { path: found, source: 'host' }
  }
  return undefined
}

function launchTls(tls, typescript) {
  const plan = { ...tls }
  delete plan.root
  return typescript ? { ...plan, tsserverPath: typescript.path, tsserverSource: typescript.source } : plan
}

function within(file, directory, host) {
  if (!directory) return false
  const path = pathFor(host)
  const relative = path.relative(host.realpath(directory) ?? directory, host.realpath(file) ?? file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function blockedBy(host, params) {
  const workspace = workspaceRoot(params, host)
  // A session opened AT the home directory must keep host installs under it (~/.nvs, ~/.local): there, only
  // `<home>/node_modules` counts as workspace. Any other root blocks everything beneath it.
  const scope = (root) => root && host.home && pathFor(host).resolve(root) === pathFor(host).resolve(host.home) ? pathFor(host).join(root, 'node_modules') : root
  return (file) => within(file, scope(workspace), host) || within(file, scope(host.cwd ?? process.cwd()), host)
}

function nativeAt(root, host, blocked) {
  const path = pathFor(host)
  const pkg = metadata(path.join(root, 'package.json'), host)
  if (pkg?.name !== 'typescript' || !/^([7-9]|[1-9]\d+)\./.test(pkg.version) || Object.keys(pkg.bin ?? {}).join() !== 'tsc') return undefined
  const platformName = `@typescript/typescript-${host.platform}-${host.arch}`
  // Mirror Node's package resolution from typescript/lib/getExePath.js through ancestor node_modules.
  for (const modules of moduleDirs(root, host)) {
    const platformRoot = path.join(modules, platformName)
    const platformPkg = metadata(path.join(platformRoot, 'package.json'), host)
    const executable = path.join(platformRoot, 'lib', `tsc${host.platform === 'win32' ? '.exe' : ''}`)
    if (platformPkg?.version === pkg.version && host.isFile(executable) && !blocked(platformRoot) && !blocked(executable)) {
      return { status: 'launch', backend: 'typescript-go', command: executable, args: ['--lsp', '--stdio'] }
    }
  }
  return undefined
}

// TypeScript 7 behind tsc on PATH first, then the host package roots; never one inside the workspace.
function nativeBackend(host, params, roots) {
  const blocked = blockedBy(host, params)
  const bin = onPath('tsc', host)
  const fromPath = bin && !blocked(bin.candidate) && !blocked(bin.real) ? packageRoot(bin, 'typescript', host) : undefined
  for (const root of [fromPath, ...roots.tls, ...roots.global]) {
    const found = root && !blocked(root) ? nativeAt(root, host, blocked) : undefined
    if (found) return found
  }
  return undefined
}

export function planTsLaunch(params, overrides = {}) {
  const host = { ...realHost(), ...overrides }
  const tls = tlsBackend(host)
  if (params.initializationOptions?.tsserver?.path) return tls ? launchTls(tls) : { status: 'refused', message: 'wt-tsls: explicit tsserver.path requires typescript-language-server on PATH; install it.' }
  if (tls && workspaceVersion(params, host)) return launchTls(tls)
  const root = workspaceRoot(params, host)
  const nested = tls && root ? subfolderTypescript(root, host) : undefined
  if (nested) return launchTls(tls, nested)
  const roots = hostRoots(host, tls)
  return nativeBackend(host, params, roots) ?? (tls ? fallbackTls(tls, host, roots, root) : { status: 'refused', message: REFUSAL })
}

// tls cannot start without a TypeScript, so a launch with none would only fail later and less legibly.
function fallbackTls(tls, host, roots, root) {
  const hosted = hostTypescript(host, roots)
  if (hosted) return launchTls(tls, hosted)
  return { status: 'refused', message: root ? NO_TYPESCRIPT : `${NO_TYPESCRIPT} The client sent no workspace root, so only the host was searched.` }
}

// tls reads initializationOptions.tsserver.path; the client sent none, so the one found is added to its frame.
function withTsserverPath(bytes, consumed, tsserverPath) {
  const end = bytes.indexOf('\r\n\r\n')
  const request = JSON.parse(bytes.subarray(end + 4, consumed).toString('utf8'))
  const params = request.params ?? {}
  const options = params.initializationOptions ?? {}
  const body = JSON.stringify({ ...request, params: { ...params, initializationOptions: { ...options, tsserver: { ...options.tsserver, path: tsserverPath } } } })
  return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`), bytes.subarray(consumed)])
}

function launchReplay(prior, buffered, consumed, plan) {
  return Buffer.concat([prior, plan.tsserverPath ? withTsserverPath(buffered, consumed, plan.tsserverPath) : buffered])
}

export function inspectInitialize(buffer) {
  if (buffer.length > LIMIT) return { status: 'refused', message: 'wt-tsls: initialize frame exceeds the size limit' }
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return { status: 'pending' }
  const header = buffer.subarray(0, end).toString('latin1')
  const lines = header.split('\r\n')
  const lengths = lines.filter((line) => /^Content-Length:/i.test(line))
  if (lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0])) return { status: 'refused', message: 'wt-tsls: malformed LSP header' }
  const length = Number(lengths[0].split(':')[1].trim())
  if (end + 4 + length > LIMIT) return { status: 'refused', message: 'wt-tsls: initialize frame exceeds the size limit' }
  if (buffer.length < end + 4 + length) return { status: 'pending' }
  let request
  try { request = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8')) } catch { return { status: 'refused', message: 'wt-tsls: malformed initialize JSON' } }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return { status: 'refused', message: 'wt-tsls: malformed initialize message' }
  if (request.method === 'exit') return { status: 'exit' }
  if (request.method === 'initialize') return { status: 'initialize', id: request.id, params: request.params ?? {}, consumed: end + 4 + length }
  if (request.id !== undefined) return { status: 'refused', message: 'wt-tsls: expected initialize before any request' }
  return { status: 'notification', consumed: end + 4 + length }
}

function refuse(message, bytes, { input, output, stderr, exit }) {
  stderr.write(`${message}\n`)
  let buffer = bytes
  let finished = false
  const finish = () => { if (!finished) { finished = true; output.write('', () => exit(1)) } }
  const receive = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > LIMIT) return finish()
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('latin1'))?.[1])
      if (!Number.isFinite(size)) return finish()
      if (size + end + 4 > LIMIT) return finish()
      if (buffer.length < end + 4 + size) return
      let request
      try { request = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString('utf8')) } catch { request = {} }
      if (!request || typeof request !== 'object') request = {}
      buffer = buffer.subarray(end + 4 + size)
      if (request.method === 'exit') { finish(); return }
      if (request.id === undefined || request.id === null) continue
      const reply = JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(request.method === 'shutdown' ? { result: null } : { error: { code: request.method === 'initialize' ? -32603 : -32002, message, data: { retry: false } } }) })
      output.write(`Content-Length: ${Buffer.byteLength(reply)}\r\n\r\n${reply}`)
    }
  }
  receive(Buffer.alloc(0))
  input.on('data', receive)
  input.on('end', finish)
  input.on('error', finish)
  if (input.readableEnded || input.destroyed) finish()
  else input.resume()
  setTimeout(finish, 30_000).unref()
}

export function runTsLaunch({ input = process.stdin, output = process.stdout, stderr = process.stderr, exit = (code) => process.exit(code), exitSignal = (signal) => process.kill(process.pid, signal), select = planTsLaunch, start = spawn } = {}) {
  let buffered = Buffer.alloc(0)
  let prior = Buffer.alloc(0)
  const streams = { input, output, stderr, exit }
  const peek = (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    const result = inspectInitialize(buffered)
    if (result.status === 'pending') return
    if (result.status === 'notification') {
      prior = Buffer.concat([prior, buffered.subarray(0, result.consumed)])
      buffered = buffered.subarray(result.consumed)
      if (prior.length + buffered.length > LIMIT) {
        input.pause()
        input.off('data', peek)
        return refuse('wt-tsls: pre-initialize frames exceed the size limit', prior, streams)
      }
      peek(Buffer.alloc(0))
      return
    }
    input.pause()
    input.off('data', peek)
    if (result.status === 'exit') return exit(0)
    if (result.status === 'refused') return refuse(result.message, Buffer.concat([prior, buffered]), streams)
    const plan = select(result.params)
    if (plan.status !== 'launch') return refuse(plan.message, Buffer.concat([prior, buffered]), streams)
    const replay = launchReplay(prior, buffered, result.consumed, plan)
    const tsserver = plan.tsserverPath ? ` with tsserver ${plan.tsserverPath} (${plan.tsserverSource})` : ''
    stderr.write(`wt-tsls: ${plan.backend} (${plan.command})${tsserver}\n`)
    const child = start(plan.command, plan.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let answered = false
    let started = false
    let refusing = false
    let responseBytes = Buffer.alloc(0)
    const signals = ['SIGTERM', 'SIGINT'].map((signal) => {
      const forward = () => { if (child.exitCode === null) child.kill(signal) }
      process.on(signal, forward)
      return [signal, forward]
    })
    const cleanup = () => { for (const [signal, forward] of signals) process.off(signal, forward) }
    child.on('error', (error) => {
      cleanup()
      if (!answered) { refusing = true; refuse(`wt-tsls: could not start ${plan.command}: ${error.message}`, replay, streams) }
      else exit(1)
    })
    child.on('spawn', () => {
      started = true
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stderr.write(`wt-tsls: ${error.message}\n`) })
      child.stdout.on('data', (chunk) => {
        responseBytes = Buffer.concat([responseBytes, chunk])
        while (responseBytes.length <= LIMIT) {
          const headerEnd = responseBytes.indexOf('\r\n\r\n')
          if (headerEnd < 0) break
          const size = Number(/Content-Length:\s*(\d+)/i.exec(responseBytes.subarray(0, headerEnd).toString('latin1'))?.[1])
          if (!Number.isSafeInteger(size) || size < 0 || size + headerEnd + 4 > LIMIT) break
          if (responseBytes.length < headerEnd + 4 + size) break
          try {
            const reply = JSON.parse(responseBytes.subarray(headerEnd + 4, headerEnd + 4 + size).toString('utf8'))
            if (reply?.id === result.id && ('result' in reply || 'error' in reply)) answered = true
          } catch { /* Forward protocol bytes unchanged; the backend owns malformed output. */ }
          responseBytes = responseBytes.subarray(headerEnd + 4 + size)
        }
        if (responseBytes.length > LIMIT) responseBytes = Buffer.alloc(0)
      })
      child.stdout.pipe(output, { end: false })
      child.stderr.pipe(stderr, { end: false })
      const handoff = () => {
        if (input.readableEnded) child.stdin.end()
        else input.pipe(child.stdin)
      }
      if (child.stdin.write(replay)) handoff()
      else child.stdin.once('drain', handoff)
    })
    child.on('close', (code, signal) => {
      cleanup()
      input.unpipe(child.stdin)
      if (refusing) return
      if (!started || answered) output.write('', () => { if (signal) exitSignal(signal); else exit(code ?? 0) })
      else refuse(`wt-tsls: ${plan.backend} exited before answering initialize`, replay, streams)
    })
  }
  input.on('data', peek)
  input.on('end', () => { if (!buffered.length) exit(0); else if (inspectInitialize(buffered).status === 'pending') exit(0) })
}
