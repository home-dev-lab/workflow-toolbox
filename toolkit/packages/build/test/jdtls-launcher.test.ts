import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { planJdtlsLaunch, runJdtlsLaunch, type JdtlsLaunchPlan } from '../../../../plugin/bin/lib/host/jdtls-java.mjs'

const LAUNCHER = fileURLToPath(new URL('../../../../plugin/bin/wt-jdtls.mjs', import.meta.url))

interface FakeTree {
  files: Record<string, string>
  directories: Record<string, string[]>
  links?: Record<string, string>
  commands?: Record<string, { status: number; stdout?: string; stderr?: string }>
}

// Every host read is served from `tree`. `calls` records each command run, so a test can assert what was NOT run.
function seams(platform: 'linux' | 'darwin' | 'win32', env: Record<string, string>, tree: FakeTree, calls: string[] = []) {
  return {
    platform,
    env,
    homeDirectory: platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
    readText: (file: string) => tree.files[file],
    isFile: (file: string) => file in tree.files,
    listDirectory: (directory: string) => tree.directories[directory] ?? [],
    realpath: (file: string) => tree.links?.[file] ?? (file in tree.files ? file : undefined),
    run: (command: string, args: string[]) => {
      calls.push([command, ...args].join(' '))
      // A java that exists answers `-version` unless the test scripts otherwise.
      return tree.commands?.[[command, ...args].join(' ')] ?? (command in tree.files ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' })
    },
  }
}

const release = (version: string) => `IMPLEMENTOR="Test"\nJAVA_VERSION="${version}"\n`

function posixJdk(tree: FakeTree, home: string, version: string | null) {
  tree.files[posix.join(home, 'bin', 'java')] = ''
  if (version !== null) tree.files[posix.join(home, 'release')] = release(version)
}

const SDK = '/home/dev/.sdkman/candidates/java'

// The upstream Eclipse JDT LS distribution: `bin/jdtls` with `bin/jdtls.py` beside it, and python3 on PATH.
function linuxTree(): FakeTree {
  const tree: FakeTree = {
    files: { '/opt/jdtls/bin/jdtls': '', '/opt/jdtls/bin/jdtls.py': '', '/usr/bin/python3': '' },
    directories: { [SDK]: ['17.0.9-tem', '21.0.4-amzn', '21.0.9-tem', '25-tem', 'current', '8.0.462-tem'], '/usr/lib/jvm': [] },
  }
  const installs: Array<[string, string]> = [['17.0.9-tem', '17.0.9'], ['21.0.4-amzn', '21.0.4'], ['21.0.9-tem', '21.0.9'], ['25-tem', '25'], ['current', '17.0.9'], ['8.0.462-tem', '1.8.0_462']]
  for (const [name, version] of installs) posixJdk(tree, `${SDK}/${name}`, version)
  return tree
}

const linuxEnv = { PATH: '/opt/jdtls/bin:/usr/bin', JAVA_HOME: `${SDK}/17.0.9-tem` }

describe('jdtls JVM resolution (upstream launcher)', () => {
  it('runs the upstream jdtls script with an absolute python3 and passes a Java 21+ JAVA_HOME through --java-executable', () => {
    const plan = planJdtlsLaunch(['-data', '/w'], seams('linux', { ...linuxEnv, JAVA_HOME: `${SDK}/25-tem` }, linuxTree()))
    expect(plan).toEqual({
      status: 'launch',
      command: '/usr/bin/python3',
      args: ['/opt/jdtls/bin/jdtls', '--java-executable', `${SDK}/25-tem/bin/java`, '-data', '/w'],
      java: { executable: `${SDK}/25-tem/bin/java`, major: 25, source: 'JAVA_HOME' },
    })
  })

  it('keeps a Java 17 JAVA_HOME and picks the newest patch of the lowest installed major that is at least 21 (SDKMAN)', () => {
    const plan = planJdtlsLaunch([], seams('linux', linuxEnv, linuxTree()))
    expect(plan).toMatchObject({ status: 'launch', args: ['/opt/jdtls/bin/jdtls', '--java-executable', `${SDK}/21.0.9-tem/bin/java`], java: { major: 21, source: 'SDKMAN' } })
  })

  it('falls through to the next candidate when the chosen java does not run (L1)', () => {
    const tree = linuxTree()
    tree.commands = { [`${SDK}/21.0.9-tem/bin/java -version`]: { status: 126, stderr: 'cannot execute binary file' } }
    const plan = planJdtlsLaunch([], seams('linux', linuxEnv, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: `${SDK}/21.0.4-amzn/bin/java`, major: 21 } })
  })

  it('reads an early-access version as its own major (22-ea qualifies)', () => {
    const tree = linuxTree()
    posixJdk(tree, '/opt/jdk-22ea', '22-ea')
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, JAVA_HOME: '/opt/jdk-22ea' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/opt/jdk-22ea/bin/java', major: 22, source: 'JAVA_HOME' } })
  })

  it('honours SDKMAN_DIR and discovers /usr/lib/jvm installs, reading the version from `java -version` when release is absent', () => {
    const tree: FakeTree = {
      files: { '/opt/jdtls/bin/jdtls': '', '/opt/jdtls/bin/jdtls.py': '', '/usr/bin/python3': '' },
      directories: { '/sdk/candidates/java': ['17'], '/usr/lib/jvm': ['java-21-openjdk-amd64'] },
      commands: { '/usr/lib/jvm/java-21-openjdk-amd64/bin/java -version': { status: 0, stderr: 'openjdk version "21.0.3" 2024-04-16\n' } },
    }
    posixJdk(tree, '/sdk/candidates/java/17', '17.0.2')
    posixJdk(tree, '/usr/lib/jvm/java-21-openjdk-amd64', null)
    const plan = planJdtlsLaunch([], seams('linux', { PATH: '/opt/jdtls/bin:/usr/bin', SDKMAN_DIR: '/sdk' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', major: 21, source: '/usr/lib/jvm' } })
  })

  it('prefers a Java 21+ `java` first on PATH, reading its home release file instead of starting it to learn its version (L5)', () => {
    const tree = linuxTree()
    posixJdk(tree, '/usr/local/jdk22', '22.0.1')
    const calls: string[] = []
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, PATH: '/opt/jdtls/bin:/usr/local/jdk22/bin:/usr/bin' }, tree, calls))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/usr/local/jdk22/bin/java', major: 22, source: 'PATH' } })
    // One JVM start in total: the final pick's own verification.
    expect(calls).toEqual(['/usr/local/jdk22/bin/java -version'])
  })

  it('does not probe the PATH java again when it is the JAVA_HOME java (L5)', () => {
    const tree = linuxTree()
    tree.links = { '/usr/bin/java': `${SDK}/17.0.9-tem/bin/java` }
    tree.files['/usr/bin/java'] = ''
    const calls: string[] = []
    planJdtlsLaunch([], seams('linux', linuxEnv, tree, calls))
    expect(calls.filter((call) => call.includes('17.0.9-tem') || call.startsWith('/usr/bin/java'))).toEqual([])
  })

  it('leaves a caller-supplied --java-executable untouched', () => {
    const plan = planJdtlsLaunch(['--java-executable=/x/java', '-data', '/w'], seams('linux', linuxEnv, linuxTree()))
    expect(plan).toEqual({ status: 'launch', command: '/usr/bin/python3', args: ['/opt/jdtls/bin/jdtls', '--java-executable=/x/java', '-data', '/w'], java: { executable: '/x/java', major: null, source: 'caller' } })
  })

  it('adds WT_JDTLS_JDK_DIRS to the built-in locations: the lowest qualifying major still wins (L2)', () => {
    const tree = linuxTree()
    tree.directories['/opt/jdks'] = ['corretto-23']
    posixJdk(tree, '/opt/jdks/corretto-23', '23.0.1')
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, WT_JDTLS_JDK_DIRS: '/opt/jdks' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: `${SDK}/21.0.9-tem/bin/java`, source: 'SDKMAN' } })
  })

  it('accepts a JDK home itself in WT_JDTLS_JDK_DIRS, not only its parent (L2)', () => {
    const tree: FakeTree = { files: { '/opt/jdtls/bin/jdtls': '', '/opt/jdtls/bin/jdtls.py': '', '/usr/bin/python3': '' }, directories: {} }
    posixJdk(tree, '/opt/jdk-21', '21.0.2')
    const plan = planJdtlsLaunch([], seams('linux', { PATH: '/opt/jdtls/bin:/usr/bin', WT_JDTLS_JDK_DIRS: '/opt/jdk-21' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/opt/jdk-21/bin/java', major: 21, source: 'WT_JDTLS_JDK_DIRS' } })
  })

  it('applies the macOS Contents/Home suffix to WT_JDTLS_JDK_DIRS entries (L2)', () => {
    const home = '/jvms/temurin-21.jdk/Contents/Home'
    const tree: FakeTree = { files: { '/opt/homebrew/bin/jdtls': '', '/opt/homebrew/bin/jdtls.py': '', '/usr/bin/python3': '' }, directories: { '/jvms': ['temurin-21.jdk'] } }
    posixJdk(tree, home, '21.0.5')
    const plan = planJdtlsLaunch([], seams('darwin', { PATH: '/opt/homebrew/bin:/usr/bin', WT_JDTLS_JDK_DIRS: '/jvms' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: `${home}/bin/java`, source: 'WT_JDTLS_JDK_DIRS' } })
  })

  it('passes jdtls options through and refuses any other argument, including a spaced --jvm-arg jdtls itself rejects (L4)', () => {
    const passed = planJdtlsLaunch(['-data', '/w', '-configuration', '/c', '--jvm-arg=-Xmx2G', '--no-validate-java-version'], seams('linux', linuxEnv, linuxTree()))
    expect(passed).toMatchObject({ status: 'launch', args: ['/opt/jdtls/bin/jdtls', '--java-executable', `${SDK}/21.0.9-tem/bin/java`, '-data', '/w', '-configuration', '/c', '--jvm-arg=-Xmx2G', '--no-validate-java-version'] })
    expect(planJdtlsLaunch(['-data', '/w', '--bogus'], seams('linux', linuxEnv, linuxTree()))).toEqual({ status: 'usage-error', message: 'wt-jdtls: unknown argument --bogus; run `node wt-jdtls.mjs --help` for the options it passes to jdtls.' })
    expect(planJdtlsLaunch(['--jvm-arg', '-Xmx2G'], seams('linux', linuxEnv, linuxTree()))).toMatchObject({ status: 'usage-error', message: expect.stringContaining('unknown argument --jvm-arg') })
  })

  it('answers --help and -h with its own usage without looking for jdtls or a JVM', () => {
    for (const flag of ['--help', '-h']) {
      const plan = planJdtlsLaunch([flag], seams('linux', { PATH: '' }, { files: {}, directories: {} }))
      expect(plan.status).toBe('help')
      expect((plan as { text: string }).text).toContain('Usage: node wt-jdtls.mjs')
      expect((plan as { text: string }).text).toContain('WT_JDTLS_JDK_DIRS')
      expect((plan as { text: string }).text).not.toContain('starts nothing')
    }
  })

  it('refuses in ONE line naming the Java 21 requirement when no JDK 21+ exists', () => {
    const tree: FakeTree = { files: { '/opt/jdtls/bin/jdtls': '', '/opt/jdtls/bin/jdtls.py': '', '/usr/bin/python3': '' }, directories: { [SDK]: ['17.0.9-tem'] } }
    posixJdk(tree, `${SDK}/17.0.9-tem`, '17.0.9')
    const plan = planJdtlsLaunch([], seams('linux', linuxEnv, tree))
    expect(plan.status).toBe('refused')
    const message = (plan as { message: string }).message
    expect(message).not.toContain('\n')
    expect(message).toContain('needs Java 21 or newer')
    expect(message).toContain(`JAVA_HOME=${SDK}/17.0.9-tem is Java 17`)
    expect(message).toContain('SDKMAN')
    expect(message).toContain('set WT_JDTLS_JDK_DIRS to that JDK home')
  })

  it('refuses in one line when jdtls itself is not on PATH', () => {
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, PATH: '/usr/bin' }, linuxTree()))
    expect(plan.status).toBe('refused')
    expect((plan as { message: string }).message).toMatch(/^wt-jdtls: Eclipse JDT LS \(`jdtls`\) was not found on PATH;[^\n]+$/)
  })

  it('refuses in one line when the upstream launcher has no python3 to run it (M1)', () => {
    const tree = linuxTree()
    delete tree.files['/usr/bin/python3']
    const plan = planJdtlsLaunch([], seams('linux', linuxEnv, tree))
    expect(plan).toEqual({ status: 'refused', message: expect.stringMatching(/^wt-jdtls: the Eclipse JDT LS launcher \/opt\/jdtls\/bin\/jdtls is a Python script and no `python3` was found on PATH;[^\n]+$/) })
  })

  it('asks macOS /usr/libexec/java_home for a JDK 21+', () => {
    const home = '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home'
    const tree: FakeTree = {
      files: { '/opt/jdtls/bin/jdtls': '', '/opt/jdtls/bin/jdtls.py': '', '/usr/bin/python3': '' },
      directories: {},
      commands: { '/usr/libexec/java_home -v 21+': { status: 0, stdout: `${home}\n` } },
    }
    posixJdk(tree, home, '21.0.5')
    const plan = planJdtlsLaunch([], seams('darwin', { PATH: '/opt/jdtls/bin:/usr/bin' }, tree))
    expect(plan).toMatchObject({ status: 'launch', command: '/usr/bin/python3', java: { executable: `${home}/bin/java`, major: 21, source: '/usr/libexec/java_home' } })
  })
})

