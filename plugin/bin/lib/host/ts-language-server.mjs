import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIMIT = 1024 * 1024
const FOLDERS = ['node_modules/typescript/lib', '.vscode/pnpify/typescript/lib', '.yarn/sdks/typescript/lib', '.pnpm/sdks/typescript/lib']
const REFUSAL = 'wt-tsls: no TypeScript LSP backend available. Install TypeScript 7 (native platform package) or typescript-language-server on PATH.'

function realHost() {
  return {
    platform: process.platform, arch: process.arch, env: process.env, execPath: process.execPath, home: homedir(), cwd: process.cwd(),
    isFile(file) { try { return statSync(file).isFile() } catch { return false } },
    exists(file) { try { statSync(file); return true } catch { return false } },
    readText(file) { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    realpath(file) { try { return realpathSync.native(file) } catch { return undefined } },
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

function workspaceVersion(params, host) {
  const path = pathFor(host)
  let root
  try { root = params.rootUri ? fileURLToPath(params.rootUri, { windows: host.platform === 'win32' }) : params.rootPath } catch { return false }
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
  return script && host.isFile(script) ? { status: 'launch', backend: 'typescript-language-server', command: host.execPath, args: [script, '--stdio'] } : undefined
}

function within(file, directory, host) {
  if (!directory) return false
  const path = pathFor(host)
  const relative = path.relative(host.realpath(directory) ?? directory, host.realpath(file) ?? file)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function nativeBackend(host, params) {
  const bin = onPath('tsc', host)
  if (!bin) return undefined
  const path = pathFor(host)
  const root = packageRoot(bin, 'typescript', host)
  if (!root) return undefined
  let workspace
  try { workspace = params.rootUri ? fileURLToPath(params.rootUri, { windows: host.platform === 'win32' }) : params.rootPath } catch { workspace = undefined }
  // A session opened AT the home directory must keep host installs under it (~/.nvs, ~/.local): there, only
  // `<home>/node_modules` counts as workspace. Any other root blocks everything beneath it.
  const scope = (root) => root && host.home && pathFor(host).resolve(root) === pathFor(host).resolve(host.home) ? pathFor(host).join(root, 'node_modules') : root
  const blocked = (file) => within(file, scope(workspace), host) || within(file, scope(host.cwd ?? process.cwd()), host)
  if (blocked(bin.candidate) || blocked(bin.real) || blocked(root)) return undefined
  const pkg = metadata(path.join(root, 'package.json'), host)
  if (pkg?.name !== 'typescript' || !/^([7-9]|[1-9]\d+)\./.test(pkg.version) || Object.keys(pkg.bin ?? {}).join() !== 'tsc') return undefined
  const nativeName = `typescript-${host.platform}-${host.arch}`
  const platformName = `@typescript/${nativeName}`
  // Mirror Node's package resolution from typescript/lib/getExePath.js through ancestor node_modules.
  const locations = []
  for (let directory = root;;) {
    locations.push(path.basename(directory) === 'node_modules' ? directory : path.join(directory, 'node_modules'))
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  for (const modules of locations) {
    const platformRoot = path.join(modules, platformName)
    const platformPkg = metadata(path.join(platformRoot, 'package.json'), host)
    const executable = path.join(platformRoot, 'lib', `tsc${host.platform === 'win32' ? '.exe' : ''}`)
    if (platformPkg?.version === pkg.version && host.isFile(executable) && !blocked(platformRoot) && !blocked(executable)) {
      return { status: 'launch', backend: 'typescript-go', command: executable, args: ['--lsp', '--stdio'] }
    }
  }
  return undefined
}

export function planTsLaunch(params, overrides = {}) {
  const host = { ...realHost(), ...overrides }
  const tls = tlsBackend(host)
  if (params.initializationOptions?.tsserver?.path) return tls ?? { status: 'refused', message: 'wt-tsls: explicit tsserver.path requires typescript-language-server on PATH; install it.' }
  if (tls && workspaceVersion(params, host)) return tls
  return nativeBackend(host, params) ?? tls ?? { status: 'refused', message: REFUSAL }
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
  if (request.method === 'initialize') return { status: 'initialize', id: request.id, params: request.params ?? {} }
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
    const replay = Buffer.concat([prior, buffered])
    if (result.status === 'refused') return refuse(result.message, replay, streams)
    const plan = select(result.params)
    if (plan.status !== 'launch') return refuse(plan.message, replay, streams)
    stderr.write(`wt-tsls: ${plan.backend} (${plan.command})\n`)
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
