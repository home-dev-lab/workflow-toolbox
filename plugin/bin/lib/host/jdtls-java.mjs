import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

// Eclipse JDT LS refuses a JVM older than 21 (its launcher `jdtls.py`, get_java_executable:
// `raise Exception("jdtls requires at least Java 21")`) and takes that JVM from JAVA_HOME, else `java` on PATH.
// A session that inherits an older JAVA_HOME therefore crash-loops the language server. This module chooses a
// JVM of at least 21 WITHOUT touching JAVA_HOME (the project's own builds keep their JDK) and hands it to jdtls
// through jdtls's own `--java-executable` option.
const MINIMUM_MAJOR = 21

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
    run(command, args) {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true })
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

// "1.8.0_462" is Java 8; "21.0.9", "25" and "21-ea" are their leading number.
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

// The JDK's `release` file is read first (no JVM start); `java -version` is the fallback.
function javaVersion(executable, home, host) {
  if (home) {
    const release = host.readText(pathApi(host.platform).join(home, 'release'))
    const declared = release && /^JAVA_VERSION="([^"]+)"/m.exec(release)
    if (declared) return declared[1]
  }
  const result = host.run(executable, ['-version'])
  const reported = /version "([^"]+)"/.exec(`${result.stderr}\n${result.stdout}`)
  return reported ? reported[1] : null
}

function describeHome(home, source, host) {
  const executable = pathApi(host.platform).join(home, 'bin', javaName(host.platform))
  if (!host.isFile(executable)) return null
  const version = javaVersion(executable, home, host)
  return version ? { executable, version, major: majorOf(version), source } : null
}

function childHomes(directory, source, host, suffix = []) {
  const path = pathApi(host.platform)
  return host.listDirectory(directory)
    .filter((name) => name !== 'current')
    .map((name) => ({ home: path.join(directory, name, ...suffix), source }))
}

// The built-in install locations, per platform. WT_JDTLS_JDK_DIRS replaces them all with the listed directories.
function discoveredHomes(host) {
  const { platform, env, homeDirectory } = host
  const path = pathApi(platform)
  if (env.WT_JDTLS_JDK_DIRS) {
    return env.WT_JDTLS_JDK_DIRS.split(path.delimiter).filter(Boolean).flatMap((directory) => childHomes(directory, 'WT_JDTLS_JDK_DIRS', host))
  }
  const homes = []
  if (platform !== 'win32') homes.push(...childHomes(path.join(env.SDKMAN_DIR || path.join(homeDirectory, '.sdkman'), 'candidates', 'java'), 'SDKMAN', host))
  if (platform === 'darwin') {
    const answer = host.run('/usr/libexec/java_home', ['-v', `${MINIMUM_MAJOR}+`])
    if (answer.status === 0 && answer.stdout.trim()) homes.push({ home: answer.stdout.trim().split(/\r?\n/)[0], source: '/usr/libexec/java_home' })
    homes.push(...childHomes('/Library/Java/JavaVirtualMachines', '/Library/Java/JavaVirtualMachines', host, ['Contents', 'Home']))
    homes.push(...childHomes(path.join(homeDirectory, 'Library', 'Java', 'JavaVirtualMachines'), '~/Library/Java/JavaVirtualMachines', host, ['Contents', 'Home']))
  } else if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
        homes.push(...childHomes(path.join(root, vendor), 'Program Files', host))
      }
    }
  } else {
    homes.push(...childHomes('/usr/lib/jvm', '/usr/lib/jvm', host))
  }
  homes.push(...childHomes(path.join(homeDirectory, '.jdks'), '~/.jdks', host))
  return homes
}

const searchedLabel = (host) => (host.env.WT_JDTLS_JDK_DIRS
  ? `WT_JDTLS_JDK_DIRS=${host.env.WT_JDTLS_JDK_DIRS}`
  : { darwin: 'SDKMAN, /usr/libexec/java_home, /Library/Java/JavaVirtualMachines, ~/.jdks', win32: 'Program Files, ~/.jdks' }[host.platform] ?? 'SDKMAN, /usr/lib/jvm, ~/.jdks')

function describeJavaHome(value, java) {
  if (!value) return 'JAVA_HOME is unset'
  const runtime = java?.major ? `Java ${java.major}` : 'not a readable JDK'
  return `JAVA_HOME=${value} is ${runtime}`
}

const describePathJava = (java) => (java?.major ? `\`java\` on PATH is Java ${java.major}` : 'no `java` on PATH')

function resolveJava(host) {
  const qualifies = (java) => java !== null && java.major !== null && java.major >= MINIMUM_MAJOR
  const javaHome = host.env.JAVA_HOME ? describeHome(host.env.JAVA_HOME, 'JAVA_HOME', host) : null
  if (qualifies(javaHome)) return { java: javaHome }

  const onPath = findOnPath(javaName(host.platform), host)
  const pathVersion = onPath ? javaVersion(onPath, null, host) : null
  const pathJava = pathVersion ? { executable: onPath, version: pathVersion, major: majorOf(pathVersion), source: 'PATH' } : null
  if (qualifies(pathJava)) return { java: pathJava }

  const installed = discoveredHomes(host)
    .map(({ home, source }) => describeHome(home, source, host))
    .filter(qualifies)
    .sort((left, right) => left.major - right.major || compareVersions(right.version, left.version))
  if (installed.length > 0) return { java: installed[0] }

  const found = [describeJavaHome(host.env.JAVA_HOME, javaHome), describePathJava(pathJava)].join(', ')
  return {
    message: `wt-jdtls: Eclipse JDT LS needs Java ${MINIMUM_MAJOR} or newer to run, and none was found (${found}; searched ${searchedLabel(host)}). `
      + `Install a JDK ${MINIMUM_MAJOR}+ there, or set WT_JDTLS_JDK_DIRS to the directory holding one; the project's own JAVA_HOME can stay as it is.`,
  }
}

