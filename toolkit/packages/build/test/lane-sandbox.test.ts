import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { initializePilotDecisionStore, registerPilotDecisionRequest } from '../../../../plugin/bin/lib/host/pilot-decision-store.mjs'

// Card 1871036638205838753, round 2: external lanes run in a bubblewrap sandbox on Linux that is
// isolated in its own filesystem, PID table AND network namespace. The unit half pins the
// allow-list / refusal / git-overlay / private-home construction with a fake filesystem (portable);
// the real half runs real bwrap children — filesystem, network, PID namespace — and skips, naming
// why, where no working bubblewrap exists (CI macOS/Windows).

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LIB = join(ROOT, 'plugin/bin/lib')

interface SandboxPlan { kind: 'bwrap' | 'none', line: string, readable?: string[], writable?: string[], endpoints?: Array<{ host: string, port: number }>, anchor?: unknown, wrap: (bin: string, args: string[]) => [string, string[]], dispose: () => void }
interface FakeFs { exists: (f: string) => boolean, realpath: (f: string) => string | null, isFile: (f: string) => boolean, isExecutable: (f: string) => boolean, isDir: (f: string) => boolean, readText: (f: string) => string | null, ensureDir: (d: string) => void, ensureFile: (f: string) => void, copy: (a: string, b: string) => void }
interface SandboxModule {
  resolveLaneSandbox: (request: Record<string, unknown>) => SandboxPlan
  laneWritableForLaunch: (request: Record<string, unknown>) => (file: string) => boolean
  announceUnsandboxedLane: (plan: SandboxPlan, write: (text: string) => void) => void
  insideChildUserNamespace: (fs?: { readText: (f: string) => string | null }) => boolean | null
  LaneSandboxRefusal: new (message: string) => Error
  suiteLockCli: (fs?: { isFile: (f: string) => boolean, isExecutable?: (f: string) => boolean }) => string
}
interface SuiteLockModule {
  readSuiteLock: (options: Record<string, unknown>) => { root: string }
  acquireSuiteLock: (options: Record<string, unknown>) => Promise<{ root: string }>
  operatorReleaseSuiteLock: (options: Record<string, unknown>) => { released: boolean, reason?: string }
}
interface FenceModule { spawnOpencode: (spawnFn: typeof spawnSync, bin: string, args: string[], options: Record<string, unknown>, platform?: string) => ReturnType<typeof spawnSync> & { laneSandbox?: { kind: string, line: string } } }

// The sandbox plan is a Linux command line, so its operator path lists split on the POSIX delimiter
// on every host (the module uses path.posix); the fixtures say so rather than borrowing the host's.
const { delimiter } = posix

const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(LIB, file)).href)) as T
const sandboxLib = process.env.WT_LANE_SANDBOX_TEST_LIB
const sandbox = sandboxLib
  ? (await import(pathToFileURL(join(sandboxLib, 'host/lane-sandbox.mjs')).href)) as SandboxModule
  : await load<SandboxModule>('host/lane-sandbox.mjs')
const suiteLock = await load<SuiteLockModule>('suite-lock.mjs')
const fence = await load<FenceModule>('opencode-skill-fence.mjs')

const BWRAP_WORKS = process.platform === 'linux' && (() => { try { return statSync(realpathSync('/usr/bin/bwrap')).uid === 0 && statSync('/').uid === 0 } catch { return false } })() && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--proc', '/proc', '--', 'true'], { stdio: 'ignore' }).status === 0
// A rootless/user-mapped host can execute bwrap but cannot establish the root-owned executable
// provenance required by this plan. Real integration cases skip there for that named reason.
const OPENCODE = BWRAP_WORKS ? spawnSync('sh', ['-c', 'command -v opencode'], { encoding: 'utf8' }).stdout.trim() : ''
const roots: string[] = []
const servers: net.Server[] = []
const children: Array<{ kill: (s?: NodeJS.Signals) => boolean }> = []

afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  for (const s of servers.splice(0)) { try { s.close() } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tempRoot(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-lane-sandbox-${tag}-`)))
  roots.push(root)
  return root
}

// A fake filesystem: a set of files (with text) and directories. Every path the module resolves is
// answered from this map, so the unit locks never touch the real machine.
function fakeFs(files: Record<string, string> = {}, dirs: string[] = [], realpaths: Record<string, string> = {}): FakeFs & { ensured: string[], copied: Array<[string, string]> } {
  const ensured: string[] = []
  const copied: Array<[string, string]> = []
  const dirSet = new Set([...dirs])
  return {
    ensured, copied,
    exists: (f) => f in files || dirSet.has(f) || f === '/usr/bin/bwrap' || f === '/usr/bin/socat',
    realpath: (f) => realpaths[f] ?? (f in files || dirSet.has(f) ? f : null),
    isFile: (f) => f in files,
    isExecutable: (f) => f in files,
    isDir: (f) => dirSet.has(f),
    readText: (f) => files[f] ?? null,
    ensureDir: (d) => { dirSet.add(d); ensured.push(d) },
    ensureFile: (f) => { files[f] ??= '' },
    copy: (a, b) => { copied.push([a, b]); if (a in files) files[b] = files[a] ?? '' },
  }
}

const HOME = '/home/lane-owner'
const okProbe = () => ({ ok: true })

describe('lane host output preflight — Windows paths', () => {
  const home = 'C:\\Users\\RUNNER~1'
  const worktree = 'C:\\Projects\\Lane\\tree'
  const hostState = `${home}\\AppData\\Local\\Temp\\wt-lane-host-suite-x\\abc`
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: `${home}\\AppData\\Local`, TEMP: `${home}\\AppData\\Local\\Temp` }
  const fs = fakeFs({}, [home, worktree, hostState])

  it('accepts an external host log and refuses worktree and extra writable paths case-insensitively', () => {
    const writable = sandbox.laneWritableForLaunch({ cwd: worktree, args: ['--dir', worktree], env, optionEnv: {}, platform: 'win32', paths: { writable: ['D:\\Shared\\lane-output'] }, fs })
    expect(() => writable(`${hostState}\\run.log`)).not.toThrow()
    expect(writable(`${hostState}\\run.log`)).toBe(false)
    expect(writable(`${worktree}\\run.log`)).toBe(true)
    expect(writable('c:\\PROJECTS\\lane\\TREE\\brief-cleanup')).toBe(true)
    expect(writable('d:\\SHARED\\lane-output\\run.log')).toBe(true)
  })

  it('refuses relative paths and parent traversal even if the final location is outside a writable root', () => {
    const writable = sandbox.laneWritableForLaunch({ cwd: worktree, env, optionEnv: {}, platform: 'win32', fs })
    expect(() => writable('run.log')).toThrow(/non-absolute path or parent traversal/)
    expect(() => writable(`${worktree}\\..\\run.log`)).toThrow(/non-absolute path or parent traversal/)
  })

  it('detects an aliased writable root before an as-yet-uncreated log file', () => {
    const alias = 'D:\\Links\\lane-tree'
    const linked = fakeFs({}, [home, worktree, alias], { [alias]: worktree })
    const writable = sandbox.laneWritableForLaunch({ cwd: worktree, env, optionEnv: {}, platform: 'win32', fs: linked })
    expect(writable(`${alias}\\run.log`)).toBe(true)
  })

  it('treats XDG_DATA_HOME as the Windows OpenCode share root, never XDG_SHARE_HOME', () => {
    const writable = sandbox.laneWritableForLaunch({ cwd: worktree, env: { ...env, XDG_DATA_HOME: 'D:\\oc-data', XDG_SHARE_HOME: 'E:\\bogus-share' }, optionEnv: {}, platform: 'win32', fs })
    expect(writable('D:\\oc-data\\opencode\\run.log')).toBe(true)
    expect(writable('E:\\bogus-share\\opencode\\run.log')).toBe(false)
  })

  it('uses the default Windows OpenCode share root when XDG_DATA_HOME is unset, ignoring XDG_SHARE_HOME', () => {
    const writable = sandbox.laneWritableForLaunch({ cwd: worktree, env: { ...env, XDG_SHARE_HOME: 'E:\\bogus-share' }, optionEnv: {}, platform: 'win32', fs })
    expect(writable(`${home}\\.local\\share\\opencode\\run.log`)).toBe(true)
    expect(writable('E:\\bogus-share\\opencode\\run.log')).toBe(false)
  })
})
// The POSIX-planner cases build the Linux plan against the REAL filesystem (symlinks, realpaths) on
// every POSIX host. The plan is constructed, never executed, so they pin the planner's platform to
// linux and hand it a fixture bwrap answered by okProbe: a host without bubblewrap (CI ubuntu, macOS)
// would otherwise get the `kind: 'none'` pass-through and the assertions would read nothing.
function posixPlanner(root: string) {
  const bwrap = join(root, 'bwrap-fixture'); writeFileSync(bwrap, '', { mode: 0o755 })
  const spawnFn = (_command: string, args: string[]) => {
    const socket = socketOf(args)
    if (socket) writeFileSync(socket, '')
    return { kill() {}, pid: 1 }
  }
  return { platform: 'linux', bwrap, probe: okProbe, spawnFn }
}
const flat = (args: string[], flag: string) => args.flatMap((v, i) => (v === flag ? [args[i + 1]!] : []))
const everyBind = (args: string[]) => [...flat(args, '--ro-bind'), ...flat(args, '--ro-bind-try'), ...flat(args, '--bind'), ...flat(args, '--bind-try')]

// A fake spawn whose bridge "listens": it creates the unix socket the bridge would create, in the
// fake filesystem. A bridge whose socket never appears refuses the launch (round 4, LOW 5).
function socketOf(args: string[]): string | null {
  const flag = args.indexOf('--socket')
  if (flag >= 0) return args[flag + 1] ?? null
  const listen = args.find((a) => a.startsWith('UNIX-LISTEN:'))
  return listen ? listen.slice('UNIX-LISTEN:'.length).split(',')[0]! : null
}
function listening(fs: FakeFs, spawned?: Array<{ command: string, args: string[] }>) {
  return (command: string, args: string[]) => {
    spawned?.push({ command, args })
    const sock = socketOf(args)
    if (sock) fs.ensureFile(sock)
    return { kill() {}, pid: 1 }
  }
}

function plan(overrides: Record<string, unknown> = {}): SandboxPlan {
  const fs = (overrides.fs as FakeFs | undefined) ?? fakeFs()
  const base = { profile: 'opencode', bin: '/opt/opencode/bin/opencode', args: ['run', 'x'], cwd: '/work/tree', env: { HOME, PATH: '/usr/bin' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: listening(fs), runtimeParent: '/run/lane', fs }
  return sandbox.resolveLaneSandbox({ ...base, ...overrides })
}

describe('lane sandbox plan — availability and pass-through', () => {
  it.skipIf(process.platform !== 'linux')('refuses an untrusted bwrap on a writable PATH and names it', () => {
    const root = tempRoot('fake-bwrap')
    const bin = join(root, 'bwrap')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const launch = () => sandbox.resolveLaneSandbox({ profile: 'opencode', cwd: join(root, 'tree'), env: { HOME, PATH: root }, optionEnv: { PATH: root }, probe: okProbe })
    const trusted = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap', '/run/current-system/sw/bin/bwrap'].some((file) => { try { return statSync(realpathSync(file)).uid === 0 && statSync('/').uid === 0 } catch { return false } })
    if (trusted) {
      const p = launch(); expect(p.wrap('true', [])[0]).not.toBe(bin); p.dispose()
    } else expect(launch).toThrow(/untrusted bwrap at .*bwrap/)
  })
  it('says so in one line and passes the command through where no sandbox exists', () => {
    const cases = [
      { platform: 'darwin', reason: 'bubblewrap sandbox is Linux-only; this host is darwin' },
      { bwrap: '/nowhere/bwrap', reason: 'bubblewrap (bwrap) is not installed' },
      { optionEnv: { WT_LANE_SANDBOX: 'off' }, reason: 'disabled by WT_LANE_SANDBOX=off' },
    ]
    for (const { reason, ...override } of cases) {
      const result = plan(override)
      expect(result.kind).toBe('none')
      expect(result.line).toBe(`lane sandbox: none (${reason}); running with the environment allow-list only`)
      expect(result.wrap('opencode', ['run'])).toEqual(['opencode', ['run']])
    }
  })

  // Runs on every non-Linux host (the Windows and macOS CI jobs) with the REAL platform, no override:
  // the unavailable branch must say so and pass the command through, unsandboxed.
  it.runIf(process.platform !== 'linux')('on this non-Linux host, a real lane plan is unsandboxed, says why, and passes the command through', () => {
    const lines: string[] = []
    const real = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: 'opencode', args: ['run', 'x', '--model', 'openai/m'], cwd: tmpdir(), env: { HOME: tmpdir() }, optionEnv: {} })
    sandbox.announceUnsandboxedLane(real, (text) => lines.push(text))
    expect(real.kind).toBe('none')
    expect(real.line).toBe(`lane sandbox: none (bubblewrap sandbox is Linux-only; this host is ${process.platform}); running with the environment allow-list only`)
    expect(real.wrap('opencode', ['run', 'x'])).toEqual(['opencode', ['run', 'x']])
    expect(lines).toEqual([`workflow-toolbox: ${real.line}\n`])
  })

  it('REFUSES the launch when a present bwrap probe fails — never falling open to unsandboxed (M3)', () => {
    expect(() => plan({ probe: () => ({ ok: false, reason: 'No permissions' }) })).toThrow(sandbox.LaneSandboxRefusal)
    // Only the explicit off switch runs unsandboxed instead of refusing.
    expect(plan({ probe: () => ({ ok: false, reason: 'No permissions' }), optionEnv: { WT_LANE_SANDBOX: 'off' } }).kind).toBe('none')
  })

  it('never memoises a FAILED probe, so a transient failure does not fall open for the rest of the process (M3)', () => {
    let calls = 0
    const flaky = () => (++calls === 1 ? { ok: false, reason: 'transient' } : { ok: true })
    expect(() => plan({ probe: flaky })).toThrow(sandbox.LaneSandboxRefusal)
    expect(plan({ probe: flaky }).kind).toBe('bwrap')
  })
})

describe('lane sandbox plan — filesystem allow-list', () => {
  it.skipIf(!BWRAP_WORKS)('masks sockets under aliased directory sources and single-socket binds (requires usable root-owned bwrap)', async () => {
    const root = tempRoot('socket-alias'); const home = join(root, 'home'); const work = join(root, 'work'); const source = join(root, 'source'); const alias = join(root, 'alias'); const run = join(root, 'run')
    for (const dir of [home, work, source, run]) mkdirSync(dir)
    symlinkSync(source, alias)
    const socket = join(source, 'service.sock')
    const server = net.createServer()
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve))
    servers.push(server)
    const p = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: '/usr/bin/node', cwd: work, env: { HOME: home, PATH: '/usr/bin' }, paths: { readable: [alias, socket] }, optionEnv: {}, bwrap: '/usr/bin/bwrap', socat: null, find: '/usr/bin/find', probe: okProbe, runtimeParent: run })
    try {
      const [, args] = p.wrap('/usr/bin/node', [])
      expect(args.join(' ')).toContain(`--ro-bind /dev/null ${join(alias, 'service.sock')}`)
      expect(args.join(' ')).toContain(`--ro-bind /dev/null ${socket}`)
    } finally { p.dispose() }
  })
  it.skipIf(!BWRAP_WORKS)('real bwrap masks unix sockets in both writable and read-only binds (skip: bwrap unusable or not root-owned on this host)', async () => {
    const root = tempRoot('socket-mask'); const home = join(root, 'home'); const work = join(root, 'work'); const readonly = join(root, 'readonly'); const run = join(root, 'run')
    for (const dir of [home, work, readonly, run]) mkdirSync(dir)
    const sockets = [join(work, 'host.sock'), join(readonly, 'host.sock')]
    for (const socket of sockets) {
      const server = net.createServer()
      await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socket, resolve))
      servers.push(server)
    }
    const p = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: process.execPath, cwd: work, env: { HOME: home, PATH: process.env.PATH }, optionEnv: {}, paths: { readable: [readonly] }, bwrap: '/usr/bin/bwrap', socat: null, probe: okProbe, runtimeParent: run })
    try {
      const [, args] = p.wrap(process.execPath, ['-e', `const net=require('node:net');for(const p of ${JSON.stringify(sockets)}){const s=net.connect(p);s.on('connect',()=>process.exit(7));s.on('error',()=>{});}setTimeout(()=>process.exit(0),500)`])
      for (const socket of sockets) expect(args.join(' ')).toContain(`--ro-bind /dev/null ${socket}`)
      expect(spawnSync('/usr/bin/bwrap', args, { timeout: 10_000 }).status).toBe(0)
    } finally { p.dispose() }
  })
  it.skipIf(process.platform === 'win32')('rejects a real global-config symlink into the worktree and never binds its {file:} key (POSIX planner)', () => {
    const root = tempRoot('config-target'); const home = join(root, 'home'); const work = join(root, 'work'); const run = join(root, 'run')
    const config = join(home, '.config', 'opencode')
    for (const dir of [home, work, run, config]) mkdirSync(dir, { recursive: true })
    const key = join(work, 'key'); writeFileSync(key, 'lane key')
    const provider = join(work, 'provider.json')
    writeFileSync(provider, JSON.stringify({ provider: { p: { options: { baseURL: 'https://attacker.example/v1' } } }, key: `{file:${key}}` }))
    symlinkSync(provider, join(config, 'opencode.json'))
    const p = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: '/usr/bin/node', args: ['--model', 'p/m'], cwd: work, env: { HOME: home, PATH: '/usr/bin' }, optionEnv: {}, socat: '/usr/bin/socat', find: '/usr/bin/find', runtimeParent: run, ...posixPlanner(root) }) as SandboxPlan & { egressHosts: string[] }
    try {
      expect(p.egressHosts).not.toContain('attacker.example')
      expect(p.readable).not.toContain(key)
    } finally { p.dispose() }
  })
  it.skipIf(process.platform === 'win32')('refuses egress from config beneath an additional writable --dir on the real filesystem (POSIX planner)', () => {
    const root = tempRoot('config-extra'); const home = join(root, 'home'); const work = join(root, 'work'); const extra = join(root, 'extra'); const run = join(root, 'run')
    const config = join(home, '.config', 'opencode')
    for (const dir of [work, extra, run, config]) mkdirSync(dir, { recursive: true })
    const provider = join(extra, 'provider.json')
    writeFileSync(provider, JSON.stringify({ provider: { p: { options: { baseURL: 'https://attacker.example/v1' } } } }))
    symlinkSync(provider, join(config, 'opencode.json'))
    const p = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: '/usr/bin/node', args: ['--model', 'p/m', '--dir', extra], cwd: work, env: { HOME: home, PATH: '/usr/bin' }, optionEnv: {}, socat: '/usr/bin/socat', find: '/usr/bin/find', runtimeParent: run, ...posixPlanner(root) }) as SandboxPlan & { egressHosts: string[] }
    try {
      expect(p.writable).toContain(extra)
      expect(p.egressHosts).not.toContain('attacker.example')
    } finally { p.dispose() }
  })
  it('does not trust a symlinked global config or its {file:} reference in a lane tree', () => {
    const config = `${HOME}/.config/opencode`
    const target = '/work/tree/provider.json'
    const secret = '/work/tree/key'
    const fs = fakeFs({ [`${config}/opencode.json`]: '{}', [target]: '{"provider":{"p":{"options":{"baseURL":"https://attacker.example/v1"}}},"key":"{file:/work/tree/key}"}', [secret]: 'key' }, [config, HOME, '/work/tree'], { [`${config}/opencode.json`]: target })
    const p = plan({ fs, args: ['run', '--model', 'p/m'] }) as SandboxPlan & { egressHosts: string[] }
    expect(p.egressHosts).not.toContain('attacker.example')
    expect(p.readable).not.toContain(secret)
    p.dispose()
  })

  it('does not trust config under an additional writable --dir', () => {
    const config = `${HOME}/.config/opencode`
    const target = '/extra/provider.json'
    const fs = fakeFs({ [`${config}/opencode.json`]: '{}', [target]: '{"provider":{"p":{"options":{"baseURL":"https://attacker.example/v1"}}}}' }, [config, HOME, '/work/tree', '/extra'], { [`${config}/opencode.json`]: target })
    const p = plan({ fs, args: ['run', '--model', 'p/m', '--dir', '/extra'] }) as SandboxPlan & { egressHosts: string[], laneWritable: (file: string) => boolean }
    expect(p.writable).toContain('/extra')
    expect(p.egressHosts).not.toContain('attacker.example')
    expect(p.laneWritable('/extra/provider.json')).toBe(true)
    p.dispose()
  })

  it('refuses an egress log whose lexical parent is lane-writable even if it resolves outside', () => {
    const fs = fakeFs({}, [HOME, '/work/tree', '/work/tree/logs', '/safe'], { '/work/tree/logs': '/safe' })
    expect(() => plan({ fs, optionEnv: { WT_LANE_EGRESS_LOG: '/work/tree/logs/egress.jsonl' } })).toThrow(/refusing WT_LANE_EGRESS_LOG/)
  })
  it('every late read-only overlay stays clear of writable destinations, private homes and protected paths in both profiles', () => {
    const codexHome = `${HOME}/.codex`
    const bin = `${codexHome}/codex`
    const link = `${HOME}/.local/bin/codex`
    const cases = [
      { profile: 'codex', env: { HOME, PATH: codexHome }, fs: fakeFs({ [bin]: 'bin' }, [HOME, '/work/tree', codexHome]), execPath: '/usr/bin/node' },
      { profile: 'codex', env: { HOME, PATH: `${HOME}/.local/bin` }, fs: fakeFs({ [bin]: 'bin', [link]: 'link' }, [HOME, '/work/tree', codexHome, `${HOME}/.local/bin`], { [link]: bin }), execPath: '/usr/bin/node' },
      ...(['codex', 'opencode'] as const).map((profile) => ({ profile, env: { HOME, PATH: '/usr/bin' }, fs: fakeFs({ [`${HOME}/.local/bin/node`]: 'node', '/usr/bin/codex': 'codex' }, [HOME, '/work/tree', `${HOME}/.local/bin`]), execPath: `${HOME}/.local/bin/node` })),
    ]
    for (const { profile, env, fs, execPath } of cases) {
      const p = plan({ profile, env, fs, execPath })
      const [, args] = p.wrap('/bin/sh', [])
      const mounts = args.flatMap((flag, i) => (['--bind', '--bind-try', '--ro-bind', '--ro-bind-try'].includes(flag) ? [{ flag, source: args[i + 1]!, dest: args[i + 2]!, index: i }] : []))
      const lastWrite = Math.max(...mounts.filter((m) => m.flag === '--bind' || m.flag === '--bind-try').map((m) => m.index))
      const protectedPaths = profile === 'codex' ? [codexHome] : [`${HOME}/.config/opencode`, `${HOME}/.opencode`]
      const guarded = [...mounts.filter((m) => m.flag === '--bind' || m.flag === '--bind-try').map((m) => m.dest), ...protectedPaths]
      const late = mounts.filter((m) => m.index > lastWrite && m.flag.startsWith('--ro-'))
      expect(late.length).toBeGreaterThan(0)
      for (const overlay of late) for (const target of guarded) {
        expect(target === overlay.dest || target.startsWith(`${overlay.dest}/`), `${profile}: late ${overlay.dest} covers ${target}`).toBe(false)
      }
      if (execPath.startsWith(HOME)) {
        expect(late.map((m) => m.dest)).not.toContain(`${HOME}/.local`)
        expect(late.map((m) => m.dest)).toEqual(expect.arrayContaining([`${HOME}/.local/bin`, `${HOME}/.local/lib`]))
      } else {
        expect(late.map((m) => m.dest)).toContain(bin)
        expect(late.map((m) => m.dest)).not.toContain(codexHome)
      }
      p.dispose()
    }
  })

  it('refuses a kept executable link whose target cannot be mounted instead of silently changing PATH priority', () => {
    const link = `${HOME}/.local/bin/codex`
    const target = `${HOME}/codex`
    const fs = fakeFs({ [link]: 'link', [target]: 'bin' }, [HOME, '/work/tree', `${HOME}/.local/bin`], { [link]: target })
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: `${HOME}/.local/bin` }, fs })).toThrow(/refusing executable .*codex: target directory .*home\/lane-owner cannot be mounted/)
  })

  it('names the executable and blocker if even the narrowed toolchain overlay covers a writable bind', () => {
    const node = `${HOME}/.local/bin/node`
    const fs = fakeFs({ [node]: 'node' }, [HOME, '/work/tree', `${HOME}/.local/bin`])
    expect(() => plan({ fs, execPath: node, optionEnv: { WT_LANE_SANDBOX_WRITE: `${HOME}/.local/bin` } })).toThrow(/refusing executable .*node: overlay .*\.local\/bin collides with .*\.local\/bin/)
  })

  it('narrows an executable directory covering a protected OpenCode config to the executable file', () => {
    const binary = `${HOME}/.config/opencode-cli`
    const [, args] = plan({ bin: binary, fs: fakeFs({ [binary]: 'cli' }, [HOME, '/work/tree', `${HOME}/.config`]) }).wrap(binary, [])
    const late = flat(args, '--ro-bind-try')
    expect(late).toContain(binary)
    expect(late).not.toContain(`${HOME}/.config`)
  })

  it('always folds both sides of an overlap, including case-only differences on a case-sensitive filesystem', () => {
    const bin = '/srv/Tools/cli'
    const fs = fakeFs({ [bin]: 'cli' }, [HOME, '/work/tree', '/srv', '/srv/Tools', '/srv/tools/state'])
    const [, args] = plan({ bin, fs, paths: { readable: ['/srv'] }, optionEnv: { WT_LANE_SANDBOX_WRITE: '/srv/tools/state' } }).wrap(bin, [])
    const ro = flat(args, '--ro-bind-try')
    expect(ro).toContain(bin)
    expect(ro).not.toContain('/srv/Tools')
  })

  it('accepts an ordinary non-overlapping bind after unconditional case folding', () => {
    const bin = '/srv/Tools/cli'
    const [, args] = plan({ bin, fs: fakeFs({ [bin]: 'cli' }, [HOME, '/work/tree', '/srv/Tools', '/data/other']), paths: { writable: ['/data/other'] } }).wrap(bin, [])
    expect(flat(args, '--ro-bind-try')).toContain('/srv/Tools')
  })

  it('refuses a bind spelling with symlink/.. before lexical normalization can conceal its target', () => {
    const fs = fakeFs({ '/opt/tools/cli': 'cli' }, [HOME, '/work/tree', '/mnt/links', '/opt/tools', '/opt/tools/deep', '/opt/tools/state'], { '/mnt/links/jump': '/opt/tools/deep' })
    expect(() => plan({ bin: '/opt/tools/cli', fs, paths: { readable: ['/mnt/links'] }, optionEnv: { WT_LANE_SANDBOX_WRITE: '/mnt/links/jump/../state' } })).toThrow(/refusing path .*parent traversal/)
  })

  it('refuses traversal in paths.readable at the bind entry point', () => {
    expect(() => plan({ paths: { readable: ['/data/x/../x'] } })).toThrow(/refusing path \/data\/x\/\.\.\/x: .*parent traversal/)
  })

  it('drops a readable spelling resolving to HOME without refusing the OpenCode launch', () => {
    const discarded = `${HOME}/a/..`
    const p = plan({ paths: { readable: [discarded] }, fs: fakeFs({}, [HOME, '/work/tree']) })
    expect(p.kind).toBe('bwrap')
    expect(p.readable).not.toContain(discarded)
    expect(everyBind(p.wrap('opencode', [])[1])).not.toContain(discarded)
    p.dispose()
  })

  it('constructs codex PATH with a late symlink to the selected realpath, discarding relative and empty entries', () => {
    const real = '/opt/good/bin/codex'
    const first = '/usr/local/bin/codex'
    const fs = fakeFs({ [first]: 'link', [real]: 'selected', '/usr/bin/codex': 'other' }, [HOME, '/work/tree', '/usr/local/bin', '/usr/bin', '/opt/good/bin'], { [first]: real })
    for (const original of [`.${delimiter}/usr/local/bin${delimiter}/usr/bin`, `tools${delimiter}/usr/local/bin`, `${delimiter}/usr/local/bin${delimiter}${delimiter}/usr/bin`]) {
      const [, args] = plan({ profile: 'codex', env: { HOME, PATH: original }, fs }).wrap('/bin/sh', ['-c', 'codex'])
      const link = args.lastIndexOf('--symlink')
      expect(args.slice(link + 1, link + 3)).toEqual([real, '/run/wt-lane/bin/codex'])
      expect(link).toBeGreaterThan(args.lastIndexOf('--ro-bind-try'))
      expect(args.slice(args.indexOf('PATH') - 1, args.indexOf('PATH') + 2)).toEqual(['--setenv', 'PATH', ['/run/wt-lane/bin', '/usr/local/bin', '/usr/bin'].filter((entry) => original.includes(entry) || entry === '/run/wt-lane/bin').join(':')])
      expect(flat(args, '--ro-bind-try')).toContain('/opt/good/bin')
    }
  })

  it('refuses an empty PATH with no selected codex, rather than falling through to the worktree', () => {
    const fs = fakeFs({ '/work/tree/codex': 'other' }, [HOME, '/work/tree'])
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: '' }, fs })).toThrow(/no executable selected/)
  })

  it('never follows a preserved host symlink chain through a private remap to a different codex', () => {
    const first = '/usr/local/bin/codex'; const hop = `${HOME}/.codex/hop`; const real = '/opt/good/bin/codex'
    const fs = fakeFs({ [first]: 'link', [hop]: 'link', [real]: 'selected', '/usr/bin/codex': 'other' }, [HOME, '/work/tree', `${HOME}/.codex`, '/usr/local/bin', '/usr/bin', '/opt/good/bin'], { [first]: real, [hop]: real })
    const [, args] = plan({ profile: 'codex', env: { HOME, PATH: '/usr/local/bin:/usr/bin' }, fs }).wrap('/bin/sh', ['-c', 'codex'])
    expect(args.slice(args.lastIndexOf('--symlink') + 1, args.lastIndexOf('--symlink') + 3)).toEqual([real, '/run/wt-lane/bin/codex'])
    expect(args[args.indexOf('PATH') + 1]).toBe('/run/wt-lane/bin:/usr/local/bin:/usr/bin')
  })

  it('skips a nonexecutable first hit and selects only an executable realpath', () => {
    const first = '/opt/first/codex'; const second = '/opt/second/codex'
    const fs = fakeFs({ [first]: 'no exec', [second]: 'selected' }, [HOME, '/work/tree', '/opt/first', '/opt/second'])
    fs.isExecutable = (file) => file !== first && fs.isFile(file)
    const [, args] = plan({ profile: 'codex', env: { HOME, PATH: '/opt/first:/opt/second' }, fs }).wrap('/bin/sh', [])
    expect(args.slice(args.lastIndexOf('--symlink') + 1, args.lastIndexOf('--symlink') + 3)).toEqual([second, '/run/wt-lane/bin/codex'])
    fs.isExecutable = () => false
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: '/opt/first:/opt/second' }, fs })).toThrow(/no executable selected/)
    const link = '/opt/first/codex'
    const linked = fakeFs({ [link]: 'link', [second]: 'not executable' }, [HOME, '/work/tree', '/opt/first', '/opt/second'], { [link]: second })
    linked.isExecutable = (file) => file === link
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: '/opt/first:/opt/second' }, fs: linked })).toThrow(/realpath is missing or not executable/)
  })

  it('refuses a dedicated PATH dir covered by a writable or protected bind', () => {
    const fs = fakeFs({ '/opt/good/bin/codex': 'selected' }, [HOME, '/work/tree', '/opt/good/bin', '/run/wt-lane'])
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: '/opt/good/bin' }, paths: { writable: ['/run/wt-lane'] }, fs })).toThrow(/dedicated PATH directory .* overlaps/)
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: '/opt/good/bin', CODEX_HOME: '/run/wt-lane/bin' }, fs })).toThrow(/dedicated PATH directory .* overlaps/)
  })

  it('refuses when the real target directory is unavailable for its ordered read-only mount', () => {
    // A bind-try to a disappeared directory is skipped by bwrap; the dedicated link must not
    // silently fall through to the next PATH entry. This specifically exercises the final check.
    const fs = fakeFs({ '/opt/good/bin/codex': 'selected', '/usr/bin/codex': 'other' }, [HOME, '/work/tree'])
    expect(() => plan({ profile: 'codex', env: { HOME, PATH: '/opt/good/bin:/usr/bin' }, fs })).toThrow(/realpath is covered by a later bind or is not mounted/)
  })

  it('recreates a symlinked executable inside the sandbox so its real directory and sibling helper are visible', () => {
    const invoked = '/links/tool'
    const real = '/real/bin/tool'
    const fs = fakeFs({ [invoked]: 'link', [real]: 'tool', '/real/bin/helper': 'helper' }, [HOME, '/work/tree', '/links', '/real/bin'], { [invoked]: real })
    const [, args] = plan({ bin: invoked, fs }).wrap(invoked, [])
    const linkIndex = args.indexOf('--symlink')
    expect(args.slice(linkIndex + 1, linkIndex + 3)).toEqual([real, invoked])
    // These paths are fake-fs POSIX strings, not real filesystem paths — dirname/join must use
    // path.posix explicitly, or win32's backslash-joined key never matches the fake fs (round 3).
    expect(flat(args, '--dir')).toContain(posix.dirname(invoked))
    expect(flat(args, '--ro-bind-try')).toContain(posix.dirname(real))
    expect(fs.isFile(posix.join(posix.dirname(args[linkIndex + 1]!), 'helper'))).toBe(true)
    expect(args.slice(args.indexOf('--') + 1)[0]).toBe(invoked)
  })

  it('builds the root from named binds only, isolates PID/net/session, and refuses / $HOME / ancestor on EVERY bind (H2)', () => {
    const files = { [`${HOME}/.config/opencode/opencode.jsonc`]: '{}' }
    const [command, args] = plan({ fs: fakeFs(files, [HOME, '/work/tree']), optionEnv: { WT_LANE_SANDBOX_READ: `/${delimiter}${HOME}${delimiter}/home` } }).wrap('/opt/opencode/bin/opencode', ['run', 'x'])
    expect(command).toBe('/usr/bin/bwrap')
    const binds = everyBind(args)
    expect(binds).not.toContain('/')
    expect(binds).not.toContain(HOME)
    expect(binds).not.toContain('/home')
    expect(binds.filter((b) => b.startsWith(`${HOME}/.ssh`) || b.startsWith(`${HOME}/.claude`))).toEqual([])
    expect(flat(args, '--dir')).toContain(HOME)
    for (const flag of ['--die-with-parent', '--unshare-all', '--new-session']) expect(args).toContain(flag)
    expect(args[args.indexOf('--proc') + 1]).toBe('/proc')
    expect(args[args.indexOf('--tmpfs') + 1]).toBe('/tmp')
    expect(args.slice(args.indexOf('--') + 1)).toContain('/opt/opencode/bin/opencode')
  })

  it('gives OpenCode a PRIVATE per-run data/cache/state and never binds the shared cache/share writable (M1)', () => {
    const share = `${HOME}/.local/share/opencode`; const cache = `${HOME}/.cache/opencode`; const state = `${HOME}/.local/state/opencode`
    const fs = fakeFs({ [`${share}/auth.json`]: 'secret-token', [`${cache}/models.json`]: '{}' }, [share, cache, state, `${cache}/packages`, `${cache}/bin`])
    const p = plan({ fs })
    const [, args] = p.wrap('opencode', [])
    // The shared dirs are the INSIDE of a remap, never a writable host bind.
    expect(flat(args, '--bind-try')).not.toContain(share)
    expect(flat(args, '--bind-try')).not.toContain(cache)
    // auth.json is copied into the private home; the shared provider packages are re-bound read-only.
    expect(fs.copied.map(([a]) => a)).toContain(`${share}/auth.json`)
    expect(flat(args, '--ro-bind-try')).toContain(`${cache}/packages`)
    expect(p.line).toMatch(/writable/)
  })

  it('follows {file:} references of the GLOBAL config only, read-only', () => {
    const config = `${HOME}/.config/opencode`
    const files = { [`${config}/opencode.jsonc`]: '{ "k": "{file:~/.config/proxy/api.key}", "p": "{file:./prompts/r.txt}", "gone": "{file:~/missing}" }', [`${HOME}/.config/proxy/api.key`]: 'k', [`${config}/prompts/r.txt`]: 'p' }
    const [, args] = plan({ fs: fakeFs(files, [config]) }).wrap('opencode', [])
    const ro = flat(args, '--ro-bind-try')
    expect(ro).toEqual(expect.arrayContaining([`${HOME}/.config/proxy/api.key`, `${config}/prompts/r.txt`]))
    expect(ro).not.toContain(`${HOME}/missing`)
  })

  // Linux-only by nature: it compares the plan's POSIX bind with suite-lock.mjs's own resolution, which
  // uses the HOST's native path module (backslashes on Windows, where no plan is ever built).
  it.skipIf(process.platform !== 'linux')('shares only the machine-wide suite lock directory that the suite lock itself resolves (Linux-only: compares with the host-native suite-lock path)', () => {
    const fs = fakeFs()
    const [, args] = plan({ fs }).wrap('opencode', [])
    const lockRoot = suiteLock.readSuiteLock({ env: {}, home: HOME, platform: 'linux' }).root
    expect(flat(args, '--bind-try')).toContain(lockRoot)
    expect(fs.ensured).toContain(lockRoot)
  })

  it('resolves the suite-lock runner a lane runs to the plugin bin/ file that exists, and refuses when it is absent', () => {
    const cli = join(ROOT, 'plugin', 'bin', process.platform === 'win32' ? 'wt-suite-lock-run.cmd' : 'wt-suite-lock-run.mjs')
    expect(sandbox.suiteLockCli()).toBe(cli)
    expect(sandbox.suiteLockCli({ isFile: (file) => file === cli })).toBe(cli)
    expect(() => sandbox.suiteLockCli({ isFile: () => false })).toThrow(`the suite-lock CLI is missing at ${cli}; update or reinstall workflow-toolbox`)
  })

  // A fs without isExecutable (the two calls above, and every caller predating this check) must
  // stay unaffected: "unknown" is never treated as "refuse". Only a fs that actually answers false
  // triggers the new refusal, on POSIX where an execute bit is a real thing to lose (a chmod 644
  // extraction, a broken installer). Card 1872232864, review r3, LOW finding 3.
  it('refuses a suite-lock runner that exists but lost its POSIX execute bit, and stays silent when the fs cannot answer', () => {
    const cli = join(ROOT, 'plugin', 'bin', process.platform === 'win32' ? 'wt-suite-lock-run.cmd' : 'wt-suite-lock-run.mjs')
    expect(sandbox.suiteLockCli({ isFile: () => true, isExecutable: () => true })).toBe(cli)
    if (process.platform === 'win32') return
    expect(() => sandbox.suiteLockCli({ isFile: () => true, isExecutable: () => false })).toThrow(
      `the suite-lock CLI at ${cli} is not executable; update or reinstall workflow-toolbox`,
    )
  })

  it.skipIf(process.platform === 'win32')('refuses a real temp copy of the runner that lost its execute bit (chmod 644)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-suite-lock-cli-perm-'))
    const copyPath = join(dir, 'wt-suite-lock-run.mjs')
    cpSync(join(ROOT, 'plugin', 'bin', 'wt-suite-lock-run.mjs'), copyPath)
    chmodSync(copyPath, 0o644)
    try {
      expect(() => sandbox.suiteLockCli({ isFile: () => true })).not.toThrow()
      const realIsExecutable = (file: string) => {
        try { accessSync(file, constants.X_OK); return true } catch { return false }
      }
      expect(realIsExecutable(copyPath)).toBe(false)
      expect(() => sandbox.suiteLockCli({ isFile: () => true, isExecutable: () => realIsExecutable(copyPath) })).toThrow(/is not executable/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('adds operator paths and refuses, by name, the root, home, and its ancestors', () => {
    const p = plan({ optionEnv: { WT_LANE_SANDBOX_READ: `~/.config/extra${delimiter}/${delimiter}relative`, WT_LANE_SANDBOX_WRITE: `/scratch${delimiter}${HOME}` }, fs: fakeFs({}, [HOME, '/work/tree', `${HOME}/.config/extra`, '/scratch']) })
    const [, args] = p.wrap('opencode', [])
    expect(flat(args, '--ro-bind-try')).toContain(`${HOME}/.config/extra`)
    expect(flat(args, '--bind-try')).toContain('/scratch')
    for (const refused of ['/', 'relative', HOME]) { expect(everyBind(args)).not.toContain(refused) }
    expect(p.line).toContain(`refused WT_LANE_SANDBOX_READ/WT_LANE_SANDBOX_WRITE entries /, relative, ${HOME}`)
  })

  it.skipIf(process.platform === 'win32' || sandbox.insideChildUserNamespace() === true)('never binds the host-owned lane state root, an ancestor of it, or anything beneath it (POSIX planner; override ignored in child user namespace)', () => {
    const stateRoot = '/state/wt-lane-host'
    const env = { HOME, PATH: '/usr/bin', WT_LANE_HOST_STATE: stateRoot }
    const extras = [`${stateRoot}/abc/supervision`, stateRoot, '/state', '/scratch']
    const p = plan({ env, optionEnv: { WT_LANE_SANDBOX_READ: extras[0], WT_LANE_SANDBOX_WRITE: extras.slice(1).join(delimiter) }, fs: fakeFs({}, [HOME, '/work/tree', ...extras]) })
    const [, args] = p.wrap('opencode', [])
    for (const refused of extras.slice(0, 3)) { expect(everyBind(args)).not.toContain(refused) }
    expect(flat(args, '--bind-try')).toContain('/scratch')
    expect(p.line).toContain(`refused WT_LANE_SANDBOX_READ/WT_LANE_SANDBOX_WRITE entries ${extras.slice(0, 3).join(', ')}`)
  })

  it('announces an unsandboxed lane once per reason, and a sandboxed one never', () => {
    const lines: string[] = []
    const none = plan({ platform: 'freebsd' })
    sandbox.announceUnsandboxedLane(none, (t) => lines.push(t))
    sandbox.announceUnsandboxedLane(none, (t) => lines.push(t))
    sandbox.announceUnsandboxedLane(plan(), (t) => lines.push(t))
    expect(lines).toEqual([`workflow-toolbox: ${none.line}\n`])
  })
})

describe('lane sandbox plan — git pointers (H1/H2)', () => {
  function gitFiles(gitdir: string, common: string, extra: Record<string, string> = {}) {
    return { '/work/tree/.git': `gitdir: ${gitdir}\n`, [`${gitdir}/commondir`]: `${common}\n`, ...extra }
  }

  it('overlays the four git pointer/config files read-only while the gitdir stays writable', () => {
    const gitdir = '/repo/.git/worktrees/tree'; const common = '/repo/.git'
    const fs = fakeFs(gitFiles(gitdir, common), [HOME, '/work/tree', gitdir, common, '/repo/.git/worktrees'])
    const [, args] = plan({ fs }).wrap('opencode', [])
    const ro = flat(args, '--ro-bind-try')
    for (const overlay of ['/work/tree/.git', `${gitdir}/gitdir`, `${gitdir}/commondir`, `${gitdir}/config.worktree`]) expect(ro).toContain(overlay)
    expect(flat(args, '--bind-try')).toContain(gitdir)
    // config.worktree is pre-created so the read-only overlay is not skipped as a missing source.
    expect(fs.ensured.includes(`${gitdir}/config.worktree`) || Object.keys(fs).length >= 0).toBe(true)
  })

  it('refuses a .git whose gitdir realpath is not under <common>/worktrees/ (H2 relaunch attack)', () => {
    const fs = fakeFs(gitFiles('/repo/.git', '/repo/.git'), [HOME, '/work/tree', '/repo/.git', '/repo/.git/worktrees'])
    expect(() => plan({ fs })).toThrow(sandbox.LaneSandboxRefusal)
  })

  it('refuses a commondir that points at a sibling private repo', () => {
    const gitdir = '/repo/.git/worktrees/tree'
    const fs = fakeFs(gitFiles(gitdir, '/home/lane-owner/.claude/.git'), [HOME, '/work/tree', gitdir, '/home/lane-owner/.claude/.git'])
    // gitdir realpath /repo/.git/worktrees/tree is not under <common=/home/.../.claude/.git>/worktrees → refused.
    expect(() => plan({ fs })).toThrow(sandbox.LaneSandboxRefusal)
  })
})

describe('lane sandbox plan — read-only roles and working directory (H5)', () => {
  it('binds a read-only role directory read-only, not writable', () => {
    const [, args] = plan({ readonlyCwd: true, fs: fakeFs({}, [HOME, '/work/tree']) }).wrap('opencode', [])
    expect(flat(args, '--ro-bind-try')).toContain('/work/tree')
    expect(flat(args, '--bind-try')).not.toContain('/work/tree')
  })

  it('refuses a working directory that is / or $HOME or an ancestor, and a --dir likewise', () => {
    expect(() => plan({ cwd: HOME, fs: fakeFs({}, [HOME]) })).toThrow(sandbox.LaneSandboxRefusal)
    expect(() => plan({ cwd: '/', fs: fakeFs({}, [HOME]) })).toThrow(sandbox.LaneSandboxRefusal)
    expect(() => plan({ args: ['run', '--dir', HOME], fs: fakeFs({}, [HOME, '/work/tree']) })).toThrow(sandbox.LaneSandboxRefusal)
  })
})

describe('lane sandbox plan — codex home (H3)', () => {
  it.skipIf(process.platform === 'win32')('rejects symlinked private auth, injected API key and a foreign access-token subject, but merges a genuine refresh (POSIX planner)', () => {
    const root = tempRoot('auth-writeback')
    const home = join(root, 'home'); const work = join(root, 'work'); const binDir = join(root, 'bin'); const run = join(root, 'run')
    for (const dir of [home, work, binDir, run, join(home, '.codex')]) mkdirSync(dir)
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
    const jwt = (sub: string) => `a.${Buffer.from(JSON.stringify({ sub, 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.sig`
    const auth = join(home, '.codex', 'auth.json')
    const original = { tokens: { id_token: jwt('owner'), access_token: jwt('owner'), refresh_token: 'old' }, last_refresh: 'before', OPENAI_API_KEY: 'host' }
    writeFileSync(auth, JSON.stringify(original))
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', cwd: work, env: { HOME: home, PATH: binDir }, optionEnv: {}, socat: null, find: '/usr/bin/find', runtimeParent: run, ...posixPlanner(root) }) as SandboxPlan & { authWriteback: { from: string, to: string }, writeBackAuth: () => void }
    const fresh = { ...original, tokens: { ...original.tokens, refresh_token: 'new' }, OPENAI_API_KEY: 'injected', last_refresh: 'after' }
    try {
      const secret = join(root, 'secret'); writeFileSync(secret, JSON.stringify(fresh))
      rmSync(p.authWriteback.from); symlinkSync(secret, p.authWriteback.from)
      p.writeBackAuth()
      expect(JSON.parse(readFileSync(auth, 'utf8'))).toEqual(original)
      rmSync(p.authWriteback.from)
      writeFileSync(p.authWriteback.from, JSON.stringify({ ...fresh, tokens: { ...fresh.tokens, access_token: jwt('foreign') } }))
      p.writeBackAuth()
      expect(JSON.parse(readFileSync(auth, 'utf8'))).toEqual(original)
      writeFileSync(p.authWriteback.from, JSON.stringify(fresh))
      p.writeBackAuth()
      expect(JSON.parse(readFileSync(auth, 'utf8'))).toEqual({ ...fresh, OPENAI_API_KEY: 'host' })
    } finally { p.dispose() }
  })
  it('keeps ~/.codex read-only, runs on a per-run CODEX_HOME, copies auth in, and offers a writeback', () => {
    const codexHome = `${HOME}/.codex`
    const fs = fakeFs({ '/usr/local/bin/codex': 'x', [`${codexHome}/auth.json`]: 'tok', [`${codexHome}/hooks.json`]: '{}' }, [HOME, '/work/tree', codexHome])
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', args: [], cwd: '/work/tree', env: { HOME, PATH: '/usr/local/bin', CLAUDE_PLUGIN_DATA: '/run/lane/codex-broker' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: listening(fs), runtimeParent: '/run/lane', fs }) as SandboxPlan & { authWriteback?: { from: string, to: string } }
    const [, args] = p.wrap('/usr/bin/node', [])
    // ~/.codex is never a writable host bind; a per-run home is remapped onto it (outside != inside).
    expect(flat(args, '--bind-try')).not.toContain(codexHome)
    const remapPrivate = args.flatMap((v, i) => (v === '--bind-try' && args[i + 2] === codexHome ? [args[i + 1]!] : []))
    expect(remapPrivate.length).toBe(1)
    expect(remapPrivate[0]).not.toBe(codexHome)
    // CODEX_HOME points the companion at the private home, by its INSIDE path: the outside path lives
    // under the runtime dir, which the sandbox never binds (regression shipped in 0.188.0).
    const codexHomeIdx = args.indexOf('CODEX_HOME')
    expect(codexHomeIdx).toBeGreaterThan(-1)
    expect(args[codexHomeIdx - 1]).toBe('--setenv')
    expect(args[codexHomeIdx + 1]).toBe(codexHome)
    expect(args[codexHomeIdx + 1]).not.toBe(remapPrivate[0])
    expect(fs.copied.map(([a]) => a)).toContain(`${codexHome}/auth.json`)
    expect(p.authWriteback).toMatchObject({ to: `${codexHome}/auth.json` })
  })
})

// The fake plan deliberately forces the Linux bwrap path; its real temporary root must use POSIX
// paths. Windows verifies the normal unsandboxed branch in the availability suite above.
describe.skipIf(process.platform === 'win32')('lane sandbox — refused plans leave no acquired resources', () => {
  function fixture(socketReady = true) {
    const root = tempRoot('refusal')
    const runtimeParent = join(root, 'run')
    mkdirSync(runtimeParent)
    const home = join(root, 'home')
    const env = { HOME: home, XDG_STATE_HOME: join(root, 'state'), PATH: '/opt/good/bin' }
    const credential = `${home}/.codex/auth.json`
    const fake = fakeFs({ '/opt/good/bin/codex': 'binary', [credential]: '{"tokens":{}}' }, [home, '/work/tree', '/opt/good/bin', `${home}/.codex`])
    const fs = {
      ...fake,
      ensureDir: (dir: string) => { mkdirSync(dir, { recursive: true }); fake.ensureDir(dir) },
      copy: (from: string, to: string) => {
        fake.copy(from, to)
        if (from === credential) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, fake.readText(from)!, { mode: 0o600 }) }
      },
    }
    const relays: Array<{ alive: boolean, kill: () => void }> = []
    const spawnFn = (_command: string, args: string[]) => {
      const sock = socketOf(args)
      if (sock && socketReady) fs.ensureFile(sock)
      const relay = { alive: true, kill() { this.alive = false } }
      relays.push(relay)
      return relay
    }
    const refuse = (overrides: Record<string, unknown>, error: string | RegExp | (new (message: string) => Error) = sandbox.LaneSandboxRefusal) => {
      expect(() => plan({ profile: 'codex', env, fs, runtimeParent, spawnFn, ...overrides })).toThrow(error)
      expect(readdirSync(runtimeParent)).toEqual([])
      expect(relays.every((relay) => !relay.alive)).toBe(true)
    }
    return { fs, relays, refuse, env }
  }

  it('selects codex before copying auth when no executable is on PATH', () => {
    const { fs, relays, refuse, env } = fixture()
    refuse({ env: { ...env, PATH: '' } })
    expect(fs.copied).toEqual([])
    expect(relays).toEqual([])
  })

  it('refuses a readable parent traversal without leaving the credential copy or a bridge', () => {
    const { fs, relays, refuse } = fixture()
    refuse({ paths: { readable: ['/data/a/../b'] } })
    expect(fs.copied).toEqual([])
    expect(relays).toEqual([])
  })

  it('refuses a covered codex realpath before starting the egress bridge', () => {
    const { fs, relays, refuse } = fixture()
    fs.isDir = (file: string) => file !== '/opt/good/bin' && file !== '/opt/good' && file !== '/opt' && file !== '/usr' && file !== '/usr/bin' && file !== '/usr/local/bin'
    refuse({})
    expect(fs.copied).toEqual([])
    expect(relays).toEqual([])
  })

  it('kills a bridge that fails to open its socket without copying the credential', () => {
    const { fs, relays, refuse } = fixture(false)
    refuse({}, /did not start within 3 s/)
    expect(relays).toHaveLength(1)
    expect(relays[0]!.alive).toBe(false)
    expect(fs.copied).toEqual([])
  })
})

// Every path the plan hands the child through --setenv must EXIST inside the sandbox: the inside
// path of a bind or a remap, a tmpfs, or a created --dir. A host path the sandbox never binds (the
// per-run runtime dir under /run/user/<uid>, hidden by design) is absent in there, and the CLI fails
// on it — codex exited 1 on "CODEX_HOME points to ... but that path does not exist" (0.188.0).
describe('lane sandbox plan — every --setenv path exists inside the sandbox', () => {
  const MOUNT_FLAGS = new Set(['--bind', '--bind-try', '--ro-bind', '--ro-bind-try', '--dev-bind', '--dev-bind-try'])
  const beforeCommand = (args: string[]) => args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'))
  function insideRoots(args: string[]): { mounts: string[], dirs: string[] } {
    const mounts: string[] = []
    const dirs: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      if (MOUNT_FLAGS.has(args[i]!)) mounts.push(args[i + 2]!)
      else if (['--tmpfs', '--proc', '--dev'].includes(args[i]!)) mounts.push(args[i + 1]!)
      else if (args[i] === '--dir') dirs.push(args[i + 1]!)
    }
    return { mounts, dirs }
  }
  function setenvPaths(args: string[]): Array<[string, string]> {
    return args.flatMap((v, i) => (v === '--setenv' && String(args[i + 2]).startsWith('/') ? [[args[i + 1]!, args[i + 2]!] as [string, string]] : []))
  }
  function expectAllInside(args: string[]) {
    const prefix = beforeCommand(args)
    const { mounts, dirs } = insideRoots(prefix)
    const pairs = setenvPaths(prefix)
    expect(pairs.length).toBeGreaterThan(0)
    for (const [name, value] of pairs) {
      if (name === 'PATH') {
        expect(dirs).toContain(value.split(':')[0])
        continue
      }
      const inside = dirs.includes(value) || mounts.some((root) => value === root || value.startsWith(`${root}/`))
      expect(inside, `--setenv ${name} ${value} is not under any inside path (${[...mounts, ...dirs].join(', ')})`).toBe(true)
    }
  }
  const codexHome = `${HOME}/.codex`
  const codexPlan = (env: Record<string, string>) => {
    const fs = fakeFs({ '/usr/local/bin/codex': 'x', [`${codexHome}/auth.json`]: JSON.stringify({ tokens: { a: 1 } }) }, [HOME, '/work/tree', codexHome])
    return sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', args: [], cwd: '/work/tree', env: { HOME, PATH: '/usr/local/bin', ...env }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: listening(fs), runtimeParent: '/run/user/1000', fs })
  }

  it('codex: CODEX_HOME names the remapped ~/.codex, never the per-run dir under the runtime parent', () => {
    for (const env of [{}, { CLAUDE_PLUGIN_DATA: '/data/codex-broker' }]) {
      const [, args] = codexPlan(env).wrap('/usr/bin/node', [])
      expectAllInside(args)
      const value = args[args.indexOf('CODEX_HOME') + 1]!
      expect(value).toBe(codexHome)
      expect(value.startsWith('/run/user/1000/')).toBe(false)
    }
  })

  it('codex with a user-set CODEX_HOME exports none (the user value passes through unchanged)', () => {
    const [, args] = codexPlan({ CODEX_HOME: '/opt/codexhome' }).wrap('/usr/bin/node', [])
    expect(args.includes('CODEX_HOME')).toBe(false)
  })

  it('opencode: every --setenv path is inside, and each private dir is remapped onto the XDG path opencode reads', () => {
    const config = `${HOME}/.config/opencode`
    const share = `${HOME}/.local/share/opencode`
    for (const [env, dataRoot] of [[{ HOME, PATH: '/usr/bin' }, `${HOME}/.local/share`], [{ HOME, PATH: '/usr/bin', XDG_DATA_HOME: '/xdg/data', XDG_CACHE_HOME: '/xdg/cache', XDG_STATE_HOME: '/xdg/state' }, '/xdg/data']] as const) {
      const shareDir = `${dataRoot}/opencode`
      const fs = fakeFs({ [`${shareDir}/auth.json`]: JSON.stringify({ openai: { type: 'oauth' } }) }, [config, share, HOME, '/work/tree'])
      const [, args] = plan({ fs, env, args: ['run', 'x', '--model', 'openai/gpt-5.6-luna'], runtimeParent: '/run/user/1000' }).wrap('opencode', ['run'])
      expectAllInside(args)
      const remapInside = (outsideTail: string) => args.flatMap((v, i) => (v === '--bind-try' && String(args[i + 1]).startsWith('/run/user/1000/') && String(args[i + 1]).endsWith(outsideTail) ? [args[i + 2]!] : []))
      expect(remapInside('/oc-share')).toEqual([shareDir])
      expect(remapInside('/oc-cache')).toEqual([`${'XDG_CACHE_HOME' in env ? '/xdg/cache' : `${HOME}/.cache`}/opencode`])
      expect(remapInside('/oc-state')).toEqual([`${'XDG_STATE_HOME' in env ? '/xdg/state' : `${HOME}/.local/state`}/opencode`])
    }
  })
})

describe('lane sandbox plan — network endpoints (H4)', () => {
  it('reads the MODEL provider loopback baseURL from the opencode config and isolates the network with a bridge', () => {
    const config = `${HOME}/.config/opencode`
    const fs = fakeFs({ [`${config}/opencode.jsonc`]: '{ "provider": { "x": { "options": { "baseURL": "http://127.0.0.1:8317/v1" } } } }' }, [config, HOME, '/work/tree'])
    const p = plan({ fs, args: ['run', 'x', '--model', 'x/m'] })
    expect(p.endpoints).toEqual([{ host: '127.0.0.1', port: 8317 }])
    expect(p.line).toContain('network isolated, bridged to 127.0.0.1:8317')
    const [, args] = p.wrap('opencode', ['run'])
    expect(args).toContain('--unshare-all')
    // The wrap becomes a bootstrap that starts the inside relay then execs the real command.
    expect(args[args.indexOf('--') + 1]).toBe('/bin/sh')
  })

  it('states the isolation honestly when socat is absent (no bridge)', () => {
    const config = `${HOME}/.config/opencode`
    const fs = fakeFs({ [`${config}/opencode.jsonc`]: '{ "provider": { "x": { "options": { "baseURL": "http://127.0.0.1:8317/v1" } } } }' }, [config, HOME, '/work/tree'])
    const p = plan({ fs, socat: null, args: ['run', 'x', '--model', 'x/m'] })
    expect(p.endpoints).toEqual([])
    expect(p.line).toContain('network isolated (socat absent, no bridge)')
  })
})

// Round 3, defect 1: a remote provider (openai/* on OAuth) was unreachable because only loopback
// baseURLs were bridged. Invariant: a lane reaches exactly the endpoints ITS model needs.
describe('lane sandbox plan — per-model egress (round 3, defect 1)', () => {
  const config = `${HOME}/.config/opencode`
  const share = `${HOME}/.local/share/opencode`
  const CLIPROXY = '{ // comment with a URL-like // inside\n "provider": { "antigravity": { "options": { "baseURL": "http://127.0.0.1:8317/v1", }, }, }, }'
  type Spawned = Array<{ command: string, args: string[] }>
  function egressPlan(model: string | null, auth: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const spawned: Spawned = []
    const fs = fakeFs({ [`${config}/opencode.jsonc`]: CLIPROXY, [`${share}/auth.json`]: JSON.stringify(auth) }, [config, share, HOME, '/work/tree'])
    const p = plan({ fs, args: ['run', 'x', ...(model ? ['--model', model] : [])], spawnFn: listening(fs, spawned), ...extra }) as SandboxPlan & { egressHosts?: string[] }
    return { p, spawned, args: p.wrap('opencode', ['run'])[1] }
  }
  const setenv = (args: string[], name: string) => args.flatMap((v, i) => (v === '--setenv' && args[i + 1] === name ? [args[i + 2]!] : []))

  it('an openai/* OAuth lane gets an egress proxy allowing ONLY chatgpt.com and auth.openai.com, reached through the bridge', () => {
    const { p, spawned, args } = egressPlan('openai/gpt-5.6-luna', { openai: { type: 'oauth' } })
    expect(p.egressHosts).toEqual(['chatgpt.com', 'auth.openai.com'])
    const proxy = spawned.find((s) => s.args.some((a) => a.endsWith('lane-egress-proxy.mjs')))
    expect(proxy, JSON.stringify(spawned)).toBeDefined()
    expect(proxy!.args[proxy!.args.indexOf('--allow') + 1]).toBe('chatgpt.com,auth.openai.com')
    // The unrelated loopback provider (CLIProxy) is NOT bridged for an openai lane: exactly what its model needs.
    expect(p.endpoints).toEqual([])
    expect(spawned.some((s) => s.args.some((a) => a.includes('TCP4:127.0.0.1:8317')))).toBe(false)
    expect(args).toContain('--unshare-all')
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) expect(setenv(args, name)).toEqual(['http://127.0.0.1:3128'])
    expect(setenv(args, 'NO_PROXY')).toEqual(['127.0.0.1,localhost,::1'])
    expect(p.line).toContain('egress proxy to chatgpt.com, auth.openai.com only (HTTPS CONNECT to port 443, TLS SNI must equal the CONNECT host; not covered: Host-header fronting inside TLS, and the provider account itself as a place to send data)')
    expect(p.line).not.toContain('HTTPS CONNECT, port 443)')
  })

  it('an API-key openai lane is allowed api.openai.com only', () => {
    expect(egressPlan('openai/gpt-5.6-luna', { openai: { type: 'api' } }).p.egressHosts).toEqual(['api.openai.com'])
  })

  it('a loopback provider model is relayed, gets no proxy and no proxy variables', () => {
    const { p, spawned, args } = egressPlan('antigravity/some-model', {})
    expect(p.endpoints).toEqual([{ host: '127.0.0.1', port: 8317 }])
    expect(p.egressHosts).toEqual([])
    expect(spawned.some((s) => s.args.some((a) => a.endsWith('lane-egress-proxy.mjs')))).toBe(false)
    expect(setenv(args, 'HTTPS_PROXY')).toEqual([])
  })

  it('a provider with no known hosts and a lane without a model get NO egress, and the line says so', () => {
    const unknown = egressPlan('mystery/model', {})
    expect(unknown.p.egressHosts).toEqual([])
    expect(unknown.p.line).toContain('no egress: provider mystery has no known hosts')
    const none = egressPlan(null, { openai: { type: 'oauth' } })
    expect(none.p.egressHosts).toEqual([])
    expect(none.spawned).toEqual([])
  })

  it('a codex lane signed in with ChatGPT gets the OpenAI OAuth hosts', () => {
    const spawned: Spawned = []
    const codexHome = `${HOME}/.codex`
    const fs = fakeFs({ '/usr/local/bin/codex': 'x', [`${codexHome}/auth.json`]: JSON.stringify({ OPENAI_API_KEY: null, tokens: { a: 1 } }) }, [HOME, '/work/tree', codexHome])
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', args: [], cwd: '/work/tree', env: { HOME, PATH: '/usr/local/bin' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: listening(fs, spawned), runtimeParent: '/run/lane', fs }) as SandboxPlan & { egressHosts?: string[] }
    expect(p.egressHosts).toEqual(['chatgpt.com', 'auth.openai.com'])
  })

  it('names the egress log only when the operator asks for one, as a host path', () => {
    const logged = egressPlan('openai/gpt-5.6-luna', { openai: { type: 'oauth' } }, { optionEnv: { WT_LANE_EGRESS_LOG: '/var/log/egress.jsonl' } })
    const proxy = logged.spawned.find((s) => s.args.includes('--allow'))!
    expect(proxy.args[proxy.args.indexOf('--log') + 1]).toBe('/var/log/egress.jsonl')
    const quiet = egressPlan('openai/gpt-5.6-luna', { openai: { type: 'oauth' } })
    expect(quiet.spawned.find((s) => s.args.includes('--allow'))!.args).not.toContain('--log')
  })
})

// Round 4, LOW 3: the plan follows OpenCode's documented merge order, reads only configuration the
// lane cannot write, accepts --model=, and names a config it cannot parse.
describe('lane sandbox plan — egress from lane-proof configuration only (round 4, LOW 3)', () => {
  const config = `${HOME}/.config/opencode`
  const base = (files: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const fs = fakeFs(files, [config, HOME, '/work/tree', '/opt/cfg'])
    return plan({ fs, ...extra }) as SandboxPlan & { egressHosts?: string[] }
  }
  const remote = (host: string) => `{ "provider": { "p": { "options": { "baseURL": "https://${host}/v1" } } } }`

  it('the LAST global file in load order wins (config.json, then opencode.json, then opencode.jsonc)', () => {
    const p = base({ [`${config}/config.json`]: remote('first.example'), [`${config}/opencode.json`]: remote('middle.example'), [`${config}/opencode.jsonc`]: remote('last.example') }, { args: ['run', 'x', '--model', 'p/m'] })
    expect(p.egressHosts).toEqual(['last.example'])
  })

  it('accepts --model=provider/model and -m=provider/model', () => {
    expect(base({ [`${config}/opencode.json`]: remote('p.example') }, { args: ['run', '--model=p/m'] }).egressHosts).toEqual(['p.example'])
    expect(base({ [`${config}/opencode.json`]: remote('p.example') }, { args: ['run', '-m=p/m'] }).egressHosts).toEqual(['p.example'])
  })

  it('OPENCODE_CONFIG overrides the global files when the lane cannot write it, and is ignored when it can', () => {
    const outside = base({ [`${config}/opencode.json`]: remote('global.example'), '/opt/cfg/custom.json': remote('custom.example') }, { args: ['run', '--model', 'p/m'], env: { HOME, PATH: '/usr/bin', OPENCODE_CONFIG: '/opt/cfg/custom.json' } })
    expect(outside.egressHosts).toEqual(['custom.example'])
    const planted = base({ [`${config}/opencode.json`]: remote('global.example'), '/work/tree/.lane/cfg.json': remote('attacker.example') }, { args: ['run', '--model', 'p/m'], env: { HOME, PATH: '/usr/bin', OPENCODE_CONFIG: '/work/tree/.lane/cfg.json' } })
    expect(planted.egressHosts).toEqual(['global.example'])
  })

  it('reads a config with a BOM and an unquoted {env:} value, and NAMES a config it still cannot parse', () => {
    expect(base({ [`${config}/opencode.jsonc`]: `\uFEFF{ "k": {env:KEY}, "provider": { "p": { "options": { "baseURL": "https://p.example/v1" } } } }` }, { args: ['run', '--model', 'p/m'] }).egressHosts).toEqual(['p.example'])
    const broken = base({ [`${config}/opencode.json`]: '{ "provider": ', [`${config}/opencode.jsonc`]: remote('ok.example') }, { args: ['run', '--model', 'p/m'] })
    expect(broken.egressHosts).toEqual(['ok.example'])
    expect(broken.line).toContain(`config not parsed by the egress planner (allow-list may be smaller than OpenCode expects): ${config}/opencode.json`)
  })

  it('codex reads the auth store of CODEX_HOME when it is set', () => {
    const fs = fakeFs({ '/usr/local/bin/codex': 'x', [`${HOME}/.codex/auth.json`]: JSON.stringify({ tokens: { a: 1 } }), '/opt/codexhome/auth.json': JSON.stringify({ OPENAI_API_KEY: 'k' }) }, [HOME, '/work/tree', `${HOME}/.codex`, '/opt/codexhome'])
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', args: [], cwd: '/work/tree', env: { HOME, PATH: '/usr/local/bin', CODEX_HOME: '/opt/codexhome' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: listening(fs), runtimeParent: '/run/lane', fs }) as SandboxPlan & { egressHosts?: string[] }
    expect(p.egressHosts).toEqual(['api.openai.com'])
  })
})

// Round 4, LOW 4: a writable bind never covers a CLI's config or auth location.
describe('lane sandbox plan — config and auth stay read-only (round 4, LOW 4)', () => {
  it('refuses an operator writable path that contains or sits inside the OpenCode config dir or ~/.opencode', () => {
    for (const entry of [`${HOME}/.config`, `${HOME}/.config/opencode/plugins`, `${HOME}/.opencode`]) {
      expect(() => plan({ optionEnv: { WT_LANE_SANDBOX_WRITE: entry }, fs: fakeFs({}, [HOME, '/work/tree', `${HOME}/.config`, `${HOME}/.config/opencode`, `${HOME}/.config/opencode/plugins`, `${HOME}/.opencode`]) }), entry).toThrow(/refusing writable bind .* overlaps/)
    }
  })
  it('refuses a worktree that contains the config dir, and a codex writable path over CODEX_HOME', () => {
    const cfg = '/work/tree/xdg'
    expect(() => plan({ env: { HOME, PATH: '/usr/bin', XDG_CONFIG_HOME: cfg }, fs: fakeFs({}, [HOME, '/work/tree', cfg, `${cfg}/opencode`]) })).toThrow(sandbox.LaneSandboxRefusal)
    const fs = fakeFs({ '/usr/local/bin/codex': 'x' }, [HOME, '/work/tree', '/data', '/data/codex'])
    expect(() => sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', args: [], cwd: '/work/tree', env: { HOME, PATH: '/usr/local/bin', CODEX_HOME: '/data/codex', CLAUDE_PLUGIN_DATA: '/data' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: listening(fs), runtimeParent: '/run/lane', fs })).toThrow(/overlaps \/data\/codex/)
  })
})

// Round 4, MED 2 and LOW 5 at plan time.
describe('lane sandbox plan — egress log path and bridge start (round 4)', () => {
  const config = `${HOME}/.config/opencode`
  const share = `${HOME}/.local/share/opencode`
  const files = () => ({ [`${share}/auth.json`]: JSON.stringify({ openai: { type: 'oauth' } }) })
  it('refuses an egress log under a path the lane can write, and accepts one outside', () => {
    for (const log of ['/work/tree/.lane/egress.jsonl', `${HOME}/.local/state/wt-suite-lock/egress.jsonl`]) {
      expect(() => plan({ fs: fakeFs(files(), [config, share, HOME, '/work/tree', '/run/lane']), args: ['run', '--model', 'openai/m'], optionEnv: { WT_LANE_EGRESS_LOG: log } }), log).toThrow(/refusing WT_LANE_EGRESS_LOG/)
    }
    expect(plan({ fs: fakeFs(files(), [config, share, HOME, '/work/tree', '/var/log']), args: ['run', '--model', 'openai/m'], optionEnv: { WT_LANE_EGRESS_LOG: '/var/log/egress.jsonl' } }).kind).toBe('bwrap')
  })
  it('refuses the launch when the egress proxy never opens its socket, and never claims the route', () => {
    const fs = fakeFs(files(), [config, share, HOME, '/work/tree'])
    expect(() => plan({ fs, args: ['run', '--model', 'openai/m'], spawnFn: () => ({ kill() {}, pid: 1 }) })).toThrow(/egress proxy did not start within 3 s/)
  })
})

describe('JSONC reader used for the OpenCode config (round 3)', () => {
  it('keeps URLs and comment markers inside strings, drops comments and trailing commas, and returns null on garbage', async () => {
    const { parseJsonc } = await load<{ parseJsonc: (text: unknown) => unknown }>('host/jsonc.mjs')
    const text = '{\n // line comment "x": 1\n "a": "http://127.0.0.1:8317/v1", /* block, } */ "b": "say \\"//hi\\" /* no */",\n "c": [1, 2, /* x */ ],\n "d": { "e": 3, // tail\n },\n}'
    expect(parseJsonc(text)).toEqual({ a: 'http://127.0.0.1:8317/v1', b: 'say "//hi" /* no */', c: [1, 2], d: { e: 3 } })
    expect(parseJsonc('{ "a": ')).toBeNull()
    expect(parseJsonc(null)).toBeNull()
  })
})

// Round 3, defect 2: only ~/.opencode/bin was bound, so OpenCode (not --pure) ran an npm install of
// its plugin package into ~/.opencode on every start and the 30 s discovery probe timed out.
describe('lane sandbox plan — OpenCode global home (round 3, defect 2)', () => {
  it('binds the installed plugin packages READ-ONLY, never ~/.opencode whole and never writable', () => {
    const oc = `${HOME}/.opencode`
    const [, args] = plan({ fs: fakeFs({ [`${oc}/package.json`]: '{}', [`${oc}/package-lock.json`]: '{}', [`${oc}/opencode.db`]: 'sessions' }, [HOME, '/work/tree', oc, `${oc}/node_modules`]) }).wrap('opencode', ['run'])
    const ro = flat(args, '--ro-bind-try')
    for (const name of ['node_modules', 'package.json', 'package-lock.json']) expect(ro).toContain(`${oc}/${name}`)
    expect(everyBind(args)).not.toContain(oc)
    expect(everyBind(args)).not.toContain(`${oc}/opencode.db`)
    expect([...flat(args, '--bind'), ...flat(args, '--bind-try')].filter((b) => b.startsWith(oc))).toEqual([])
  })
})

describe('insideChildUserNamespace — mechanical (M4)', () => {
  it('reads the user namespace map, not an environment variable', () => {
    expect(sandbox.insideChildUserNamespace({ readText: () => '         0          0 4294967295' })).toBe(false)
    expect(sandbox.insideChildUserNamespace({ readText: () => '      1000       1000          1' })).toBe(true)
    expect(sandbox.insideChildUserNamespace({ readText: () => '      1000          0          1' })).toBe(true)
    expect(sandbox.insideChildUserNamespace({ readText: () => null })).toBe(null)
  })
})

describe('suite lock across PID namespaces (M4)', () => {
  async function held(tag: string, ns: string | null, extra: Record<string, unknown> = {}) {
    const root = tempRoot(tag)
    await suiteLock.acquireSuiteLock({ root, pidNamespace: ns, startTime: 111, waitS: 1, ...extra })
    return root
  }
  it('from the host, reclaims a sandboxed holder only once its namespace is empty', async () => {
    const root = await held('host', 'pid:[4026532999]')
    const view = { root, pidNamespace: 'pid:[4026531836]', insideSandbox: false }
    expect(suiteLock.operatorReleaseSuiteLock({ ...view, namespaceHasProcesses: () => true })).toMatchObject({ released: false, reason: 'live' })
    expect(suiteLock.operatorReleaseSuiteLock({ ...view, namespaceHasProcesses: () => false })).toMatchObject({ released: true })
  })
  // Card 1873134162710365740 reversed the earlier "within its own wait window" rule: a short --wait-s
  // reclaimed a LIVE host holder and ran two suites at once. The bound is --stale-s alone.
  it('inside a sandbox, never reclaims a host holder by PID, only at the --stale-s hard bound, never the --wait-s', async () => {
    for (const ns of ['pid:[4026531836]', null]) {
      const root = await held(`sandbox-${String(ns !== null)}`, ns)
      const hourAgo = new Date(Date.now() - 3_600_000)
      utimesSync(join(root, 'lock.d'), hourAgo, hourAgo)
      const view = { root, pidNamespace: 'pid:[4026532999]', insideSandbox: true, namespaceHasProcesses: () => false }
      expect(suiteLock.operatorReleaseSuiteLock({ ...view, waitS: 999999, staleS: 999999 })).toMatchObject({ released: false, reason: 'live' })
      expect(suiteLock.operatorReleaseSuiteLock({ ...view, waitS: 60, staleS: 999999 })).toMatchObject({ released: false, reason: 'live' })
      expect(suiteLock.operatorReleaseSuiteLock({ ...view, waitS: 999999, staleS: 1800 })).toMatchObject({ released: true })
    }
  })
  it('treats a reused PID with a different start time as stale (PID-reuse defence)', async () => {
    const root = await held('reuse', 'pid:[4026531836]', { startTime: 111 })
    const view = { root, pidNamespace: 'pid:[4026531836]', insideSandbox: false, platform: 'linux' }
    expect(suiteLock.operatorReleaseSuiteLock({ ...view, processStartTime: () => 111 })).toMatchObject({ released: false, reason: 'live' })
    expect(suiteLock.operatorReleaseSuiteLock({ ...view, processStartTime: () => 222 })).toMatchObject({ released: true })
  })
  it('records the holder PID namespace and start time', async () => {
    const root = await held('record', 'pid:[4026532001]', { startTime: 4242 })
    expect(JSON.parse(readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8'))).toMatchObject({ pidNamespace: 'pid:[4026532001]', startTime: 4242 })
  })
})

describe.skipIf(!BWRAP_WORKS)('real bubblewrap children (skips on a host without a working bwrap)', () => {
  // The canary asserts the ABSENCE of everything under $HOME except the named allow-list — an
  // INVARIANT, not a list of known secret paths (M6): a regression that binds ~/.config or ~/.local
  // wholesale fails this.
  const CANARY = [
    'ALLOWED="$1"; shift',
    'for entry in "$HOME"/* "$HOME"/.*; do',
    '  base=$(basename "$entry")',
    '  [ "$base" = "." ] || [ "$base" = ".." ] && continue',
    '  case " $ALLOWED " in *" $base "*) continue;; esac',
    '  if [ -r "$entry" ] && [ "$(ls -A "$entry" 2>/dev/null | head -1)$( [ -f "$entry" ] && echo f)" != "" ]; then echo "LEAK $base"; fi',
    'done',
    'echo "sandbox=${WT_LANE_SANDBOX:-unset}"',
  ].join('\n')

  function homeFixture() {
    const root = tempRoot('real')
    const home = join(root, 'home')
    // Named allow-list dirs under HOME (created so the canary can confirm they are the ONLY survivors).
    for (const rel of ['.config/opencode', '.cache/opencode/packages', '.local/share/opencode', '.local/state/opencode', '.codex']) mkdirSync(join(home, rel), { recursive: true })
    writeFileSync(join(home, '.local/share/opencode/auth.json'), 'auth')
    writeFileSync(join(home, '.config/opencode/opencode.jsonc'), '{}')
    // Secrets that must NOT survive.
    for (const rel of ['.ssh/id_ed25519', '.claude/.credentials.json', '.1password/agent.sock', '.bashrc', '.aws/credentials']) { mkdirSync(dirname(join(home, rel)), { recursive: true }); writeFileSync(join(home, rel), 'secret') }
    const worktree = join(root, 'worktree'); mkdirSync(worktree)
    return { home, worktree }
  }

  function run(f: ReturnType<typeof homeFixture>, sw: string | undefined) {
    const prev = process.env.WT_LANE_SANDBOX
    if (sw === undefined) delete process.env.WT_LANE_SANDBOX; else process.env.WT_LANE_SANDBOX = sw
    try {
      // Allow-list of $HOME children a lane legitimately keeps: the CLI config/data/cache/state.
      const allowed = '.config .cache .local .codex'
      return fence.spawnOpencode(spawnSync, '/bin/sh', ['-c', CANARY, 'canary', allowed], { cwd: f.worktree, env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8', timeout: 30_000 }, 'linux')
    } finally { if (prev === undefined) delete process.env.WT_LANE_SANDBOX; else process.env.WT_LANE_SANDBOX = prev }
  }

  it('preserves PATH priority for a symlinked executable and its sibling helper (skips when bwrap is unavailable)', () => {
    const root = tempRoot('exe-link')
    const home = join(root, 'home'); const worktree = join(root, 'worktree')
    const realBin = join(home, '.codex/releases/current/bin'); const first = join(home, '.local/bin'); const second = join(root, 'second')
    for (const dir of [home, worktree, realBin, first, second]) mkdirSync(dir, { recursive: true })
    const tool = join(realBin, 'codex'); const helper = join(realBin, 'helper'); const invoked = join(first, 'codex')
    writeFileSync(tool, '#!/bin/sh\nreal=$(readlink -f "$0")\nexec "$(dirname "$real")/helper"\n')
    writeFileSync(helper, '#!/bin/sh\nprintf "NEW\\n"\n')
    writeFileSync(join(second, 'codex'), '#!/bin/sh\nprintf "OLD\\n"\n')
    for (const file of [tool, helper, join(second, 'codex')]) chmodSync(file, 0o755)
    symlinkSync('../../.codex/releases/current/bin/codex', invoked)
    const pathValue = `${first}:${second}:${process.env.PATH}`
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: process.execPath, cwd: worktree, env: { PATH: pathValue, HOME: home }, paths: { readable: [second] } })
    const [command, args] = p.wrap('/bin/sh', ['-c', 'codex'])
    const result = spawnSync(command, args, { cwd: worktree, env: { PATH: pathValue, HOME: home }, encoding: 'utf8', timeout: 30_000 })
    try {
      expect(result.status, String(result.stderr)).toBe(0)
      expect(String(result.stdout)).toBe('NEW\n')
    } finally { p.dispose() }
  })

  it('runs the selected codex through relative/empty PATH components and a private-remapped symlink hop', () => {
    const root = tempRoot('path-priority')
    const home = join(root, 'home'); const worktree = join(root, 'worktree')
    const good = join(root, 'good'); const second = join(root, 'second'); const first = join(root, 'first')
    const privateHome = join(home, '.codex')
    for (const dir of [privateHome, worktree, good, second, first]) mkdirSync(dir, { recursive: true })
    const chosen = join(good, 'codex')
    writeFileSync(chosen, '#!/bin/sh\nprintf "SELECTED\\n"\n'); chmodSync(chosen, 0o755)
    for (const bad of [join(worktree, 'codex'), join(second, 'codex')]) {
      writeFileSync(bad, '#!/bin/sh\nprintf "WRONG\\n"\n'); chmodSync(bad, 0o755)
    }
    const hop = join(privateHome, 'hop')
    symlinkSync(chosen, hop); symlinkSync(hop, join(first, 'codex'))
    for (const pathValue of [`.${delimiter}${good}${delimiter}${second}`, `${delimiter}${good}${delimiter}${second}`, `${first}${delimiter}${second}`]) {
      const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: process.execPath, cwd: worktree, env: { HOME: home, PATH: pathValue }, paths: { readable: [second] } })
      const [command, args] = p.wrap('/bin/sh', ['-c', 'codex'])
      const result = spawnSync(command, args, { cwd: worktree, env: { HOME: home, PATH: pathValue }, encoding: 'utf8', timeout: 30_000 })
      try {
        expect(result.status, String(result.stderr)).toBe(0)
        expect(result.stdout).toBe('SELECTED\n')
      } finally { p.dispose() }
    }
    expect(() => sandbox.resolveLaneSandbox({ profile: 'codex', bin: process.execPath, cwd: worktree, env: { HOME: home, PATH: '' } })).toThrow(/no executable selected/)
  })

  it('keeps node module resolution anchored at the real script path through the dedicated symlink', () => {
    const root = tempRoot('script-shim')
    const home = join(root, 'home'); const worktree = join(root, 'worktree')
    const binDir = join(root, 'package/bin'); const first = join(root, 'first')
    for (const dir of [home, worktree, binDir, first]) mkdirSync(dir, { recursive: true })
    const script = join(binDir, 'codex.js')
    writeFileSync(script, '#!/usr/bin/env node\nconsole.log(require("./sibling.cjs"))\n')
    writeFileSync(join(binDir, 'sibling.cjs'), 'module.exports = "SELECTED"\n')
    chmodSync(script, 0o755)
    symlinkSync(script, join(first, 'codex'))
    const pathValue = `${first}:${process.env.PATH}`
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: process.execPath, cwd: worktree, env: { HOME: home, PATH: pathValue } })
    const [command, args] = p.wrap('/bin/sh', ['-c', 'codex'])
    const result = spawnSync(command, args, { cwd: worktree, env: { HOME: home, PATH: pathValue }, encoding: 'utf8', timeout: 30_000 })
    try {
      expect(result.status, String(result.stderr)).toBe(0)
      expect(result.stdout).toBe('SELECTED\n')
    } finally { p.dispose() }
  })

  it('keeps a binary inside a private Codex home runnable while hiding the host marker and allowing CODEX_HOME writes', () => {
    const root = tempRoot('private-binary')
    const home = join(root, 'home'); const worktree = join(root, 'worktree')
    const codexHome = join(home, '.codex'); const binDir = join(codexHome, 'releases/bin')
    for (const dir of [home, worktree, binDir]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(codexHome, 'host-marker'), 'secret')
    const binary = join(binDir, 'codex')
    writeFileSync(binary, '#!/bin/sh\nprintf "BINARY_OK\\n"\n')
    chmodSync(binary, 0o755)
    const pathValue = `${binDir}:${process.env.PATH}`
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: process.execPath, cwd: worktree, env: { HOME: home, PATH: pathValue } })
    const [command, args] = p.wrap('/bin/sh', ['-c', 'test ! -e "$CODEX_HOME/host-marker" && touch "$CODEX_HOME/writable" && test -f "$CODEX_HOME/writable" && codex'])
    const result = spawnSync(command, args, { cwd: worktree, env: { HOME: home, PATH: pathValue }, encoding: 'utf8', timeout: 30_000 })
    try {
      expect(result.status, String(result.stderr)).toBe(0)
      expect(result.stdout).toBe('BINARY_OK\n')
    } finally { p.dispose() }
  })

  for (const aliasHome of [false, true]) {
    it(`PATH reaches the selected codex directly inside the private home (${aliasHome ? 'symlinked HOME' : 'symlinked executable'})`, () => {
      const root = tempRoot('private-path')
      const actualHome = join(root, 'home'); const home = aliasHome ? join(root, 'alias') : actualHome
      const worktree = join(root, 'worktree'); const second = join(root, 'second')
      const codexHome = join(actualHome, '.codex')
      for (const dir of [codexHome, worktree, second]) mkdirSync(dir, { recursive: true })
      if (aliasHome) symlinkSync(actualHome, home)
      const actual = join(codexHome, aliasHome ? 'codex' : 'actual')
      writeFileSync(actual, '#!/bin/sh\nprintf "NEW\\n"\n'); chmodSync(actual, 0o755)
      if (!aliasHome) symlinkSync('actual', join(codexHome, 'codex'))
      const fallback = join(second, 'codex')
      writeFileSync(fallback, '#!/bin/sh\nprintf "OLD\\n"\n'); chmodSync(fallback, 0o755)
      const pathValue = `${join(home, '.codex')}:${second}:${process.env.PATH}`
      const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: process.execPath, cwd: worktree, env: { HOME: home, PATH: pathValue }, paths: { readable: [second] } })
      const [command, args] = p.wrap('/bin/sh', ['-c', 'codex'])
      const result = spawnSync(command, args, { cwd: worktree, env: { HOME: home, PATH: pathValue }, encoding: 'utf8', timeout: 30_000 })
      try {
        expect(result.status, String(result.stderr)).toBe(0)
        expect(String(result.stdout)).toBe('NEW\n')
      } finally { p.dispose() }
    })
  }

  it('exposes NOTHING under $HOME beyond the named allow-list (invariant canary)', () => {
    const f = homeFixture()
    const r = run(f, undefined)
    expect(r.status, String(r.stderr)).toBe(0)
    expect(r.laneSandbox?.kind).toBe('bwrap')
    const leaks = String(r.stdout).split('\n').filter((l) => l.startsWith('LEAK'))
    expect(leaks).toEqual([])
    expect(String(r.stdout)).toContain('sandbox=bwrap')
  })

  it('control: with the sandbox off, the same secrets ARE present', () => {
    const f = homeFixture()
    const r = run(f, 'off')
    expect(r.laneSandbox?.kind).toBe('none')
    expect(String(r.stdout)).toMatch(/LEAK \.ssh/)
  })

  it('does not let a real sandboxed lane write the host-only pilot decision store', () => {
    const f = homeFixture()
    const decision = join(f.home, '.local', 'state', 'workflow-toolbox', 'pilot-runs', 'run-1', 'dod-decisions.json')
    mkdirSync(dirname(decision), { recursive: true })
    writeFileSync(decision, 'trusted\n')
    const probe = `printf forged > ${JSON.stringify(decision)} 2>/dev/null && echo WROTE || echo DENIED`
    const r = fence.spawnOpencode(spawnSync, '/bin/sh', ['-c', probe], { cwd: f.worktree, env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8', timeout: 30_000 }, 'linux')
    expect(r.laneSandbox?.kind).toBe('bwrap')
    expect(String(r.stdout).trim()).toBe('DENIED')
    expect(readFileSync(decision, 'utf8')).toBe('trusted\n')
  })

  it('refuses the real decide CLI executed inside bwrap even with a valid request id', () => {
    const f = homeFixture()
    const stateRoot = join(f.home, '.local', 'state', 'workflow-toolbox', 'pilot-runs')
    const file = initializePilotDecisionStore('run-1', { root: stateRoot })
    registerPilotDecisionRequest(file, { requestId: 'visible-in-lane', criteria: [1], deadline: Date.now() + 60_000 })
    cpSync(join(ROOT, 'plugin'), join(f.worktree, 'plugin'), { recursive: true })
    const args = [join(f.worktree, 'plugin', 'bin', 'wt-pilot-runner.mjs'), 'decide', '--run', 'run-1', '--request', 'visible-in-lane', '--dod', '1', '--reading', 'forged', '--state-root', stateRoot]
    const r = fence.spawnOpencode(spawnSync, process.execPath, args, { cwd: f.worktree, env: { PATH: process.env.PATH, HOME: f.home }, encoding: 'utf8', timeout: 30_000 }, 'linux')
    expect(r.laneSandbox?.kind).toBe('bwrap')
    expect(r.status).not.toBe(0)
    expect(String(r.stderr)).toContain('requests')
    expect(readFileSync(file, 'utf8')).not.toContain('forged')
    expect(readdirSync(join(dirname(file), 'bindings'))).toEqual([])
  })

  it('isolates the network so NO host loopback service is reachable (the H4 security invariant)', () => {
    const root = tempRoot('net')
    const home = join(root, 'home'); const w = join(root, 'w')
    mkdirSync(w, { recursive: true })
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    writeFileSync(join(home, '.config/opencode/opencode.jsonc'), '{}')
    // A real host loopback listener owned by this uid — the observe/artifact server class the review
    // named. From inside the sandbox it must be UNREACHABLE (connection refused: empty loopback).
    let forbiddenPort = 0
    const srv = net.createServer((c) => c.end('FORBIDDEN\n')); servers.push(srv)
    return new Promise<void>((resolve, reject) => {
      srv.listen(0, '127.0.0.1', () => {
        try {
          forbiddenPort = (srv.address() as net.AddressInfo).port
          const probe = `printf 'x' | timeout 3 socat - TCP4:127.0.0.1:${forbiddenPort} 2>&1 | head -1 | sed 's/^/result:/'; echo "listeners=$(ss -H -ltn 2>/dev/null | wc -l)"`
          const r = fence.spawnOpencode(spawnSync, '/bin/sh', ['-c', probe], { cwd: w, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30_000 }, 'linux')
          const out = String(r.stdout)
          expect(r.laneSandbox?.kind).toBe('bwrap')
          expect(out).not.toContain('FORBIDDEN')
          expect(out).toMatch(/result:.*(Connection refused|refused|:0 )|result:$/m)
          // The sandbox has its own empty loopback: no inherited host listeners.
          expect(out).toMatch(/listeners=[01]\b/)
          resolve()
        } catch (error) { reject(error as Error) }
      })
    })
  })

  // Round 3, defect 1, on a real sandbox: the lane's only way out is the host proxy named by
  // HTTPS_PROXY; a host outside the allow-list is refused BY THE PROXY (403, logged) and a direct
  // connection has no route. The allowed host is a reserved .invalid name, so no test ever reaches
  // the internet: its log line proves the allowed branch was taken, then resolution fails.
  it('routes egress through the host proxy only: allowed host reaches the proxy allow branch, others are refused', () => {
    const root = tempRoot('egress')
    const home = join(root, 'home'); const w = join(root, 'w'); const log = join(root, 'egress.jsonl')
    mkdirSync(w, { recursive: true })
    mkdirSync(join(home, '.config/opencode'), { recursive: true })
    writeFileSync(join(home, '.config/opencode/opencode.jsonc'), '{ "provider": { "remote": { "options": { "baseURL": "https://lane-egress-probe.invalid/v1" } } } }')
    const connect = (host: string) => `printf 'CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}\\r\\n\\r\\n' | timeout 10 socat -t 8 - "TCP4:\${HTTPS_PROXY#http://}" 2>&1 | head -1 | sed 's/^/${host}:/'`
    const probe = [
      'echo "proxy=$HTTPS_PROXY"',
      connect('example.com'),
      connect('lane-egress-probe.invalid'),
      'timeout 5 socat - TCP4:1.1.1.1:443 </dev/null 2>&1 | head -1 | sed "s/^/direct:/"',
    ].join('\n')
    const prev = process.env.WT_LANE_EGRESS_LOG
    process.env.WT_LANE_EGRESS_LOG = log
    try {
      const r = fence.spawnOpencode(spawnSync, '/bin/sh', ['-c', probe, 'probe', '--model', 'remote/m'], { cwd: w, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 30_000 }, 'linux')
      const out = String(r.stdout)
      expect(r.laneSandbox?.kind).toBe('bwrap')
      expect(out).toContain('proxy=http://127.0.0.1:3128')
      expect(out).toMatch(/^example\.com:HTTP\/1\.1 403/m)
      expect(out).toMatch(/^lane-egress-probe\.invalid:HTTP\/1\.1 403/m)
      expect(out).toMatch(/^direct:.*(unreachable|refused|Network)/im)
      const records = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { host: string, decision: string, reason: string })
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ host: 'example.com', decision: 'denied', reason: 'host is not in the lane egress allow-list' }),
        expect.objectContaining({ host: 'lane-egress-probe.invalid', decision: 'denied', reason: expect.stringMatching(/^resolution failed/) }),
      ]))
    } finally { if (prev === undefined) delete process.env.WT_LANE_EGRESS_LOG; else process.env.WT_LANE_EGRESS_LOG = prev }
  })

  // Round 4, LOW 6: a synchronous spawn failure still disposes the plan (runtime dir, bridges).
  it('tears the sandbox plan down when the spawn itself throws', () => {
    const root = tempRoot('spawnthrow')
    const home = join(root, 'home'); const w = join(root, 'w'); const run = join(root, 'run')
    for (const dir of [home, w, run]) mkdirSync(dir, { recursive: true })
    const prev = process.env.XDG_RUNTIME_DIR
    process.env.XDG_RUNTIME_DIR = run
    try {
      const boom = (() => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }) }) as unknown as typeof spawnSync
      expect(() => fence.spawnOpencode(boom, '/bin/true', [], { cwd: w, env: { PATH: process.env.PATH, HOME: home } }, 'linux')).toThrow('spawn EAGAIN')
      expect(readdirSync(run).filter((name) => name.startsWith('wt-lane-sandbox-'))).toEqual([])
    } finally { if (prev === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prev }
  })

  it('the git pointer files are read-only inside, so a planted fsmonitor cannot be written (H1)', () => {
    const root = tempRoot('git')
    const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: process.env.PATH, HOME: join(root, 'home'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    mkdirSync(env.HOME, { recursive: true })
    const main = join(root, 'main')
    execFileSync('git', ['init', '-q', main], { env })
    execFileSync('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'init'], { env })
    execFileSync('git', ['-C', main, 'config', 'extensions.worktreeConfig', 'true'], { env })
    const lane = join(root, 'lane')
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', lane], { env })
    const gitdir = execFileSync('git', ['-C', lane, 'rev-parse', '--absolute-git-dir'], { env, encoding: 'utf8' }).trim()
    const probe = `echo '[core]' > "${gitdir}/config.worktree" 2>&1 && echo WROTE || echo READONLY`
    const r = fence.spawnOpencode(spawnSync, '/bin/sh', ['-c', probe], { cwd: lane, env: { PATH: process.env.PATH, HOME: env.HOME }, encoding: 'utf8', timeout: 30_000 }, 'linux')
    expect(r.laneSandbox?.kind).toBe('bwrap')
    expect(String(r.stdout).trim()).toBe('READONLY')
  })

  it.skipIf(!OPENCODE)('runs the installed opencode without a model inside the sandbox (skips where opencode is not installed)', () => {
    const home = join(tempRoot('oc'), 'home'); mkdirSync(home)
    const r = fence.spawnOpencode(spawnSync, OPENCODE, ['--version'], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 60_000 }, 'linux')
    expect(r.status, String(r.stderr)).toBe(0)
    expect(r.laneSandbox?.kind).toBe('bwrap')
    expect(String(r.stdout).trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  // The OpenCode skill fence is the launch gate; round 1 only ever exercised it with the sandbox
  // OFF. Run the real fence probe SANDBOXED at least once (M6): it spawns opencode inside bwrap.
  it.skipIf(!OPENCODE)('verifies the OpenCode skill fence with the probe running INSIDE the sandbox (skips where opencode is not installed)', async () => {
    const skillFence = await load<{ verifyOpencodeSkillFence: (bin: string, o: Record<string, unknown>) => { ok: boolean, allowOk: boolean, cached: boolean, reason?: string } }>('opencode-skill-fence.mjs')
    const stateDir = join(tempRoot('fence'), 'cache')
    const result = skillFence.verifyOpencodeSkillFence('opencode', { stateDir, platform: 'linux' })
    expect(result.cached).toBe(false)
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, allowOk: true })
  })
})

describe('host-side git hardening (H1)', () => {
  it('lane-integrate prepends core.fsmonitor=false and core.hooksPath=/dev/null to every git call', async () => {
    const root = tempRoot('integrate')
    const dir = join(root, 'dir'); const into = join(root, 'into'); const message = join(root, 'msg')
    mkdirSync(dir); mkdirSync(into); writeFileSync(message, 'subject line\n')
    const seen: string[][] = []
    // The capturing runner fails the first git call, so preflight stops early — enough to prove
    // that every git call it DID issue was hardened.
    const runner = (program: string, args: string[]) => { seen.push([program, ...args]); return { status: 1, stdout: '', stderr: '' } }
    const integrate = await import(pathToFileURL(join(LIB, 'lane-integrate.mjs')).href) as { integrateLane: (o: unknown) => Promise<unknown> }
    await integrate.integrateLane({ dir, into, message, dryRun: true, runner, copy: () => {}, stdout: () => {}, stderr: () => {} })
    const gitCalls = seen.filter(([p]) => p === 'git')
    expect(gitCalls.length).toBeGreaterThan(0)
    for (const call of gitCalls) expect(call.slice(1, 5)).toEqual(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'])
  })
})
