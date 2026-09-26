import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { planJdtlsLaunch } from '../../../../plugin/bin/lib/host/jdtls-java.mjs'

const LAUNCHER = fileURLToPath(new URL('../../../../plugin/bin/wt-jdtls.mjs', import.meta.url))

interface FakeTree {
  files: Record<string, string>
  directories: Record<string, string[]>
  commands?: Record<string, { status: number; stdout?: string; stderr?: string }>
}

function seams(platform: 'linux' | 'darwin' | 'win32', env: Record<string, string>, tree: FakeTree) {
  return {
    platform,
    env,
    homeDirectory: platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev',
    readText: (file: string) => tree.files[file],
    isFile: (file: string) => file in tree.files,
    listDirectory: (directory: string) => tree.directories[directory] ?? [],
    run: (command: string, args: string[]) => tree.commands?.[[command, ...args].join(' ')] ?? { status: 1, stdout: '', stderr: '' },
  }
}

const release = (version: string) => `IMPLEMENTOR="Test"\nJAVA_VERSION="${version}"\n`

function posixJdk(tree: FakeTree, home: string, version: string | null) {
  tree.files[posix.join(home, 'bin', 'java')] = ''
  if (version !== null) tree.files[posix.join(home, 'release')] = release(version)
}

function linuxTree(): FakeTree {
  const tree: FakeTree = {
    files: { '/opt/jdtls/bin/jdtls': '' },
    directories: {
      '/home/dev/.sdkman/candidates/java': ['17.0.9-tem', '21.0.4-amzn', '21.0.9-tem', '25-tem', 'current', '8.0.462-tem'],
      '/usr/lib/jvm': [],
    },
  }
  const installs: Array<[string, string]> = [['17.0.9-tem', '17.0.9'], ['21.0.4-amzn', '21.0.4'], ['21.0.9-tem', '21.0.9'], ['25-tem', '25'], ['current', '17.0.9'], ['8.0.462-tem', '1.8.0_462']]
  for (const [name, version] of installs) {
    posixJdk(tree, `/home/dev/.sdkman/candidates/java/${name}`, version)
  }
  return tree
}

const linuxEnv = { PATH: '/opt/jdtls/bin:/usr/bin', JAVA_HOME: '/home/dev/.sdkman/candidates/java/17.0.9-tem' }