// On Windows the distribution's `jdtls.bat` ends in `pause`, so the Python launcher script beside it runs directly.
function jdtlsCommand(host) {
  const script = findOnPath('jdtls', host)
  if (!script) return null
  return host.platform === 'win32' ? { command: 'python', prefix: [script] } : { command: script, prefix: [] }
}

const USAGE = [
  'Usage: node wt-jdtls.mjs [jdtls options]',
  '',
  'Starts Eclipse JDT LS (`jdtls` on PATH) on a Java 21+ JVM, passed through jdtls\'s own --java-executable,',
  'leaving JAVA_HOME unchanged. The Java pack\'s .lsp.json runs it; its stdout is the language-server protocol.',
  '',
  'JVM choice: JAVA_HOME if it is 21+, else `java` on PATH if 21+, else an installed JDK 21+ (SDKMAN,',
  '/usr/lib/jvm, /usr/libexec/java_home, /Library/Java/JavaVirtualMachines, Program Files, ~/.jdks).',
  'With none, it starts nothing and refuses in one line naming the requirement.',
  '',
  'Options passed to jdtls: -data <dir>, -configuration <dir>, --jvm-arg=<option>,',
  '  --java-executable <path> (skips the JVM choice), --validate-java-version, --no-validate-java-version',
  'Environment: WT_JDTLS_JDK_DIRS=<dir>[<path delimiter><dir>...] replaces the built-in JDK locations.',
].join('\n')

const VALUE_OPTIONS = new Set(['-data', '-configuration', '--java-executable', '--jvm-arg'])
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
  const jdtls = jdtlsCommand(host)
  if (!jdtls) {
    return { status: 'refused', message: 'wt-jdtls: Eclipse JDT LS (`jdtls`) was not found on PATH; install it and put its bin directory on the PATH Claude Code starts with.' }
  }
  const supplied = argv.findIndex((arg) => arg === '--java-executable' || arg.startsWith('--java-executable='))
  if (supplied !== -1) {
    const executable = argv[supplied].includes('=') ? argv[supplied].slice(argv[supplied].indexOf('=') + 1) : argv[supplied + 1]
    return { status: 'launch', command: jdtls.command, args: [...jdtls.prefix, ...argv], java: { executable, major: null, source: 'caller' } }
  }
  const resolved = resolveJava(host)
  if (!resolved.java) return { status: 'refused', message: resolved.message }
  const { executable, major, source } = resolved.java
  return { status: 'launch', command: jdtls.command, args: [...jdtls.prefix, '--java-executable', executable, ...argv], java: { executable, major, source } }
}

// A refusal is written as ONE stderr line (Claude Code's debug log records it) AND returned to the client as the
// error of its `initialize` request with `retry: false`, so the reason reaches whatever asked for the server
// instead of a bare "crashed with exit code 1". The process then exits 1 on `exit`, on end of input, or after
// REFUSAL_LINGER_MS at most.
const REFUSAL_LINGER_MS = 30_000

function refuseOverProtocol(message, { exit, stderr, input = process.stdin, output = process.stdout }) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    // Exit only once the line is flushed: stdout and stderr are asynchronous pipes on Windows.
    output.write('', () => exit(1))
  }
  stderr.write(`${message}\n`)
  const send = (reply) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...reply })
    output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  let buffer = Buffer.alloc(0)
  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('latin1'))?.[1])
      if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return
      let request
      try { request = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')) } catch { request = {} }
      buffer = buffer.subarray(headerEnd + 4 + length)
      if (request.method === 'initialize' && request.id !== undefined) send({ id: request.id, error: { code: -32603, message, data: { retry: false } } })
      else if (request.method === 'shutdown' && request.id !== undefined) send({ id: request.id, result: null })
      else if (request.method === 'exit') finish()
    }
  })
  input.on('end', finish)
  input.on('error', finish)
  setTimeout(finish, REFUSAL_LINGER_MS)
}

// Runs the plan with stdio inherited, so the language-server protocol flows straight through; forwards the
// termination signals Claude Code sends, and exits with the server's own code. A refusal goes through refuseOverProtocol.
export function runJdtlsLaunch(plan, { exit = (code) => process.exit(code), stderr = process.stderr } = {}) {
  if (plan.status === 'help') {
    process.stdout.write(`${plan.text}\n`, () => exit(0))
    return
  }
  if (plan.status === 'usage-error') {
    stderr.write(`${plan.message}\n`, () => exit(2))
    return
  }
  if (plan.status !== 'launch') {
    refuseOverProtocol(plan.message, { exit, stderr })
    return
  }
  const child = spawn(plan.command, plan.args, { stdio: 'inherit', windowsHide: true })
  const forward = (signal) => { if (child.exitCode === null) child.kill(signal) }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => forward(signal))
  child.on('error', (error) => {
    stderr.write(`wt-jdtls: could not start ${plan.command}: ${error.message}\n`)
    exit(1)
  })
  child.on('exit', (code, signal) => exit(code ?? (signal ? 1 : 0)))
}
