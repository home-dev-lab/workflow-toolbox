import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Card 1871036638205838753: external lanes run in a bubblewrap sandbox on Linux. The unit half
// pins the allow-list construction with a fake filesystem (portable); the real half runs real
// bwrap children and skips, naming why, where no working bubblewrap exists (CI macOS/Windows).

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LIB = join(ROOT, 'plugin/bin/lib')
const LAUNCHER = join(ROOT, 'plugin/bin/wt-lane.mjs')

interface SandboxPlan { kind: 'bwrap' | 'none', line: string, readable?: string[], writable?: string[], wrap: (bin: string, args: string[]) => [string, string[]] }
interface FakeFs { exists: (file: string) => boolean, realpath: (file: string) => string | null, isFile: (file: string) => boolean, readText: (file: string) => string | null, ensureDir: (dir: string) => void }
interface SandboxModule {
  resolveLaneSandbox: (request: Record<string, unknown>) => SandboxPlan
  announceUnsandboxedLane: (plan: SandboxPlan, write: (text: string) => void) => void
}
interface SuiteLockModule {
  readSuiteLock: (options: Record<string, unknown>) => { root: string }
  acquireSuiteLock: (options: Record<string, unknown>) => Promise<{ root: string, lockDir: string, holder: Record<string, unknown> }>
  operatorReleaseSuiteLock: (options: Record<string, unknown>) => { released: boolean, reason?: string }
}
interface PidNamespaceModule { pidNamespaceHasProcesses: (namespace: string) => boolean | null }
interface Ownership { capture: (pid: number) => number | null, stop: () => string[], brokerInChildPidNamespace: () => void, env: Record<string, string> }
interface OwnershipModule { createCodexBrokerOwnership: (adapter: Record<string, unknown>, env: Record<string, string>, options?: Record<string, unknown>) => Ownership }
interface FenceModule { spawnOpencode: (spawnFn: typeof spawnSync, bin: string, args: string[], options: Record<string, unknown>, platform?: string) => ReturnType<typeof spawnSync> & { laneSandbox?: { kind: string, line: string } } }

const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(LIB, file)).href)) as T
const sandbox = await load<SandboxModule>('host/lane-sandbox.mjs')
const suiteLock = await load<SuiteLockModule>('suite-lock.mjs')
const pidNamespace = await load<PidNamespaceModule>('host/pid-namespace.mjs')
const ownership = await load<OwnershipModule>('host/codex-broker-ownership.mjs')
const fence = await load<FenceModule>('opencode-skill-fence.mjs')

