import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

// Eclipse JDT LS refuses a JVM older than 21 (its launcher `jdtls.py`, get_java_executable:
// `raise Exception("jdtls requires at least Java 21")`) and takes that JVM from JAVA_HOME, else `java` on PATH.
// A session that inherits an older JAVA_HOME therefore crash-loops the language server. When the `jdtls` on PATH
// is that upstream launcher, this module chooses a JVM of at least 21 WITHOUT touching JAVA_HOME (the project's
// own builds keep their JDK) and hands it over through jdtls's own `--java-executable` option. Any other `jdtls`
// (a Homebrew, Scoop or private wrapper) owns its own JVM choice and runs unchanged.
const MINIMUM_MAJOR = 21
const VERSION_PROBE_TIMEOUT_MS = 10_000

// Every host read goes through these seams so resolution can be exercised for any platform from any platform.
function realSeams() {
  return {
    platform: process.platform,
    env: process.env,
    homeDirectory: homedir(),
    readText(file) {
      try { return readFileSync(file, 'utf8') } catch { return undefined }
    },
    isFile(file) {
      try { return statSync(file).isFile() } catch { return false }
    },
    listDirectory(directory) {
      try { return readdirSync(directory) } catch { return [] }
    },
    realpath(file) {
      try { return realpathSync.native(file) } catch { return undefined }
    },
    run(command, args) {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true })
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
  }
}

const pathApi = (platform) => (platform === 'win32' ? win32 : posix)
const javaName = (platform) => (platform === 'win32' ? 'java.exe' : 'java')

function pathEntries({ platform, env }) {
  const value = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '')
  return value.split(pathApi(platform).delimiter).filter(Boolean)
}

function findOnPath(name, host) {
  const path = pathApi(host.platform)
  for (const directory of pathEntries(host)) {
    const candidate = path.join(directory, name)
    if (host.isFile(candidate)) return candidate
  }
  return undefined
}

// "1.8.0_462" is Java 8; "21.0.9", "25" and "22-ea" are their leading number.
function majorOf(version) {
  const match = /^(\d+)(?:\.(\d+))?/.exec(version)
  if (!match) return null
  return match[1] === '1' && match[2] ? Number(match[2]) : Number(match[1])
}

const versionParts = (version) => (version.match(/\d+/g) ?? []).map(Number)

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

function releaseVersion(home, host) {
  const release = host.readText(pathApi(host.platform).join(home, 'release'))
  return (release && /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1]) || null
}

function reportedVersion(executable, host) {
  const result = host.run(executable, ['-version'])
  return /version "([^"]+)"/.exec(`${result.stderr}\n${result.stdout}`)?.[1] ?? null
}

// The JDK's `release` file is read first (no JVM start); `java -version` is the fallback.
function describeHome(home, source, host) {
  const executable = pathApi(host.platform).join(home, 'bin', javaName(host.platform))
  if (!host.isFile(executable)) return null
  const version = releaseVersion(home, host) ?? reportedVersion(executable, host)
  return version ? { executable, version, major: majorOf(version), source } : null
}

const hasJava = (home, host) => host.isFile(pathApi(host.platform).join(home, 'bin', javaName(host.platform)))

// A directory is either a JDK home itself or a folder of them; on macOS a bundle's home is `<bundle>/Contents/Home`.
function homesIn(directory, source, host) {
  const path = pathApi(host.platform)
  const shapes = (entry) => (host.platform === 'darwin' ? [entry, path.join(entry, 'Contents', 'Home')] : [entry])
  const direct = shapes(directory).filter((home) => hasJava(home, host))
  if (direct.length > 0) return direct.map((home) => ({ home, source }))
  return host.listDirectory(directory)
    .filter((name) => name !== 'current')
    .flatMap((name) => shapes(path.join(directory, name)))
    .filter((home) => hasJava(home, host))
    .map((home) => ({ home, source }))
}

