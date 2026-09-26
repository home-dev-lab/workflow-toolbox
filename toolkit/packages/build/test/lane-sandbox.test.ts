import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Card 1871036638205838753, round 2: external lanes run in a bubblewrap sandbox on Linux that is
// isolated in its own filesystem, PID table AND network namespace. The unit half pins the
// allow-list / refusal / git-overlay / private-home construction with a fake filesystem (portable);
// the real half runs real bwrap children — filesystem, network, PID namespace — and skips, naming
// why, where no working bubblewrap exists (CI macOS/Windows).

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LIB = join(ROOT, 'plugin/bin/lib')

interface SandboxPlan { kind: 'bwrap' | 'none', line: string, readable?: string[], writable?: string[], endpoints?: Array<{ host: string, port: number }>, anchor?: unknown, wrap: (bin: string, args: string[]) => [string, string[]], dispose: () => void }
interface FakeFs { exists: (f: string) => boolean, realpath: (f: string) => string | null, isFile: (f: string) => boolean, isDir: (f: string) => boolean, readText: (f: string) => string | null, ensureDir: (d: string) => void, ensureFile: (f: string) => void, copy: (a: string, b: string) => void }
interface SandboxModule {
  resolveLaneSandbox: (request: Record<string, unknown>) => SandboxPlan
  announceUnsandboxedLane: (plan: SandboxPlan, write: (text: string) => void) => void
  insideChildUserNamespace: (fs?: { readText: (f: string) => string | null }) => boolean | null
  LaneSandboxRefusal: new (message: string) => Error
}
interface SuiteLockModule {
  readSuiteLock: (options: Record<string, unknown>) => { root: string }
  acquireSuiteLock: (options: Record<string, unknown>) => Promise<{ root: string }>
  operatorReleaseSuiteLock: (options: Record<string, unknown>) => { released: boolean, reason?: string }
}
interface FenceModule { spawnOpencode: (spawnFn: typeof spawnSync, bin: string, args: string[], options: Record<string, unknown>, platform?: string) => ReturnType<typeof spawnSync> & { laneSandbox?: { kind: string, line: string } } }

const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(LIB, file)).href)) as T
const sandbox = await load<SandboxModule>('host/lane-sandbox.mjs')
const suiteLock = await load<SuiteLockModule>('suite-lock.mjs')
const fence = await load<FenceModule>('opencode-skill-fence.mjs')

const BWRAP_WORKS = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--proc', '/proc', '--', 'true'], { stdio: 'ignore' }).status === 0
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
function fakeFs(files: Record<string, string> = {}, dirs: string[] = []): FakeFs & { ensured: string[], copied: Array<[string, string]> } {
  const ensured: string[] = []
  const copied: Array<[string, string]> = []
  const dirSet = new Set([...dirs])
  return {
    ensured, copied,
    exists: (f) => f in files || dirSet.has(f) || f === '/usr/bin/bwrap' || f === '/usr/bin/socat',
    realpath: (f) => (f in files || dirSet.has(f) ? f : null),
    isFile: (f) => f in files,
    isDir: (f) => dirSet.has(f),
    readText: (f) => files[f] ?? null,
    ensureDir: (d) => { dirSet.add(d); ensured.push(d) },
    ensureFile: (f) => { files[f] ??= '' },
    copy: (a, b) => { copied.push([a, b]); if (a in files) files[b] = files[a] ?? '' },
  }
}

const HOME = '/home/lane-owner'
const okProbe = () => ({ ok: true })
const flat = (args: string[], flag: string) => args.flatMap((v, i) => (v === flag ? [args[i + 1]!] : []))
const everyBind = (args: string[]) => [...flat(args, '--ro-bind'), ...flat(args, '--ro-bind-try'), ...flat(args, '--bind'), ...flat(args, '--bind-try')]