describe('a jdtls that is not the upstream launcher runs unchanged (M3)', () => {
  it('runs a wrapper (no jdtls.py beside its real path) exactly as before: no JVM choice, arguments untouched', () => {
    const tree = linuxTree()
    tree.files['/home/dev/.local/bin/jdtls'] = ''
    tree.links = { '/home/dev/.local/bin/jdtls': '/home/dev/.local/share/jdtls-java21-wrapper/jdtls' }
    tree.files['/home/dev/.local/share/jdtls-java21-wrapper/jdtls'] = ''
    const calls: string[] = []
    const plan = planJdtlsLaunch(['-data', '/w'], seams('linux', { ...linuxEnv, PATH: '/home/dev/.local/bin:/opt/jdtls/bin:/usr/bin' }, tree, calls))
    expect(plan).toEqual({ status: 'launch', command: '/home/dev/.local/bin/jdtls', args: ['-data', '/w'], java: null })
    expect(calls).toEqual([])
  })

  it('treats a symlink whose real path has jdtls.py beside it as the upstream launcher', () => {
    const tree = linuxTree()
    tree.files['/home/dev/bin/jdtls'] = ''
    tree.links = { '/home/dev/bin/jdtls': '/opt/jdtls/bin/jdtls' }
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, PATH: '/home/dev/bin:/usr/bin' }, tree))
    expect(plan).toMatchObject({ status: 'launch', command: '/usr/bin/python3', args: ['/home/dev/bin/jdtls', '--java-executable', `${SDK}/21.0.9-tem/bin/java`] })
  })
})

