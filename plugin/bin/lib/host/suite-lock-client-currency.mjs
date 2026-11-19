import { readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { effectiveAdoptedPluginEntry } from './adopted-script-shim.mjs'

const DIRECT_ENTRIES = new Set(['wt-suite-lock.mjs', 'wt-suite-lock-run.mjs'])
const HOST_IO = { readFileSync, realpathSync, statSync, spawnSync,
  warn: (line) => process.stderr.write(`${line}\n`) }
const PROBE_TIMEOUT_MS = 5000
const MAX_CLOSURE_FILES = 400
const CURRENCY_CACHE_TTL_MS = 60_000
const currencyNow = () => performance.now()
const CURRENCY_CACHES = new WeakMap()

export function suiteLockCacheIdentity(moduleUrl, platform = process.platform, paths = path) {
  const file = fileURLToPath(moduleUrl, { windows: platform === 'win32' })
  const root = paths.dirname(paths.dirname(paths.dirname(file)))
  const parts = root.split(/[\\/]/).slice(-5)
  if (parts[0] !== 'plugins' || parts[1] !== 'cache' || parts[3] !== 'workflow-toolbox' || !parts[4]) return null
  let config = root
  for (let depth = 0; depth < 5; depth++) config = paths.dirname(config)
  return { root, config, key: `${parts[3]}@${parts[2]}`, version: parts[4] }
}

function canonical(value, io, paths, platform) {
  if (typeof value !== 'string' || !paths.isAbsolute(value)) throw new Error('install path is not absolute')
  const real = io.realpathSync(value)
  return platform === 'win32' ? real.toLowerCase() : real
}

function directEntry(argv, own, io, paths, platform) {
  if (!argv[1] || !DIRECT_ENTRIES.has(paths.basename(argv[1]))) return null
  const expected = paths.join(own.root, 'bin', paths.basename(argv[1]))
  return canonical(argv[1], io, paths, platform) === canonical(expected, io, paths, platform) ? paths.basename(argv[1]) : null
}

export function suiteLockReplacementCommand(entry, args, platform = process.platform,
  { execPath = process.execPath, execArgv = process.execArgv } = {}) {
  const words = [execPath, ...execArgv, entry, ...args]
  if (platform === 'win32') {
    if (words.some((word) => /[%!^"\r\n]/.test(word))) throw new Error('replacement command is not shell-safe for cmd.exe')
    return `cmd.exe: ${words.map(quoteWindowsWord).join(' ')}`
  }
  return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ')
}

function quoteWindowsWord(word) {
  return `"${word.replace(/(^|[^\\])(\\+)$/, '$1$2$2')}"`
}

function requireFile(file, io) {
  if (!io.statSync(file).isFile()) throw new Error(`replacement is not a regular file: ${file}`)
}

function relativeSuiteLockImports(source) {
  // Literal imports only; ambiguous syntax is also checked by the Node loadability probe.
  const pattern = /\b(?:from\s*|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"]+)['"]/g
  return [...source.matchAll(pattern)].map((match) => match[1])
}

function requireImportClosure(entries, io, paths) {
  const visited = new Set(), pending = [...entries]
  while (pending.length) {
    const file = paths.resolve(pending.pop())
    if (visited.has(file)) continue
    visited.add(file)
    if (visited.size > MAX_CLOSURE_FILES) throw new Error('replacement import closure exceeds 400 files')
    requireFile(file, io)
    const source = io.readFileSync(file, 'utf8')
    for (const specifier of relativeSuiteLockImports(source)) pending.push(paths.resolve(paths.dirname(file), specifier))
  }
}

function probeReplacement(root, entry, io, paths, runtime) {
  const cli = pathToFileURL(paths.join(root, 'bin/wt-suite-lock.mjs')).href
  const order = pathToFileURL(paths.join(root, 'bin/lib/suite-lock-order.mjs')).href
  const script = `const cli = await import(${JSON.stringify(cli)}); const order = await import(${JSON.stringify(order)}); if (typeof cli.runSuiteLockCliEntrypoint !== 'function' || !Number.isInteger(order.SUITE_LOCK_ORDER_VERSION)) process.exit(1); process.stdout.write(JSON.stringify(order.SUITE_LOCK_ORDER_VERSION));`
  const result = io.spawnSync(runtime.execPath, [...runtime.execArgv, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true })
  if (result.error || result.signal || result.status !== 0) throw new Error('replacement CLI/order module is not loadable (5 s probe)')
  const version = JSON.parse(result.stdout)
  if (!Number.isInteger(version)) throw new Error('replacement order version is unknown')
  if (entry === 'wt-suite-lock-run.mjs') {
    const check = io.spawnSync(runtime.execPath, [...runtime.execArgv, '--check', paths.join(root, 'bin', entry)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true })
    if (check.error || check.signal || check.status !== 0) throw new Error('replacement runner failed node --check (5 s probe)')
  }
  return version
}

function completeReplacement(install, entry, io, paths, runtime) {
  const root = install.installPath
  const manifest = JSON.parse(io.readFileSync(paths.join(root, '.claude-plugin/plugin.json'), 'utf8'))
  if (manifest.name !== 'workflow-toolbox' || typeof install.version !== 'string' || manifest.version !== install.version) throw new Error('replacement manifest name/version does not match the registry')
  const entries = ['bin/wt-suite-lock.mjs', 'bin/lib/suite-lock.mjs', 'bin/lib/suite-lock-order.mjs'].map((file) => paths.join(root, file))
  if (entry) entries.push(paths.join(root, 'bin', entry))
  requireImportClosure(entries, io, paths)
  return probeReplacement(root, entry, io, paths, runtime)
}

function currencyFileIdentity(file, io) {
  try {
    const stat = io.statSync(file)
    return JSON.stringify([stat.mtimeMs, stat.size, stat.ino])
  } catch { return 'unavailable' }
}

function currencyCache(io) {
  if (!CURRENCY_CACHES.has(io)) CURRENCY_CACHES.set(io, { registries: new Map(), verdicts: new Map() })
  return CURRENCY_CACHES.get(io)
}

function currencyRegistry(file, io, cache) {
  const identity = currencyFileIdentity(file, io)
  const previous = cache.registries.get(file)
  if (previous?.identity === identity) return previous
  let parsed = null
  try { parsed = JSON.parse(io.readFileSync(file, 'utf8')) } catch { /* unknown registry fails open */ }
  const current = { identity, parsed }
  cache.registries.set(file, current)
  return current
}

function currencyVerdict(options, io, paths, own, install) {
  const { argv, platform } = options
  if (canonical(install.installPath, io, paths, platform) === canonical(own.root, io, paths, platform)) return null
  const entry = directEntry(argv, own, io, paths, platform)
  const orderVersion = completeReplacement(install, entry, io, paths, options)
  const ownVersion = Number.isInteger(options.ownOrderVersion) ? options.ownOrderVersion : 0
  if (orderVersion <= ownVersion) return null
  return { installPath: install.installPath, version: install.version, orderVersion, entry,
    reason: `client ${own.version} (order ${ownVersion}); enabled ${install.version} (order ${orderVersion}) at ${install.installPath}` }
}

function warnCurrencyUnknown(io, error) {
  try { io.warn(`wt-suite-lock: client currency unknown; continuing admission: ${error.message}`.replace(/[\r\n]/g, ' ')) } catch { /* diagnostics cannot refuse admission */ }
}

function currencyEvidenceIdentity(options, io, paths, own, install, registry) {
  const files = ['.claude-plugin/plugin.json', 'bin/wt-suite-lock.mjs',
    'bin/lib/suite-lock-order.mjs', 'bin/lib/suite-lock.mjs'].map((file) => paths.join(install.installPath, file))
  files.push(paths.join(own.root, 'bin/lib/suite-lock-order.mjs'))
  const entry = paths.basename(options.argv[1] ?? '')
  if (DIRECT_ENTRIES.has(entry)) {
    files.push(paths.join(install.installPath, 'bin', entry), paths.join(own.root, 'bin', entry))
  }
  return JSON.stringify([registry.identity, ...files.map((file) => currencyFileIdentity(file, io))])
}

function checkCurrency(options, io, paths, own) {
  const cache = currencyCache(io)
  const registry = currencyRegistry(paths.join(own.config, 'plugins/installed_plugins.json'), io, cache)
  const install = effectiveAdoptedPluginEntry(registry.parsed?.plugins ?? registry.parsed, options.cwd, own.key)
  if (!install) return null
  const key = JSON.stringify([own.root, options.ownOrderVersion, options.cwd, install.installPath, install.version,
    options.argv[1], options.platform, options.execPath, options.execArgv])
  const identity = currencyEvidenceIdentity(options, io, paths, own, install, registry)
  const now = (options.now ?? currencyNow)()
  const previous = cache.verdicts.get(key)
  if (previous?.identity === identity && now < previous.expiresAt) return previous.verdict
  let verdict = null
  try { verdict = currencyVerdict(options, io, paths, own, install) } catch (error) { warnCurrencyUnknown(io, error) }
  cache.verdicts.set(key, { identity, verdict, expiresAt: now + CURRENCY_CACHE_TTL_MS })
  return verdict
}

function replacementForVerdict(verdict, options, paths) {
  if (!verdict.entry) return null
  try {
    return suiteLockReplacementCommand(paths.join(verdict.installPath, 'bin', verdict.entry), options.argv.slice(2), options.platform, options)
  } catch { return null } // Proven staleness still refuses when only recovery rendering is unknown.
}

/** Positive evidence only. Filesystem, registry and probe unknowns fail open. */
export function staleSuiteLockClient(options) {
  const { io = HOST_IO } = options
  try {
    const context = currencyContext(options)
    const { moduleUrl, platform, paths } = context
    const own = suiteLockCacheIdentity(moduleUrl, platform, paths)
    if (!own) return null
    const verdict = checkCurrency(context, io, paths, own)
    return verdict ? { ...verdict, command: replacementForVerdict(verdict, context, paths) } : null
  } catch (error) {
    warnCurrencyUnknown(io, error)
    return null
  }
}

function currencyContext({ moduleUrl, ownOrderVersion, argv = process.argv, platform = process.platform,
  paths = platform === 'win32' ? path.win32 : path, env = process.env, cwd,
  execPath = process.execPath, execArgv = process.execArgv, now }) {
  return { moduleUrl, ownOrderVersion, argv, platform, paths, cwd: cwd ?? (env.CLAUDE_PROJECT_DIR || process.cwd()), execPath, execArgv, now }
}

export function assertCurrentSuiteLockClient(moduleUrl, ownOrderVersion, env, options) {
  if (options.staticDomain) return
  const stale = staleSuiteLockClient({ moduleUrl, ownOrderVersion, env, cwd: options.selectionCwd ?? options.cwd })
  if (!stale) return
  const recovery = stale.command ? `\nReplacement command: ${stale.command}` : `; restart this process from ${stale.installPath}`
  const error = new Error(`REFUSED stale-client: ${stale.reason}${recovery}`)
  error.code = 'WT_SUITE_LOCK_STALE_CLIENT'
  error.exitCode = 78
  throw error
}