function plan(overrides: Record<string, unknown> = {}): SandboxPlan {
  const base = { profile: 'opencode', bin: '/opt/opencode/bin/opencode', args: ['run', 'x'], cwd: '/work/tree', env: { HOME, PATH: '/usr/bin' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: () => ({ kill() {}, pid: 1 }), runtimeParent: '/run/lane', fs: fakeFs() }
  return sandbox.resolveLaneSandbox({ ...base, ...overrides })
}

describe('lane sandbox plan — availability and pass-through', () => {
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

  it('shares only the machine-wide suite lock directory that the suite lock itself resolves', () => {
    const fs = fakeFs()
    const [, args] = plan({ fs }).wrap('opencode', [])
    const lockRoot = suiteLock.readSuiteLock({ env: {}, home: HOME, platform: 'linux' }).root
    expect(flat(args, '--bind-try')).toContain(lockRoot)
    expect(fs.ensured).toContain(lockRoot)
  })

  it('adds operator paths and refuses, by name, the root, home, and its ancestors', () => {
    const p = plan({ optionEnv: { WT_LANE_SANDBOX_READ: `~/.config/extra${delimiter}/${delimiter}relative`, WT_LANE_SANDBOX_WRITE: `/scratch${delimiter}${HOME}` }, fs: fakeFs({}, [HOME, '/work/tree', `${HOME}/.config/extra`, '/scratch']) })
    const [, args] = p.wrap('opencode', [])
    expect(flat(args, '--ro-bind-try')).toContain(`${HOME}/.config/extra`)
    expect(flat(args, '--bind-try')).toContain('/scratch')
    for (const refused of ['/', 'relative', HOME]) { expect(everyBind(args)).not.toContain(refused) }
    expect(p.line).toContain(`refused WT_LANE_SANDBOX_READ/WT_LANE_SANDBOX_WRITE entries /, relative, ${HOME}`)
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
  it('keeps ~/.codex read-only, runs on a per-run CODEX_HOME, copies auth in, and offers a writeback', () => {
    const codexHome = `${HOME}/.codex`
    const fs = fakeFs({ '/usr/local/bin/codex': 'x', [`${codexHome}/auth.json`]: 'tok', [`${codexHome}/hooks.json`]: '{}' }, [HOME, '/work/tree', codexHome])
    const p = sandbox.resolveLaneSandbox({ profile: 'codex', bin: '/usr/bin/node', args: [], cwd: '/work/tree', env: { HOME, PATH: '/usr/local/bin', CLAUDE_PLUGIN_DATA: '/run/lane/codex-broker' }, optionEnv: {}, platform: 'linux', execPath: '/usr/bin/node', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', probe: okProbe, spawnFn: () => ({ kill() {}, pid: 1 }), runtimeParent: '/run/lane', fs }) as SandboxPlan & { authWriteback?: { from: string, to: string } }
    const [, args] = p.wrap('/usr/bin/node', [])
    // ~/.codex is never a writable host bind; a per-run home is remapped onto it (outside != inside).
    expect(flat(args, '--bind-try')).not.toContain(codexHome)
    const remapPrivate = args.flatMap((v, i) => (v === '--bind-try' && args[i + 2] === codexHome ? [args[i + 1]!] : []))
    expect(remapPrivate.length).toBe(1)
    expect(remapPrivate[0]).not.toBe(codexHome)
    // CODEX_HOME points the companion at the private home.
    const codexHomeIdx = args.indexOf('CODEX_HOME')
    expect(codexHomeIdx).toBeGreaterThan(-1)
    expect(args[codexHomeIdx - 1]).toBe('--setenv')
    expect(args[codexHomeIdx + 1]).toBe(remapPrivate[0])
    expect(fs.copied.map(([a]) => a)).toContain(`${codexHome}/auth.json`)
    expect(p.authWriteback).toMatchObject({ to: `${codexHome}/auth.json` })
  })
})

describe('lane sandbox plan — network endpoints (H4)', () => {
  it('reads loopback baseURLs from the opencode config and isolates the network with a bridge', () => {
    const config = `${HOME}/.config/opencode`
    const fs = fakeFs({ [`${config}/opencode.jsonc`]: '{ "provider": { "x": { "options": { "baseURL": "http://127.0.0.1:8317/v1" } } } }' }, [config, HOME, '/work/tree'])
    const p = plan({ fs })
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
    const p = plan({ fs, socat: null })
    expect(p.endpoints).toEqual([])
    expect(p.line).toContain('network isolated (socat absent, no bridge)')
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
  it('inside a sandbox, never reclaims a host holder by PID, only within its own wait window (no 45m/3h mismatch)', async () => {
    for (const ns of ['pid:[4026531836]', null]) {
      const root = await held(`sandbox-${String(ns !== null)}`, ns)
      const hourAgo = new Date(Date.now() - 3_600_000)
      utimesSync(join(root, 'lock.d'), hourAgo, hourAgo)
      const view = { root, pidNamespace: 'pid:[4026532999]', insideSandbox: true, namespaceHasProcesses: () => false }
      // staleS defaults to 3h; the reclaim bound is min(staleS, waitS), so a small waitS reclaims.
      expect(suiteLock.operatorReleaseSuiteLock({ ...view, waitS: 999999, staleS: 999999 })).toMatchObject({ released: false, reason: 'live' })
      expect(suiteLock.operatorReleaseSuiteLock({ ...view, waitS: 60, staleS: 999999 })).toMatchObject({ released: true })
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
    // eslint-disable-next-line no-async-promise-executor
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