describe('Windows', () => {
  const home = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot'
  const windowsTree = (): FakeTree => ({
    files: {
      'C:\\jdtls\\bin\\jdtls': '',
      'C:\\jdtls\\bin\\jdtls.py': '',
      'C:\\jdtls\\bin\\jdtls.bat': '',
      'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe': '',
      'C:\\Python312\\python.exe': '',
      [win32.join(home, 'bin', 'java.exe')]: '',
      [win32.join(home, 'release')]: release('21.0.5'),
    },
    directories: { 'C:\\Program Files\\Eclipse Adoptium': ['jdk-21.0.5.11-hotspot'] },
  })
  const windowsEnv = { Path: 'C:\\jdtls\\bin;C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312;C:\\Windows', ProgramFiles: 'C:\\Program Files' }

  it('runs the upstream jdtls script with an ABSOLUTE python.exe, skipping the Store alias, never the pausing .bat (M1, M2)', () => {
    const plan = planJdtlsLaunch(['-data', 'C:\\w'], seams('win32', windowsEnv, windowsTree()))
    expect(plan).toEqual({
      status: 'launch',
      command: 'C:\\Python312\\python.exe',
      args: ['C:\\jdtls\\bin\\jdtls', '--java-executable', win32.join(home, 'bin', 'java.exe'), '-data', 'C:\\w'],
      java: { executable: win32.join(home, 'bin', 'java.exe'), major: 21, source: 'Program Files' },
    })
  })

  it('refuses in one line when the only python.exe is the WindowsApps Store alias (M1)', () => {
    const tree = windowsTree()
    delete tree.files['C:\\Python312\\python.exe']
    const plan = planJdtlsLaunch([], seams('win32', windowsEnv, tree))
    expect(plan).toMatchObject({ status: 'refused', message: expect.stringContaining('the Microsoft Store alias') })
  })

  it('runs a packaged jdtls.cmd wrapper unchanged through cmd.exe (M3)', () => {
    const tree: FakeTree = { files: { 'C:\\scoop\\shims\\jdtls.cmd': '' }, directories: {} }
    const plan = planJdtlsLaunch(['-data', 'C:\\my ws'], seams('win32', { Path: 'C:\\scoop\\shims', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, tree))
    expect(plan).toEqual({
      status: 'launch',
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\scoop\\shims\\jdtls.cmd" "-data" "C:\\my ws""'],
      java: null,
      windowsVerbatimArguments: true,
    })
  })
})

// The refusal speaks the language-server protocol on injected streams, so every case runs in-process and fast.
function frame(message: object) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

function replies(text: string) {
  const out: Array<Record<string, unknown>> = []
  let rest = text
  while (rest.includes('\r\n\r\n')) {
    const length = Number(/Content-Length: (\d+)/.exec(rest)?.[1])
    const start = rest.indexOf('\r\n\r\n') + 4
    out.push(JSON.parse(rest.slice(start, start + length)))
    rest = rest.slice(start + length)
  }
  return out
}

function refusal(plan: JdtlsLaunchPlan, lingerMs = 5_000) {
  const input = new PassThrough()
  const output = new PassThrough()
  const stderr = new PassThrough()
  let stdout = ''
  let errors = ''
  output.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
  const exited = new Promise<{ code: number; at: number }>((resolve) => {
    runJdtlsLaunch(plan, { exit: (code: number) => resolve({ code, at: Date.now() }), stderr, input, output, lingerMs })
  })
  return { input, exited, stdout: () => stdout, stderr: () => errors }
}

const REFUSED: JdtlsLaunchPlan = { status: 'refused', message: 'wt-jdtls: Eclipse JDT LS needs Java 21 or newer to run' }

describe('the protocol refusal (L3)', () => {
  it('answers initialize with the one-line reason (retry: false), shutdown with null, and exits 1 on exit', async () => {
    const run = refusal(REFUSED)
    run.input.write(frame({ id: 0, method: 'initialize', params: {} }) + frame({ id: 1, method: 'shutdown' }) + frame({ method: 'exit' }))
    const { code } = await run.exited
    expect(code).toBe(1)
    const [initialize, shutdown] = replies(run.stdout())
    expect(initialize).toMatchObject({ id: 0, error: { message: REFUSED.message, data: { retry: false } } })
    expect(shutdown).toEqual({ jsonrpc: '2.0', id: 1, result: null })
    expect(run.stderr()).toBe(`${REFUSED.message}\n`)
  })

  it('exits on the exit notification while the input stays open, not only at end of input', async () => {
    const run = refusal(REFUSED, 60_000)
    const started = Date.now()
    run.input.write(frame({ method: 'exit' }))
    const { at } = await run.exited
    expect(at - started).toBeLessThan(2_000)
  })

  it('exits at end of input', async () => {
    const run = refusal(REFUSED, 60_000)
    run.input.end()
    expect((await run.exited).code).toBe(1)
  })

  it('exits after the linger when the client sends nothing', async () => {
    const run = refusal(REFUSED, 50)
    expect((await run.exited).code).toBe(1)
  })

  it('reassembles a frame split across chunks', async () => {
    const run = refusal(REFUSED)
    const whole = frame({ id: 7, method: 'initialize', params: {} })
    run.input.write(whole.slice(0, 10))
    await new Promise((resolve) => setTimeout(resolve, 20))
    run.input.write(whole.slice(10) + frame({ method: 'exit' }))
    await run.exited
    expect(replies(run.stdout())[0]).toMatchObject({ id: 7, error: { message: REFUSED.message } })
  })

  it('answers a request that arrives before initialize, and skips a header block without Content-Length', async () => {
    const run = refusal(REFUSED)
    run.input.write('X-Junk: 1\r\n\r\n' + frame({ id: 3, method: 'textDocument/hover', params: {} }) + frame({ id: 4, method: 'initialize', params: {} }) + frame({ method: 'exit' }))
    await run.exited
    const [early, initialize] = replies(run.stdout())
    expect(early).toMatchObject({ id: 3, error: { code: -32002, message: REFUSED.message } })
    expect(initialize).toMatchObject({ id: 4, error: { message: REFUSED.message } })
  })

  it('refuses a usage error over the protocol with exit 2 (L4)', async () => {
    const run = refusal({ status: 'usage-error', message: 'wt-jdtls: unknown argument --bogus' })
    run.input.write(frame({ id: 0, method: 'initialize', params: {} }) + frame({ method: 'exit' }))
    expect((await run.exited).code).toBe(2)
    expect(replies(run.stdout())[0]).toMatchObject({ id: 0, error: { message: 'wt-jdtls: unknown argument --bogus' } })
  })

  it('refuses over the protocol when the planned command cannot be started (M1)', async () => {
    const run = refusal({ status: 'launch', command: join(tmpdir(), 'wt-jdtls-no-such-python3'), args: [], java: null })
    await new Promise((resolve) => setTimeout(resolve, 200))
    run.input.write(frame({ id: 0, method: 'initialize', params: {} }) + frame({ method: 'exit' }))
    expect((await run.exited).code).toBe(1)
    expect(replies(run.stdout())[0]).toMatchObject({ id: 0, error: { message: expect.stringMatching(/^wt-jdtls: could not start .*wt-jdtls-no-such-python3: .*ENOENT/) } })
  })
})

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function executable(file: string, body: string) {
  writeFileSync(file, body)
  chmodSync(file, 0o755)
}

const which = (name: string) => spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()

// A real directory layout: PATH holds ONLY host.bin, so nothing else on the machine is reachable through it.
function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'wt-jdtls-'))
  temporaryDirectories.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  symlinkSync(which('cat'), join(bin, 'cat'))
  const record = join(root, 'jdtls-record.json')
  const jdk = (name: string, version: string) => {
    const home = join(root, 'jdks', name)
    mkdirSync(join(home, 'bin'), { recursive: true })
    executable(join(home, 'bin', 'java'), `#!/bin/sh\necho 'openjdk version "${version}"' >&2\nexit 0\n`)
    writeFileSync(join(home, 'release'), release(version))
    return home
  }
  // The upstream distribution: bin/jdtls (a Python script) with bin/jdtls.py beside it, reached through a PATH symlink.
  // It records argv and JAVA_HOME, then echoes stdin to stdout like a stdio server.
  const upstream = () => {
    const dist = join(root, 'jdtls-dist', 'bin')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'jdtls.py'), '')
    executable(join(dist, 'jdtls'), [
      'import json, os, shutil, sys',
      `json.dump({"argv": sys.argv[1:], "JAVA_HOME": os.environ.get("JAVA_HOME")}, open(${JSON.stringify(record)}, "w"))`,
      'shutil.copyfileobj(sys.stdin.buffer, sys.stdout.buffer)',
      'sys.exit(7)',
      '',
    ].join('\n'))
    symlinkSync(join(dist, 'jdtls'), join(bin, 'jdtls'))
  }
  const wrapper = (mode = 0o755) => {
    writeFileSync(join(bin, 'jdtls'), `#!/bin/sh\nprintf '{"argv":["%s"],"JAVA_HOME":"%s"}' "$*" "$JAVA_HOME" > '${record}'\ncat\nexit 5\n`)
    chmodSync(join(bin, 'jdtls'), mode)
  }
  const python = () => symlinkSync(which('python3'), join(bin, 'python3'))
  const readRecord = () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; JAVA_HOME: string }
  return { root, bin, record, jdk, upstream, wrapper, python, readRecord }
}