describe('jdtls JVM resolution', () => {
  it('passes the session JAVA_HOME through --java-executable when it is already Java 21 or newer', () => {
    const plan = planJdtlsLaunch(['-data', '/w'], seams('linux', { ...linuxEnv, JAVA_HOME: '/home/dev/.sdkman/candidates/java/25-tem' }, linuxTree()))
    expect(plan).toEqual({
      status: 'launch',
      command: '/opt/jdtls/bin/jdtls',
      args: ['--java-executable', '/home/dev/.sdkman/candidates/java/25-tem/bin/java', '-data', '/w'],
      java: { executable: '/home/dev/.sdkman/candidates/java/25-tem/bin/java', major: 25, source: 'JAVA_HOME' },
    })
  })

  it('keeps a Java 17 JAVA_HOME and picks the newest patch of the lowest installed major that is at least 21 (SDKMAN)', () => {
    const plan = planJdtlsLaunch([], seams('linux', linuxEnv, linuxTree()))
    expect(plan).toMatchObject({
      status: 'launch',
      args: ['--java-executable', '/home/dev/.sdkman/candidates/java/21.0.9-tem/bin/java'],
      java: { major: 21, source: 'SDKMAN' },
    })
  })

  it('honours SDKMAN_DIR and discovers /usr/lib/jvm installs, reading the version from `java -version` when release is absent', () => {
    const tree: FakeTree = {
      files: { '/opt/jdtls/bin/jdtls': '' },
      directories: { '/sdk/candidates/java': ['17'], '/usr/lib/jvm': ['java-21-openjdk-amd64'] },
      commands: { '/usr/lib/jvm/java-21-openjdk-amd64/bin/java -version': { status: 0, stderr: 'openjdk version "21.0.3" 2024-04-16\n' } },
    }
    posixJdk(tree, '/sdk/candidates/java/17', '17.0.2')
    posixJdk(tree, '/usr/lib/jvm/java-21-openjdk-amd64', null)
    const plan = planJdtlsLaunch([], seams('linux', { PATH: '/opt/jdtls/bin', SDKMAN_DIR: '/sdk' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', major: 21, source: '/usr/lib/jvm' } })
  })

  it('prefers a Java 21+ `java` first on PATH over a discovered install, after JAVA_HOME', () => {
    const tree = linuxTree()
    tree.files['/usr/local/jdk22/bin/java'] = ''
    tree.commands = { '/usr/local/jdk22/bin/java -version': { status: 0, stderr: 'openjdk version "22" 2024-03-19\n' } }
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, PATH: '/opt/jdtls/bin:/usr/local/jdk22/bin' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/usr/local/jdk22/bin/java', major: 22, source: 'PATH' } })
  })

  it('leaves a caller-supplied --java-executable untouched', () => {
    const plan = planJdtlsLaunch(['--java-executable=/x/java', '-data', '/w'], seams('linux', linuxEnv, linuxTree()))
    expect(plan).toEqual({ status: 'launch', command: '/opt/jdtls/bin/jdtls', args: ['--java-executable=/x/java', '-data', '/w'], java: { executable: '/x/java', major: null, source: 'caller' } })
  })

  it('searches exactly the WT_JDTLS_JDK_DIRS directories instead of the built-in locations when set', () => {
    const tree = linuxTree()
    tree.directories['/opt/jdks'] = ['corretto-23']
    posixJdk(tree, '/opt/jdks/corretto-23', '23.0.1')
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, WT_JDTLS_JDK_DIRS: '/opt/jdks' }, tree))
    expect(plan).toMatchObject({ status: 'launch', java: { executable: '/opt/jdks/corretto-23/bin/java', major: 23, source: 'WT_JDTLS_JDK_DIRS' } })
  })

  it('passes the jdtls launcher options through and refuses any other argument in one line', () => {
    const passed = planJdtlsLaunch(['-data', '/w', '-configuration', '/c', '--jvm-arg=-Xmx2G', '--no-validate-java-version'], seams('linux', linuxEnv, linuxTree()))
    expect(passed).toMatchObject({ status: 'launch', args: ['--java-executable', '/home/dev/.sdkman/candidates/java/21.0.9-tem/bin/java', '-data', '/w', '-configuration', '/c', '--jvm-arg=-Xmx2G', '--no-validate-java-version'] })
    const refused = planJdtlsLaunch(['-data', '/w', '--bogus'], seams('linux', linuxEnv, linuxTree()))
    expect(refused).toEqual({ status: 'usage-error', message: 'wt-jdtls: unknown argument --bogus; run `node wt-jdtls.mjs --help` for the options it passes to jdtls.' })
  })

  it('answers --help and -h with its own usage without looking for jdtls or a JVM', () => {
    for (const flag of ['--help', '-h']) {
      const plan = planJdtlsLaunch([flag], seams('linux', { PATH: '' }, { files: {}, directories: {} }))
      expect(plan.status).toBe('help')
      expect((plan as { text: string }).text).toContain('Usage: node wt-jdtls.mjs')
      expect((plan as { text: string }).text).toContain('WT_JDTLS_JDK_DIRS')
    }
  })

  it('refuses in ONE line naming the Java 21 requirement when no JDK 21+ exists', () => {
    const tree: FakeTree = { files: { '/opt/jdtls/bin/jdtls': '' }, directories: { '/home/dev/.sdkman/candidates/java': ['17.0.9-tem'] } }
    posixJdk(tree, '/home/dev/.sdkman/candidates/java/17.0.9-tem', '17.0.9')
    const plan = planJdtlsLaunch([], seams('linux', linuxEnv, tree))
    expect(plan.status).toBe('refused')
    const message = (plan as { message: string }).message
    expect(message).not.toContain('\n')
    expect(message).toContain('needs Java 21 or newer')
    expect(message).toContain('JAVA_HOME=/home/dev/.sdkman/candidates/java/17.0.9-tem is Java 17')
    expect(message).toContain('SDKMAN')
  })

  it('refuses in one line when jdtls itself is not on PATH', () => {
    const plan = planJdtlsLaunch([], seams('linux', { ...linuxEnv, PATH: '/usr/bin' }, linuxTree()))
    expect(plan.status).toBe('refused')
    expect((plan as { message: string }).message).toMatch(/^wt-jdtls: Eclipse JDT LS \(`jdtls`\) was not found on PATH;[^\n]+$/)
  })

  it('asks macOS /usr/libexec/java_home for a JDK 21+', () => {
    const home = '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home'
    const tree: FakeTree = {
      files: { '/opt/homebrew/bin/jdtls': '' },
      directories: {},
      commands: { '/usr/libexec/java_home -v 21+': { status: 0, stdout: `${home}\n` } },
    }
    posixJdk(tree, home, '21.0.5')
    const plan = planJdtlsLaunch([], seams('darwin', { PATH: '/opt/homebrew/bin' }, tree))
    expect(plan).toMatchObject({ status: 'launch', command: '/opt/homebrew/bin/jdtls', java: { executable: `${home}/bin/java`, major: 21, source: '/usr/libexec/java_home' } })
  })

  it('on Windows discovers a Program Files JDK and runs the jdtls Python script without the pausing .bat', () => {
    const home = 'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.5.11-hotspot'
    const tree: FakeTree = {
      files: {
        'C:\\jdtls\\bin\\jdtls': '',
        'C:\\jdtls\\bin\\jdtls.bat': '',
        [win32.join(home, 'bin', 'java.exe')]: '',
        [win32.join(home, 'release')]: release('21.0.5'),
      },
      directories: { 'C:\\Program Files\\Eclipse Adoptium': ['jdk-21.0.5.11-hotspot'] },
    }
    const plan = planJdtlsLaunch(['-data', 'C:\\w'], seams('win32', { Path: 'C:\\jdtls\\bin;C:\\Windows', ProgramFiles: 'C:\\Program Files' }, tree))
    expect(plan).toEqual({
      status: 'launch',
      command: 'python',
      args: ['C:\\jdtls\\bin\\jdtls', '--java-executable', win32.join(home, 'bin', 'java.exe'), '-data', 'C:\\w'],
      java: { executable: win32.join(home, 'bin', 'java.exe'), major: 21, source: 'Program Files' },
    })
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

function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'wt-jdtls-'))
  temporaryDirectories.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // PATH holds ONLY this directory, so no real `java` on the machine can be found through it.
  symlinkSync(spawnSync('/bin/sh', ['-c', 'command -v cat'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'cat'))
  const record = join(root, 'jdtls-argv.txt')
  // A fake jdtls: records its argv, then behaves like a stdio server by echoing stdin to stdout.
  executable(join(bin, 'jdtls'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\ncat\nexit 7\n`)
  const jdk = (name: string, version: string) => {
    const home = join(root, 'sdkman', 'candidates', 'java', name)
    mkdirSync(join(home, 'bin'), { recursive: true })
    executable(join(home, 'bin', 'java'), '#!/bin/sh\nexit 0\n')
    writeFileSync(join(home, 'release'), release(version))
    return home
  }
  return { root, bin, record, jdk }
}

// WT_JDTLS_JDK_DIRS confines discovery to the fake tree: the real /usr/lib/jvm (a JDK 21 on ubuntu-latest) stays unread.
function runLauncher(host: ReturnType<typeof fakeHost>, javaHome: string, input: string) {
  const env = { PATH: host.bin, JAVA_HOME: javaHome, HOME: host.root, WT_JDTLS_JDK_DIRS: join(host.root, 'sdkman', 'candidates', 'java') }
  return spawnSync(process.execPath, [LAUNCHER, '-data', '/tmp/ws'], { env, input, encoding: 'utf8', timeout: 20_000 })
}

describe.skipIf(process.platform === 'win32')('wt-jdtls launcher process', () => {
  it('starts jdtls with the discovered Java 21 while JAVA_HOME stays Java 17, keeping stdio as the protocol pipe and its exit code', () => {
    const host = fakeHost()
    const java17 = host.jdk('17.0.9-tem', '17.0.9')
    const java21 = host.jdk('21.0.9-tem', '21.0.9')
    const result = runLauncher(host, java17, 'Content-Length: 2\r\n\r\n{}')
    expect(result.stdout).toBe('Content-Length: 2\r\n\r\n{}')
    expect(result.status).toBe(7)
    expect(readFileSync(host.record, 'utf8').split('\n').filter(Boolean)).toEqual(['--java-executable', join(java21, 'bin', 'java'), '-data', '/tmp/ws'])
  })

  it('exits non-zero with exactly one stderr line and never starts jdtls when no JDK 21+ exists', () => {
    const host = fakeHost()
    const java17 = host.jdk('17.0.9-tem', '17.0.9')
    const result = runLauncher(host, java17, '')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1)
    expect(result.stderr).toContain('needs Java 21 or newer')
    expect(() => readFileSync(host.record)).toThrow()
  })

  it('refuses an unknown argument with exit 2 and never starts jdtls', () => {
    const host = fakeHost()
    const java21 = host.jdk('21.0.9-tem', '21.0.9')
    const env = { PATH: host.bin, JAVA_HOME: java21, HOME: host.root, WT_JDTLS_JDK_DIRS: join(host.root, 'sdkman', 'candidates', 'java') }
    const result = spawnSync(process.execPath, [LAUNCHER, '--bogus'], { env, input: '', encoding: 'utf8', timeout: 20_000 })
    expect(result.status).toBe(2)
    expect(result.stderr.trimEnd().split('\n')).toEqual(['wt-jdtls: unknown argument --bogus; run `node wt-jdtls.mjs --help` for the options it passes to jdtls.'])
    expect(() => readFileSync(host.record)).toThrow()
  })

  it('answers the client initialize with an error carrying the same line, so the refusal reaches the LSP client, then exits 1', () => {
    const host = fakeHost()
    const java17 = host.jdk('17.0.9-tem', '17.0.9')
    const frame = (message: object) => { const body = JSON.stringify({ jsonrpc: '2.0', ...message }); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` }
    const result = runLauncher(host, java17, frame({ id: 0, method: 'initialize', params: {} }) + frame({ method: 'exit' }))
    expect(result.status).toBe(1)
    const reply = JSON.parse(result.stdout.slice(result.stdout.indexOf('\r\n\r\n') + 4))
    expect(reply).toMatchObject({ id: 0, error: { data: { retry: false } } })
    expect(reply.error.message).toBe(result.stderr.trimEnd())
    expect(reply.error.message).toContain('needs Java 21 or newer')
  })
})