// WT_JDTLS_JDK_DIRS first, then the built-in install locations of the platform. Every candidate is considered.
function discoveredHomes(host) {
  const { platform, env, homeDirectory } = host
  const path = pathApi(platform)
  const homes = (env.WT_JDTLS_JDK_DIRS ?? '').split(path.delimiter).filter(Boolean).flatMap((directory) => homesIn(directory, 'WT_JDTLS_JDK_DIRS', host))
  if (platform !== 'win32') homes.push(...homesIn(path.join(env.SDKMAN_DIR || path.join(homeDirectory, '.sdkman'), 'candidates', 'java'), 'SDKMAN', host))
  if (platform === 'darwin') {
    const answer = host.run('/usr/libexec/java_home', ['-v', `${MINIMUM_MAJOR}+`])
    if (answer.status === 0 && answer.stdout.trim()) homes.push({ home: answer.stdout.trim().split(/\r?\n/)[0], source: '/usr/libexec/java_home' })
    homes.push(...homesIn('/Library/Java/JavaVirtualMachines', '/Library/Java/JavaVirtualMachines', host))
    homes.push(...homesIn(path.join(homeDirectory, 'Library', 'Java', 'JavaVirtualMachines'), '~/Library/Java/JavaVirtualMachines', host))
  } else if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
        homes.push(...homesIn(path.join(root, vendor), 'Program Files', host))
      }
    }
  } else {
    homes.push(...homesIn('/usr/lib/jvm', '/usr/lib/jvm', host))
  }
  homes.push(...homesIn(path.join(homeDirectory, '.jdks'), '~/.jdks', host))
  return homes
}

function searchedLabel(host) {
  const builtIn = { darwin: 'SDKMAN, /usr/libexec/java_home, /Library/Java/JavaVirtualMachines, ~/.jdks', win32: 'Program Files, ~/.jdks' }[host.platform] ?? 'SDKMAN, /usr/lib/jvm, ~/.jdks'
  return host.env.WT_JDTLS_JDK_DIRS ? `WT_JDTLS_JDK_DIRS=${host.env.WT_JDTLS_JDK_DIRS}, ${builtIn}` : builtIn
}

function describeJavaHome(value, java) {
  if (!value) return 'JAVA_HOME is unset'
  const runtime = java?.major ? `Java ${java.major}` : 'not a readable JDK'
  return `JAVA_HOME=${value} is ${runtime}`
}

const describePathJava = (java) => (java?.major ? `\`java\` on PATH is Java ${java.major}` : 'no `java` on PATH')

// The `java` first on PATH, read through its real path's home `release` file when there is one. Skipped when it is
// the JAVA_HOME java, already read.
function pathJava(host, javaHome) {
  const onPath = findOnPath(javaName(host.platform), host)
  if (!onPath) return null
  const real = host.realpath(onPath) ?? onPath
  if (javaHome && (host.realpath(javaHome.executable) ?? javaHome.executable) === real) return { ...javaHome, sameAsJavaHome: true }
  const path = pathApi(host.platform)
  const version = releaseVersion(path.dirname(path.dirname(real)), host) ?? reportedVersion(onPath, host)
  return version ? { executable: onPath, version, major: majorOf(version), source: 'PATH' } : null
}

function resolveJava(host) {
  const qualifies = (java) => java !== null && java.major !== null && java.major >= MINIMUM_MAJOR
  // The pick is started once before it is handed over: a symlink to another JDK, the wrong architecture or a
  // missing execute bit would otherwise make jdtls exit 1. A pick that does not run falls through to the next one.
  const runs = (java) => host.run(java.executable, ['-version']).status === 0
  const javaHome = host.env.JAVA_HOME ? describeHome(host.env.JAVA_HOME, 'JAVA_HOME', host) : null
  if (qualifies(javaHome) && runs(javaHome)) return { java: javaHome }

  const onPath = pathJava(host, javaHome)
  if (!onPath?.sameAsJavaHome && qualifies(onPath) && runs(onPath)) return { java: onPath }

  const installed = discoveredHomes(host)
    .map(({ home, source }) => describeHome(home, source, host))
    .filter(qualifies)
    .sort((left, right) => left.major - right.major || compareVersions(right.version, left.version))
  const chosen = installed.find(runs)
  if (chosen) return { java: chosen }

  const found = [describeJavaHome(host.env.JAVA_HOME, javaHome), describePathJava(onPath)].join(', ')
  return {
    message: `wt-jdtls: Eclipse JDT LS needs Java ${MINIMUM_MAJOR} or newer to run, and none was found (${found}; searched ${searchedLabel(host)}). `
      + `Install a JDK ${MINIMUM_MAJOR}+, or set WT_JDTLS_JDK_DIRS to that JDK home; the project's own JAVA_HOME can stay as it is.`,
  }
}

