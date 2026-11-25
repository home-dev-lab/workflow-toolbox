import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const SOURCE = new URL('../src/observe-cli.ts', import.meta.url)
const SUPPORT = process.env.WT_OBSERVE_SUBJECT_SUPPORT ?? new URL('../src/observe-server-bootstrap.ts', import.meta.url)
const NAMES = new Set(['spawnServer', 'openLogFileAt', 'readLogSliceFrom', 'logTail',
  'requireObserveRoot', 'spawnObserveChild', 'serverEnvironment', 'resolveTsxCli', 'runObserveServer'])

function functions(text) {
  const ast = ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true)
  return ast.statements.filter((node) => ts.isFunctionDeclaration(node) && NAMES.has(node.name?.text))
    .map((node) => node.getText(ast).replace(/^export /, '')).join('\n')
}

function executable(source, support = '') {
  const text = functions(source) + '\n' + functions(support)
  return ts.transpileModule(text.replaceAll('import.meta.url', "'file:///fixture/wt-observe.mjs'"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}

function tracked(events, label, value) {
  return new Proxy(value, { get(target, key) {
    events.push(['get', label, String(key)])
    return Reflect.get(target, key)
  } })
}

function filesystem(events, mode) {
  return {
    mkdirSync: (...args) => events.push(['mkdir', ...args]),
    existsSync: (path) => { events.push(['exists', path]); return mode !== 'absent-log' },
    statSync: (path) => {
      events.push(['stat', path])
      if (mode === 'stat-error') throw new Error('stat failed')
      return { size: ['rotate', 'rename-error'].includes(mode) ? 1000 : 8 }
    },
    renameSync: (...args) => {
      events.push(['rename', ...args])
      if (mode === 'rename-error') throw new Error('rename failed')
    },
    openSync: (...args) => {
      events.push(['open', ...args])
      if (mode === 'open-error') throw new Error('open failed')
      return 17
    },
    readFileSync: (path, encoding) => {
      events.push(['read', path, encoding ?? null])
      if (mode === 'read-error') throw new Error('read failed')
      const text = mode === 'empty-log' ? '' : 'old log\nnew log\n'
      return encoding ? text : Buffer.from(text)
    },
  }
}

function childProcess(events, mode) {
  const listeners = {}
  const child = {
    pid: mode === 'no-pid' ? undefined : 123,
    once: (event, callback) => { events.push(['once', event]); listeners[event] = callback },
    unref: () => {
      events.push(['unref'])
      if (mode === 'spawn-error') listeners.error(new Error('spawn failed'))
      if (mode === 'early-exit') listeners.exit(3, null)
      if (mode === 'signal-exit') listeners.exit(null, 'SIGTERM')
    },
  }
  return { spawn: (...args) => {
    events.push(['spawn', ...args])
    if (mode === 'spawn-throw') throw new Error('spawn threw')
    return child
  } }
}

function processMock(events, mode) {
  return {
    execPath: '/node', cwd: () => { events.push(['cwd']); return '/cwd' },
    env: tracked(events, 'env', mode === 'explicit-plugin' ? { OBSERVE_LAUNCH_PLUGIN_DIRS: '/explicit' } : {}),
    kill: (...args) => {
      events.push(['kill', ...args])
      if (mode === 'kill-error') throw new Error('already gone')
    },
  }
}

function helpers(events, mode) {
  return {
    findObserveRoot: (...args) => {
      events.push(['findRoot', ...args])
      return mode === 'missing-root' ? null : '/base'
    },
    observeServerLogPath: (root) => { events.push(['logPath', root]); return '/log' },
    randomBytes: (size) => { events.push(['random', size]); return Buffer.from('token') },
    resolveLaunchAgentsDir: () => { events.push(['agents']); return mode === 'missing-agents' ? null : '/agents' },
    createRequire: (path) => ({ resolve: (name) => {
      events.push(['require', path, name])
      if (mode === 'missing-tsx') throw new Error('not installed')
      return '/tsx.mjs'
    } }),
    probeHealth: (port) => { events.push(['probe', port]); return { configDir: '/source' } },
  }
}

async function ready(events, mode, deps) {
  events.push(['ready', deps.requestedPort, deps.timeoutMs, deps.readLogSlice(), deps.logTail()])
  events.push(['state', deps.spawnState()])
  events.push(['isReady', deps.isReady({ configDir: '/source' }), deps.isReady({ sources: [] }), deps.isReady({})])
  const health = deps.probe(1234)
  if (mode.startsWith('kill') || mode === 'no-pid') deps.kill()
  if (mode === 'ready-error') throw new Error('readiness failed')
  return health
}

async function execute(code, mode, enabled) {
  const events = []
  const context = {
    ...filesystem(events, mode), ...childProcess(events, mode), ...helpers(events, mode),
    process: processMock(events, mode), dirname, join, delimiter, fileURLToPath,
    LOG_ROTATE_BYTES: 100, Buffer, setTimeout, Date,
    awaitSpawnedServerReady: (deps) => ready(events, mode, deps),
  }
  const flags = tracked(events, 'flags', { watch: enabled, enableLaunch: enabled, noResume: enabled, healthTimeoutMs: 42 })
  const remotes = tracked(events, 'remotes', enabled ? [{ url: 'https://example.test' }] : [])
  const spawnServer = runInNewContext(code + '\nspawnServer', context)
  try {
    const result = await spawnServer('/state', 0, ['/source', '/other'], remotes, flags)
    return JSON.stringify({ result, events })
  } catch (error) {
    return JSON.stringify({ error: { name: error.name, message: error.message }, events })
  }
}

async function compareSpawn() {
  const source = readFileSync(SOURCE, 'utf8')
  const support = readFileSync(SUPPORT, 'utf8')
  const reference = process.env.WT_OBSERVE_REFERENCE_SOURCE
  const before = reference ? executable(readFileSync(reference, 'utf8')) : executable(source, support)
  const after = executable(source, support)
  const modes = ['normal', 'missing-root', 'missing-tsx', 'missing-agents', 'explicit-plugin',
    'stat-error', 'read-error', 'absent-log', 'empty-log', 'rotate', 'rename-error',
    'spawn-error', 'spawn-throw', 'open-error', 'early-exit', 'signal-exit', 'kill', 'kill-error', 'no-pid', 'ready-error']
  for (const mode of modes) {
    for (const enabled of [false, true]) {
      assert.equal(await execute(after, mode, enabled), await execute(before, mode, enabled),
        `spawnServer differential: ${mode}, flags=${enabled}`)
    }
  }
  return modes.length * 2
}

// Independent original bootstrap oracle: argv mutation and title happen before import.
function bootstrapOracle(process, loadEntry) {
  const entry = resolve(process.argv[3])
  process.argv.splice(1, 2)
  process.argv[1] = entry
  try { process.title = 'wt-observe-srv' } catch { /* Unsupported title setter. */ }
  return loadEntry(pathToFileURL(entry).href)
}

async function bootstrapResult(invoke, args, mode) {
  const events = []
  const process = { argv: ['node', '/cli', '--internal-serve', ...args] }
  Object.defineProperty(process, 'title', { set(value) {
    events.push(['title', value])
    if (mode === 'title-error') throw new Error('unsupported')
  } })
  const loadEntry = async (url) => {
    events.push(['import', url, [...process.argv]])
    if (mode === 'import-error') throw new Error('entry failed')
  }
  try { await invoke(process, loadEntry); return { events } } catch (error) {
    return { events, error: { name: error.name, message: error.message } }
  }
}

async function compareBootstrap() {
  const code = executable('', readFileSync(SUPPORT, 'utf8')).replace('await import(', 'await loadEntry(')
  let count = 0
  for (const args of [['/entry.mjs'], ['./path with spaces/entry.ts', '--watch']]) {
    for (const mode of ['normal', 'title-error', 'import-error']) {
      const invoke = (process, loadEntry) => runInNewContext(code + '\nrunObserveServer()', {
        process, loadEntry, resolvePath: resolve, pathToFileURL,
      })
      assert.deepEqual(await bootstrapResult(invoke, args, mode), await bootstrapResult(bootstrapOracle, args, mode))
      count++
    }
  }
  return count
}

console.log(`spawn differential: ${await compareSpawn()} cases passed`)
console.log(`bootstrap differential: ${await compareBootstrap()} cases passed`)