function runLauncher(host: ReturnType<typeof fakeHost>, javaHome: string, input: string, args = ['-data', '/tmp/ws']) {
  const env = { PATH: host.bin, JAVA_HOME: javaHome, HOME: host.root, SDKMAN_DIR: join(host.root, 'no-sdkman') }
  return spawnSync(process.execPath, [LAUNCHER, ...args], { env, input, encoding: 'utf8', timeout: 20_000 })
}

describe.skipIf(process.platform === 'win32')('wt-jdtls launcher process', () => {
  it('starts the upstream jdtls on the Java 21 found on PATH while the child JAVA_HOME stays the Java 17 home (M4)', () => {
    const host = fakeHost()
    host.upstream()
    host.python()
    const java17 = host.jdk('17.0.9-tem', '17.0.9')
    const java21 = host.jdk('21.0.9-tem', '21.0.9')
    symlinkSync(join(java21, 'bin', 'java'), join(host.bin, 'java'))
    const result = runLauncher(host, java17, 'Content-Length: 2\r\n\r\n{}')
    expect(result.stdout).toBe('Content-Length: 2\r\n\r\n{}')
    expect(result.status).toBe(7)
    expect(host.readRecord()).toEqual({ argv: ['--java-executable', join(host.bin, 'java'), '-data', '/tmp/ws'], JAVA_HOME: java17 })
  })

  it('runs a jdtls wrapper unchanged even when JAVA_HOME is Java 17 and a Java 21 is on PATH (M3)', () => {
    const host = fakeHost()
    host.wrapper()
    const java17 = host.jdk('17.0.9-tem', '17.0.9')
    symlinkSync(join(host.jdk('21.0.9-tem', '21.0.9'), 'bin', 'java'), join(host.bin, 'java'))
    const result = runLauncher(host, java17, '')
    expect(result.status).toBe(5)
    expect(host.readRecord()).toEqual({ argv: ['-data /tmp/ws'], JAVA_HOME: java17 })
  })

  it('refuses over the protocol when the jdtls wrapper cannot be executed (M1)', () => {
    const host = fakeHost()
    host.wrapper(0o644)
    const result = runLauncher(host, host.jdk('17.0.9-tem', '17.0.9'), frame({ id: 0, method: 'initialize', params: {} }) + frame({ method: 'exit' }))
    expect(result.status).toBe(1)
    expect(replies(result.stdout)[0]).toMatchObject({ id: 0, error: { message: expect.stringMatching(/^wt-jdtls: could not start .*EACCES/), data: { retry: false } } })
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1)
  })

  it('refuses over the protocol when python3 is absent for the upstream launcher (M1)', () => {
    const host = fakeHost()
    host.upstream()
    const result = runLauncher(host, host.jdk('21.0.9-tem', '21.0.9'), frame({ id: 0, method: 'initialize', params: {} }) + frame({ method: 'exit' }))
    expect(result.status).toBe(1)
    expect(replies(result.stdout)[0]).toMatchObject({ id: 0, error: { message: expect.stringContaining('no `python3` was found on PATH') } })
    expect(() => readFileSync(host.record)).toThrow()
  })

  it('refuses an unknown argument over the protocol with exit 2 and never starts jdtls (L4)', () => {
    const host = fakeHost()
    host.upstream()
    host.python()
    const result = runLauncher(host, host.jdk('21.0.9-tem', '21.0.9'), frame({ id: 0, method: 'initialize', params: {} }) + frame({ method: 'exit' }), ['--bogus'])
    expect(result.status).toBe(2)
    expect(result.stderr.trimEnd().split('\n')).toEqual(['wt-jdtls: unknown argument --bogus; run `node wt-jdtls.mjs --help` for the options it passes to jdtls.'])
    expect(replies(result.stdout)[0]).toMatchObject({ id: 0, error: { message: expect.stringContaining('unknown argument --bogus') } })
    expect(() => readFileSync(host.record)).toThrow()
  })

  it('keeps the launcher process from exiting early on a still-open stdin when the exit notification arrives', async () => {
    const host = fakeHost()
    const child = spawn(process.execPath, [LAUNCHER, '--bogus'], { env: { PATH: host.bin, HOME: host.root }, stdio: ['pipe', 'pipe', 'pipe'] })
    const code = new Promise<number | null>((resolve) => child.on('exit', resolve))
    child.stdin.write(frame({ method: 'exit' }))
    expect(await code).toBe(2)
    child.stdin.destroy()
  })
})