// The first `jdtls` on PATH. It is the upstream launcher when `jdtls.py` sits beside its real path; anything else
// is a wrapper. On Windows an extensionless wrapper cannot run, so the PATHEXT forms are looked for instead.
function findJdtls(host) {
  const path = pathApi(host.platform)
  for (const directory of pathEntries(host)) {
    const bare = path.join(directory, 'jdtls')
    if (host.isFile(bare)) {
      const real = host.realpath(bare) ?? bare
      if (host.isFile(path.join(path.dirname(real), 'jdtls.py'))) return { kind: 'upstream', script: bare }
      if (host.platform !== 'win32') return { kind: 'wrapper', path: bare }
    }
    if (host.platform === 'win32') {
      for (const extension of ['.exe', '.cmd', '.bat']) {
        const candidate = path.join(directory, `jdtls${extension}`)
        if (host.isFile(candidate)) return { kind: 'wrapper', path: candidate, extension }
      }
    }
  }
  return null
}

// The interpreter that runs the upstream launcher, resolved to an ABSOLUTE path: a bare name would let Windows run
// a `python.exe` from the working directory (the repository) before PATH. The WindowsApps Store alias is refused.
function findPython(host) {
  if (host.platform !== 'win32') return { path: findOnPath('python3', host) }
  let aliasSeen = false
  for (const directory of pathEntries(host)) {
    const candidate = win32.join(directory, 'python.exe')
    if (!host.isFile(candidate)) continue
    if (/\\windowsapps\\/i.test(`${candidate}`)) { aliasSeen = true; continue }
    return { path: candidate }
  }
  return { path: undefined, aliasSeen }
}

function wrapperLaunch(jdtls, argv, host) {
  if (jdtls.extension === '.cmd' || jdtls.extension === '.bat') {
    const line = [jdtls.path, ...argv].map((part) => `"${part}"`).join(' ')
    return { status: 'launch', command: host.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], java: null, windowsVerbatimArguments: true }
  }
  return { status: 'launch', command: jdtls.path, args: argv, java: null }
}

const USAGE = [
  'Usage: node wt-jdtls.mjs [jdtls options]',
  '',
  'Starts Eclipse JDT LS (`jdtls` on PATH). When that `jdtls` is the upstream launcher (jdtls.py beside it), it runs',
  'it with python3 on a Java 21+ JVM passed through jdtls\'s own --java-executable, leaving JAVA_HOME unchanged; any',
  'other `jdtls` (a packaged wrapper) runs unchanged. The Java pack\'s .lsp.json runs it; its stdout is the',
  'language-server protocol.',
  '',
  'JVM choice: JAVA_HOME if it is 21+, else `java` on PATH if 21+, else the lowest installed major >= 21 in',
  'WT_JDTLS_JDK_DIRS, SDKMAN, /usr/lib/jvm, /usr/libexec/java_home, /Library/Java/JavaVirtualMachines, Program Files',
  'or ~/.jdks. Versions are read from each JDK\'s release file where it has one; the pick is run once with -version.',
  'With none, it starts no language server and answers the client with one line naming the requirement.',
  '',
  'Options passed to jdtls: -data <dir>, --jvm-arg=<option>, --java-executable <path> (skips the JVM choice),',
  '  --validate-java-version, --no-validate-java-version; -configuration <dir> (passed on to Equinox)',
  'Environment: WT_JDTLS_JDK_DIRS=<dir>[<path delimiter><dir>...], JDK homes or folders of them, searched first.',
].join('\n')

const VALUE_OPTIONS = new Set(['-data', '-configuration', '--java-executable'])
const FLAG_OPTIONS = new Set(['--validate-java-version', '--no-validate-java-version'])

function unknownArgument(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (VALUE_OPTIONS.has(arg)) index += 1
    else if (!FLAG_OPTIONS.has(arg) && !arg.startsWith('--jvm-arg=') && !arg.startsWith('--java-executable=')) return arg
  }
  return undefined
}