const BWRAP_WORKS = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--', 'true'], { stdio: 'ignore' }).status === 0
const OPENCODE = BWRAP_WORKS ? String(spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' }).stdout ?? '').trim() : ''
const roots: string[] = []
const children: Array<{ kill: (signal?: NodeJS.Signals) => boolean }> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-lane-sandbox-${tag}-`)))
  roots.push(root)
  return root
}

function fakeFs(files: Record<string, string> = {}): FakeFs & { ensured: string[] } {
  const ensured: string[] = []
  return {
    ensured,
    exists: (file) => file in files || file === '/usr/bin/bwrap',
    realpath: (file) => (file in files ? file : null),
    isFile: (file) => file in files,
    readText: (file) => files[file] ?? null,
    ensureDir: (dir) => { ensured.push(dir) },
  }
}

const okProbe = () => ({ ok: true })
const HOME = '/home/lane-owner'
const binds = (args: string[], flag: string) => args.flatMap((value, index) => (value === flag ? [args[index + 1]!] : []))

function plan(overrides: Record<string, unknown> = {}): SandboxPlan {
  return sandbox.resolveLaneSandbox({ profile: 'opencode', bin: '/opt/opencode/bin/opencode', args: ['run', 'x'], cwd: '/work/tree', env: { HOME, PATH: '/usr/bin' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', probe: okProbe, fs: fakeFs(), ...overrides })
}

describe('lane sandbox plan (allow-list construction, portable)', () => {
  it('says so in one line and passes the command through where no sandbox exists', () => {
    const cases = [
      { platform: 'darwin', reason: 'bubblewrap sandbox is Linux-only; this host is darwin' },
      { platform: 'win32', reason: 'bubblewrap sandbox is Linux-only; this host is win32' },
      { fs: { ...fakeFs(), exists: () => false }, reason: 'bubblewrap (bwrap) is not installed' },
      { probe: () => ({ ok: false, reason: '/usr/bin/bwrap cannot create a sandbox here (No permissions)' }), reason: '/usr/bin/bwrap cannot create a sandbox here (No permissions)' },
      { optionEnv: { WT_LANE_SANDBOX: 'off' }, reason: 'disabled by WT_LANE_SANDBOX=off' },
    ]
    for (const { reason, ...override } of cases) {
      const result = plan(override)
      expect(result.kind).toBe('none')
      expect(result.line).toBe(`lane sandbox: none (${reason}); running with the environment allow-list only`)
      expect(result.wrap('opencode', ['run'])).toEqual(['opencode', ['run']])
    }
  })

  it('builds the root from named binds only: no whole-filesystem bind, home is an empty directory', () => {
    const [command, args] = plan().wrap('/opt/opencode/bin/opencode', ['run', 'x'])
    expect(command).toBe('/usr/bin/bwrap')
    const everyBind = [...binds(args, '--ro-bind'), ...binds(args, '--ro-bind-try'), ...binds(args, '--bind'), ...binds(args, '--bind-try')]
    expect(everyBind).not.toContain('/')
    expect(everyBind).not.toContain(HOME)
    expect(everyBind).not.toContain('/run')
    expect(everyBind.filter((bound) => bound.startsWith(`${HOME}/.ssh`) || bound.startsWith(`${HOME}/.claude`))).toEqual([])
    expect(binds(args, '--dir')).toContain(HOME)
    for (const flag of ['--die-with-parent', '--unshare-pid']) expect(args).toContain(flag)
    expect(args[args.indexOf('--proc') + 1]).toBe('/proc')
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp')
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['/opt/opencode/bin/opencode', 'run', 'x'])
    expect(args).not.toContain('--unshare-net')
  })

  it('gives OpenCode its own config read-only, its data/cache/state and the worktree read-write, and follows {file:} references of the GLOBAL config only', () => {
    const config = `${HOME}/.config/opencode`
    const files = {
      [`${config}/opencode.jsonc`]: '{ "apiKey": "{file:~/.config/proxy/api.key}", "prompt": "{file:./prompts/review.txt}", "gone": "{file:~/missing}" }',
      [`${HOME}/.config/proxy/api.key`]: 'k',
      [`${config}/prompts/review.txt`]: 'p',
      '/work/tree/.git': 'gitdir: /repo/.git/worktrees/tree\n',
      '/repo/.git/worktrees/tree/commondir': '../..\n',
      '/work/tree/opencode.json': '{ "x": "{file:~/.ssh/id_ed25519}" }',
    }
    const result = plan({ fs: fakeFs(files), args: ['run', 'x', '--dir', '/work/other', '-f', '/tmp/task.md'], env: { HOME, PATH: '/usr/bin', OPENCODE_CONFIG: '/work/tree/.lane/opencode.json' } })
    const [, args] = result.wrap('opencode', [])
    const readOnly = binds(args, '--ro-bind-try')
    const readWrite = binds(args, '--bind-try')
    expect(readOnly).toEqual(expect.arrayContaining([config, `${HOME}/.config/proxy/api.key`, `${config}/prompts/review.txt`, '/work/tree/.lane', '/tmp/task.md', '/repo/.git']))
    expect(readOnly).not.toContain(`${HOME}/missing`)
    expect(readOnly).not.toContain(`${HOME}/.ssh/id_ed25519`)
    expect(readWrite).toEqual(expect.arrayContaining(['/work/tree', '/work/other', `${HOME}/.local/share/opencode`, `${HOME}/.cache/opencode`, `${HOME}/.local/state/opencode`, '/repo/.git/worktrees/tree']))
    expect(readWrite).not.toContain('/repo/.git')
    expect(result.line).toMatch(/^lane sandbox: bwrap \(opencode; writable \/work\/tree, /)
  })

  it('shares the machine-wide suite lock directory that the suite lock itself resolves, and creates it first', () => {
    const fs = fakeFs()
    const [, args] = plan({ fs, env: { HOME, PATH: '/usr/bin' } }).wrap('opencode', [])
    const lockRoot = suiteLock.readSuiteLock({ env: {}, home: HOME, platform: 'linux' }).root
    expect(binds(args, '--bind-try')).toContain(lockRoot)
    expect(fs.ensured).toContain(lockRoot)
    const [, custom] = plan({ fs, env: { HOME, PATH: '/usr/bin', XDG_STATE_HOME: '/state' } }).wrap('opencode', [])
    expect(binds(custom, '--bind-try')).toContain(suiteLock.readSuiteLock({ env: { XDG_STATE_HOME: '/state' }, home: HOME, platform: 'linux' }).root)
  })

  it('makes Codex packages and config read-only on top of its writable home', () => {
    const files = { '/usr/local/bin/codex': 'x' }
    const [, args] = plan({ profile: 'codex', bin: '/usr/bin/node', fs: fakeFs(files), env: { HOME, PATH: '/usr/local/bin', CLAUDE_PLUGIN_DATA: '/tmp/wt-second-opinion-codex-1' } }).wrap('/usr/bin/node', [])
    const order = (flag: string, target: string) => args.findIndex((value, index) => value === flag && args[index + 1] === target)
    expect(order('--bind-try', `${HOME}/.codex`)).toBeGreaterThan(-1)
    expect(order('--bind-try', '/tmp/wt-second-opinion-codex-1')).toBeGreaterThan(-1)
    expect(order('--ro-bind-try', '/usr/local/bin/codex')).toBeGreaterThan(-1)
    for (const overlay of [`${HOME}/.codex/packages`, `${HOME}/.codex/config.toml`]) expect(order('--ro-bind-try', overlay)).toBeGreaterThan(order('--bind-try', `${HOME}/.codex`))
  })

  it('adds operator paths from WT_LANE_SANDBOX_READ/WRITE and refuses, by name, the root, home, and its ancestors', () => {
    const result = plan({ optionEnv: { WT_LANE_SANDBOX_READ: `~/.config/extra${delimiter}/${delimiter}relative/path`, WT_LANE_SANDBOX_WRITE: `/scratch${delimiter}${HOME}${delimiter}/home` } })
    const [, args] = result.wrap('opencode', [])
    expect(binds(args, '--ro-bind-try')).toContain(`${HOME}/.config/extra`)
    expect(binds(args, '--bind-try')).toContain('/scratch')
    for (const refused of ['/', 'relative/path', HOME, '/home']) {
      expect(binds(args, '--ro-bind-try')).not.toContain(refused)
      expect(binds(args, '--bind-try')).not.toContain(refused)
    }
    expect(result.line).toContain(`refused WT_LANE_SANDBOX_READ/WT_LANE_SANDBOX_WRITE entries /, relative/path, ${HOME}, /home`)
  })

  it('announces an unsandboxed lane once per reason, and a sandboxed one never', () => {
    const lines: string[] = []
    const none = plan({ platform: 'freebsd' })
    sandbox.announceUnsandboxedLane(none, (text) => lines.push(text))
    sandbox.announceUnsandboxedLane(none, (text) => lines.push(text))
    sandbox.announceUnsandboxedLane(plan(), (text) => lines.push(text))
    expect(lines).toEqual([`workflow-toolbox: ${none.line}\n`])
  })
})

describe('suite lock across PID namespaces', () => {
  async function held(tag: string, holderNamespace: string | null) {
    const root = tempRoot(tag)
    await suiteLock.acquireSuiteLock({ root, pidNamespace: holderNamespace, waitS: 1 })
    return root
  }

  it('from the host, keeps a sandboxed holder while its namespace lives and reclaims it once the namespace is empty', async () => {
    const root = await held('host-view', 'pid:[4026532999]')
    const hostView = { root, env: {}, pidNamespace: 'pid:[4026531836]' }
    expect(suiteLock.operatorReleaseSuiteLock({ ...hostView, namespaceHasProcesses: () => true })).toMatchObject({ released: false, reason: 'live' })
    expect(suiteLock.operatorReleaseSuiteLock({ ...hostView, namespaceHasProcesses: () => false })).toMatchObject({ released: true })
  })

  it('inside a sandbox, never reclaims a host holder by PID, including one written before namespaces were recorded', async () => {
    for (const holderNamespace of ['pid:[4026531836]', null]) {
      const root = await held(`sandbox-view-${String(holderNamespace !== null)}`, holderNamespace)
      const holderFile = join(root, 'lock.d', 'holder.json')
      const holder = JSON.parse(readFileSync(holderFile, 'utf8')) as Record<string, unknown>
      writeFileSync(holderFile, JSON.stringify({ ...holder, pid: 2_000_000_000, pidNamespace: holderNamespace ?? undefined }))
      const hourAgo = new Date(Date.now() - 3_600_000)
      utimesSync(join(root, 'lock.d'), hourAgo, hourAgo)
      const sandboxView = { root, env: { WT_LANE_SANDBOX: 'bwrap' }, pidNamespace: 'pid:[4026532999]', namespaceHasProcesses: () => false }
      expect(suiteLock.operatorReleaseSuiteLock(sandboxView)).toMatchObject({ released: false, reason: 'live' })
      expect(suiteLock.operatorReleaseSuiteLock({ ...sandboxView, staleS: 60 })).toMatchObject({ released: true })
    }
  })

  it('records the holder PID namespace', async () => {
    const root = await held('record', 'pid:[4026532001]')
    expect(JSON.parse(readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8'))).toMatchObject({ pidNamespace: 'pid:[4026532001]' })
  })
})

describe('codex broker ownership inside the sandbox PID namespace', () => {
  function adapter() {
    const processes = [
      { pid: 100, ppid: 1, startTime: 1_000, command: '/usr/bin/bwrap --unshare-pid -- node codex-companion.mjs' },
      { pid: 101, ppid: 100, startTime: 1_001, command: 'node codex-companion.mjs task' },
      { pid: 102, ppid: 101, startTime: 1_002, command: 'node /cache/openai-codex/codex/1.0/scripts/app-server-broker.mjs' },
      { pid: 7, ppid: 1, startTime: 5, command: 'kthreadd' },
    ]
    return { platform: 'linux', readProcessSnapshot: () => ({ supported: true, processes }) }
  }

  function withNamespacePidInState(owned: Ownership) {
    const state = join(owned.env.CLAUDE_PLUGIN_DATA!, 'state', 'workspace')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'broker.json'), JSON.stringify({ pid: 7 }))
  }

  it('ignores the namespace PID the broker recorded and finds the broker as a host descendant of the sandbox', () => {
    const trusting = ownership.createCodexBrokerOwnership(adapter(), {}, { now: () => 1_000 })
    withNamespacePidInState(trusting)
    expect(trusting.capture(100)).toBeNull()

    const namespaced = ownership.createCodexBrokerOwnership(adapter(), {}, { now: () => 1_000 })
    withNamespacePidInState(namespaced)
    namespaced.brokerInChildPidNamespace()
    expect(namespaced.capture(100)).toBe(102)
    for (const owned of [trusting, namespaced]) rmSync(owned.env.CLAUDE_PLUGIN_DATA!, { recursive: true, force: true })
  })
})

describe.skipIf(!BWRAP_WORKS)('real bubblewrap children (skips on a host without a working bwrap: macOS, Windows, or a Linux without unprivileged user namespaces)', () => {
  const PROBE = [
    'for p in "$@"; do if [ -r "$p" ]; then echo "READABLE $p"; else echo "denied $p"; fi; done',
    'if [ -e /run ]; then echo "PRESENT /run"; else echo "absent /run"; fi',
    'if [ -e "/proc/$HOST_PID" ]; then echo "VISIBLE host-process"; else echo "hidden host-process"; fi',
    // The marker is passed in two halves so the probe's own environ never contains it whole.
    'if grep -qs "$MARKER_HEAD$MARKER_TAIL" /proc/[0-9]*/environ; then echo "LEAK marker"; else echo "sealed marker"; fi',
    'if echo x > "$PWD/written" 2>/dev/null; then echo "wrote worktree"; else echo "NOWRITE worktree"; fi',
    'if echo x > "$HOME/.config/opencode/injected" 2>/dev/null; then echo "WROTE config"; else echo "readonly config"; fi',
    'echo "sandbox=${WT_LANE_SANDBOX:-unset}"',
  ].join('\n')

  function secretFixture() {
    const root = tempRoot('real')
    const home = join(root, 'home')
    const runtime = join(root, 'run-user')
    const worktree = join(root, 'worktree')
    const secrets = {
      opEnv: join(runtime, 'op-secrets.env'),
      sshKey: join(home, '.ssh', 'id_ed25519'),
      claudeCredentials: join(home, '.claude', '.credentials.json'),
      opAgentSocket: join(home, '.1password', 'agent.sock'),
    }
    const legitimate = { opencodeConfig: join(home, '.config', 'opencode', 'opencode.json'), opencodeAuth: join(home, '.local', 'share', 'opencode', 'auth.json') }
    for (const file of [...Object.values(secrets), ...Object.values(legitimate)]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, 'fixture-secret\n')
    }
    mkdirSync(worktree)
    const marker = `WT_SANDBOX_MARKER_${process.pid}_${Date.now()}`
    const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { PATH: process.env.PATH, [marker]: marker }, stdio: 'ignore' })
    children.push(host)
    return { home, runtime, worktree, secrets, legitimate, marker, hostPid: host.pid! }
  }

  function probe(f: ReturnType<typeof secretFixture>, sandboxSwitch: string | undefined) {
    const previous = process.env.WT_LANE_SANDBOX
    if (sandboxSwitch === undefined) delete process.env.WT_LANE_SANDBOX
    else process.env.WT_LANE_SANDBOX = sandboxSwitch
    try {
      const env = { PATH: process.env.PATH, HOME: f.home, XDG_RUNTIME_DIR: f.runtime, MARKER_HEAD: f.marker.slice(0, 10), MARKER_TAIL: f.marker.slice(10), HOST_PID: String(f.hostPid), WT_EXTERNAL_MODEL_ENV_ALLOW: 'MARKER_HEAD,MARKER_TAIL,HOST_PID' }
      const paths = [...Object.values(f.secrets), ...Object.values(f.legitimate)]
      return fence.spawnOpencode(spawnSync, '/bin/sh', ['-c', PROBE, 'probe', ...paths], { cwd: f.worktree, env, encoding: 'utf8', timeout: 30_000 }, 'linux')
    } finally {
      if (previous === undefined) delete process.env.WT_LANE_SANDBOX
      else process.env.WT_LANE_SANDBOX = previous
    }
  }

  it('hides the secrets cache, ssh keys, Claude credentials, agent sockets and other processes, while the worktree and the CLI config stay usable', () => {
    const f = secretFixture()
    const result = probe(f, undefined)
    const out = String(result.stdout)
    expect(result.status, String(result.stderr)).toBe(0)
    expect(result.laneSandbox?.kind).toBe('bwrap')
    for (const secret of Object.values(f.secrets)) expect(out).toContain(`denied ${secret}`)
    for (const allowed of Object.values(f.legitimate)) expect(out).toContain(`READABLE ${allowed}`)
    for (const line of ['absent /run', 'hidden host-process', 'sealed marker', 'wrote worktree', 'readonly config', 'sandbox=bwrap']) expect(out).toContain(line)
    expect(existsSync(join(f.worktree, 'written'))).toBe(true)
  })

  it('control: with the sandbox switched off, the same fixture secrets and the host process ARE visible', () => {
    const f = secretFixture()
    const result = probe(f, 'off')
    const out = String(result.stdout)
    expect(result.laneSandbox?.kind).toBe('none')
    for (const secret of Object.values(f.secrets)) expect(out).toContain(`READABLE ${secret}`)
    for (const line of ['VISIBLE host-process', 'LEAK marker', 'sandbox=unset']) expect(out).toContain(line)
  })

  it('sees a sandbox PID namespace from the host while it lives, and not after it ends', async () => {
    const child = spawn('bwrap', ['--ro-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'sh', '-c', 'readlink /proc/self/ns/pid; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(child)
    const namespace = await new Promise<string>((resolve) => { child.stdout.once('data', (chunk: Buffer) => resolve(String(chunk).trim())) })
    expect(namespace).toMatch(/^pid:\[\d+\]$/)
    expect(pidNamespace.pidNamespaceHasProcesses(namespace)).toBe(true)
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    const until = Date.now() + 5_000
    while (pidNamespace.pidNamespaceHasProcesses(namespace) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pidNamespace.pidNamespaceHasProcesses(namespace)).toBe(false)
  })

  it.skipIf(!OPENCODE)('runs the installed opencode without a model inside the sandbox (skips where opencode is not installed)', () => {
    const home = join(tempRoot('opencode'), 'home')
    mkdirSync(home)
    const result = fence.spawnOpencode(spawnSync, OPENCODE, ['--version'], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 60_000 }, 'linux')
    expect(result.status, String(result.stderr)).toBe(0)
    expect(result.laneSandbox?.kind).toBe('bwrap')
    expect(String(result.stdout).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('launches a real wt-lane run inside the sandbox and records it in the log and the supervision record', () => {
    const root = tempRoot('launcher')
    const worktree = join(root, 'worktree')
    const bin = join(root, 'bin')
    const config = join(root, 'config')
    const secret = join(root, 'home', '.ssh', 'id_ed25519')
    for (const dir of [join(worktree, '.lane'), bin, config, dirname(secret)]) mkdirSync(dir, { recursive: true })
    writeFileSync(secret, 'fixture-secret\n')
    writeFileSync(join(worktree, 'brief.md'), '# brief\n')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    writeFileSync(join(root, 'helpers.json'), '[]\n')
    writeFileSync(join(bin, 'opencode'), [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo fixture-1 ;;',
      '  --pure|debug) echo "[]" ;;',
      `  run) { echo "sandbox=\${WT_LANE_SANDBOX:-unset}"; if [ -r ${JSON.stringify(secret)} ]; then echo LEAK; else echo sealed; fi; } > "$PWD/observed" ;;`,
      'esac',
      '',
    ].join('\n'))
    chmodSync(join(bin, 'opencode'), 0o755)
    const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: config, XDG_STATE_HOME: join(root, 'state'), WT_LANE_MIN_AVAILABLE_MIB: '0', WT_LANE_WATCH_TEST_HELPERS: join(root, 'helpers.json') }
    const launched = spawnSync(process.execPath, [LAUNCHER, '--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', join(worktree, 'brief.md'), '--allow-no-git'], { encoding: 'utf8', env })
    expect(launched.status, launched.stderr).toBe(0)
    const log = join(worktree, '.lane', 'run.log')
    const until = Date.now() + 20_000
    while (!(existsSync(log) && /EXIT=\d+/.test(readFileSync(log, 'utf8'))) && Date.now() < until) spawnSync('sleep', ['0.05'])
    const text = readFileSync(log, 'utf8')
    expect(text).toMatch(/stage=sandbox lane sandbox: bwrap \(opencode; writable /)
    expect(text).toMatch(/EXIT=0\n$/)
    expect(readFileSync(join(worktree, 'observed'), 'utf8')).toBe('sandbox=bwrap\nsealed\n')
    const current = JSON.parse(readFileSync(join(worktree, '.lane', 'supervision', 'current.json'), 'utf8')) as { runId: string }
    const record = JSON.parse(readFileSync(join(worktree, '.lane', 'supervision', `${current.runId}.json`), 'utf8')) as { sandbox: string }
    expect(record.sandbox).toMatch(/^lane sandbox: bwrap \(opencode; writable /)
  })
})