// `overrides` replaces any subset of the host seams (a probe passes only `env`; tests pass a whole fake host).
export function planJdtlsLaunch(argv, overrides = {}) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { status: 'help', text: USAGE }
  const unknown = unknownArgument(argv)
  if (unknown !== undefined) {
    return { status: 'usage-error', message: `wt-jdtls: unknown argument ${unknown}; run \`node wt-jdtls.mjs --help\` for the options it passes to jdtls.` }
  }
  const host = { ...realSeams(), ...overrides }
  const jdtls = findJdtls(host)
  if (!jdtls) {
    return { status: 'refused', message: 'wt-jdtls: Eclipse JDT LS (`jdtls`) was not found on PATH; install it and put its bin directory on the PATH Claude Code starts with.' }
  }
  if (jdtls.kind === 'wrapper') return wrapperLaunch(jdtls, argv, host)

  const python = findPython(host)
  if (!python.path) {
    const name = host.platform === 'win32' ? 'python.exe' : 'python3'
    const alias = python.aliasSeen ? ' (only the Microsoft Store alias under WindowsApps, which does not run Python)' : ''
    return { status: 'refused', message: `wt-jdtls: the Eclipse JDT LS launcher ${jdtls.script} is a Python script and no \`${name}\` was found on PATH${alias}; install Python 3 and put it on the PATH Claude Code starts with.` }
  }
  const supplied = argv.findIndex((arg) => arg === '--java-executable' || arg.startsWith('--java-executable='))
  if (supplied !== -1) {
    const executable = argv[supplied].includes('=') ? argv[supplied].slice(argv[supplied].indexOf('=') + 1) : argv[supplied + 1]
    return { status: 'launch', command: python.path, args: [jdtls.script, ...argv], java: { executable, major: null, source: 'caller' } }
  }
  const resolved = resolveJava(host)
  if (!resolved.java) return { status: 'refused', message: resolved.message }
  const { executable, major, source } = resolved.java
  return { status: 'launch', command: python.path, args: [jdtls.script, '--java-executable', executable, ...argv], java: { executable, major, source } }
}

// A refusal is written as ONE stderr line (Claude Code's debug log records it) AND returned to the client as the
// error of its `initialize` request with `retry: false`, so the reason reaches whatever asked for the server instead
// of a bare "crashed with exit code 1". `shutdown` gets its null result; any other request is refused with
// ServerNotInitialized. The process exits with `code` on `exit`, on end of input, or after `lingerMs` at most.
const REFUSAL_LINGER_MS = 30_000

function refuseOverProtocol(message, code, { exit, stderr, input, output, lingerMs }) {
  let done = false
  let timer
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    // Exit only once the reply is flushed: stdout and stderr are asynchronous pipes on Windows.
    output.write('', () => exit(code))
  }
  stderr.write(`${message}\n`)
  const send = (reply) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...reply })
    output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  const answer = (request) => {
    if (request.method === 'exit') return finish()
    if (request.id === undefined || request.id === null) return undefined
    if (request.method === 'initialize') return send({ id: request.id, error: { code: -32603, message, data: { retry: false } } })
    if (request.method === 'shutdown') return send({ id: request.id, result: null })
    return send({ id: request.id, error: { code: -32002, message } })
  }
  let buffer = Buffer.alloc(0)
  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('latin1'))?.[1])
      if (!Number.isFinite(length)) {
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }
      if (buffer.length < headerEnd + 4 + length) return
      let request
      try { request = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')) } catch { request = {} }
      buffer = buffer.subarray(headerEnd + 4 + length)
      answer(request)
    }
  })
  input.on('end', finish)
  input.on('error', finish)
  timer = setTimeout(finish, lingerMs)
}

// Runs the plan with stdio inherited, so the language-server protocol flows straight through; forwards the
// termination signals Claude Code sends, and exits with the server's own code. Every refusal, including a command
// that cannot be started, goes through refuseOverProtocol: stdin was never handed to a child, so it is still ours.
export function runJdtlsLaunch(plan, options = {}) {
  const { exit = (code) => process.exit(code), stderr = process.stderr, input = process.stdin, output = process.stdout, lingerMs = REFUSAL_LINGER_MS } = options
  const streams = { exit, stderr, input, output, lingerMs }
  if (plan.status === 'help') {
    output.write(`${plan.text}\n`, () => exit(0))
    return
  }
  if (plan.status === 'usage-error') return refuseOverProtocol(plan.message, 2, streams)
  if (plan.status !== 'launch') return refuseOverProtocol(plan.message, 1, streams)
  const child = spawn(plan.command, plan.args, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments === true })
  let started = false
  child.once('spawn', () => {
    started = true
    const forward = (signal) => { if (child.exitCode === null) child.kill(signal) }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => forward(signal))
  })
  child.on('error', (error) => {
    if (!started) return refuseOverProtocol(`wt-jdtls: could not start ${plan.command}: ${error.message}`, 1, streams)
    stderr.write(`wt-jdtls: ${plan.command}: ${error.message}\n`)
    return exit(1)
  })
  child.on('exit', (code, signal) => { if (started) exit(code ?? (signal ? 1 : 0)) })
}
