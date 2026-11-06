import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime module
import { cleanup, fixtureRoot, loadedVersionModule, procTree, profileDir, serverScript } from '../../../test-support/loaded-version-fixture.mjs'

const scan = await import(/* @vite-ignore */ loadedVersionModule('bin/lib/loaded-version/scan.mjs')).catch(() => null)
const report = await import(/* @vite-ignore */ loadedVersionModule('bin/lib/loaded-version/report.mjs')).catch(() => null)
const census = await import(/* @vite-ignore */ loadedVersionModule('bin/lib/loaded-version/census.mjs')).catch(() => null)
const { hostLoadedVersionFiles: hostFiles } = await import(/* @vite-ignore */ loadedVersionModule('bin/lib/host/loaded-version-files.mjs'))
const procfsModule = await import(/* @vite-ignore */ loadedVersionModule('bin/lib/host/procfs.mjs'))

const SELF = 900
const SID_A = '11111111-2222-4333-8444-555555555555'
const SID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const trees: Array<{ root: string, locked?: string[] }> = []
afterEach(() => { for (const tree of trees.splice(0)) cleanup(tree) })

type Row = Record<string, unknown> & { pid: number, ppid: number, comm: string }

function world() {
  const root = fixtureRoot()
  const home = profileDir(root, 'user/.claude', 'demo', ['1.0.0', '1.0.1'])
  const work = profileDir(root, 'user/.claude-work', 'demo', ['1.0.0', '1.0.1'])
  return { root, home, work }
}

function session(pid: number, profile: string, sessionId: string | null): Row {
  const fds = [profile, '/dev/null']
  if (sessionId) fds.push(`/tmp/claude-1000/-home-project/${sessionId}/tasks`)
  return { pid, ppid: 1, comm: 'claude', exe: '/opt/claude/versions/2.1.318', cwd: '/home/project', fds }
}

function server(pid: number, ppid: number, script: string, extra: Partial<Row> = {}): Row {
  return { pid, ppid, comm: 'MainThread', argv: ['node', script, '--token=argv-secret-value'], cwd: '/', ...extra }
}

function recordingProcfs(proc: string) {
  const reads: string[] = []
  const log = <T extends (...args: never[]) => unknown>(reader: T) => ((path: string, ...rest: unknown[]) => {
    reads.push(path); return (reader as (...a: unknown[]) => unknown)(path, ...rest)
  })
  const procfs = procfsModule.createProcfs({
    root: proc, platform: 'linux', readFile: log(readFileSync), readdir: log(readdirSync),
    readlink: log(readlinkSync), realpath: log(realpathSync), stat: log(statSync), exists: log(existsSync),
  })
  return { procfs, reads }
}

function run(w: ReturnType<typeof world>, processes: Row[], options: Record<string, unknown> = {}) {
  const tree = procTree(w.root, { selfPid: SELF, processes, ...(options.tree as object ?? {}) })
  trees.push(tree)
  const { procfs, reads } = recordingProcfs(tree.proc)
  const lookups: Array<[string, string]> = []
  const files = {
    isDirectory: (path: string) => { lookups.push(['isDirectory', path]); return hostFiles.isDirectory(path) },
    realpath: (path: string) => { lookups.push(['realpath', path]); return hostFiles.realpath(path) },
  }
  const result = scan!.checkLoadedVersions({
    plugin: 'demo', expect: '1.0.1', procfs, platform: 'linux', selfPid: SELF, uid: process.getuid!(), env: {}, files, ...options,
  })
  return { result, reads, lookups, text: report!.renderText(result) as string }
}

describe.skipIf(process.platform === 'win32')('loaded-version check', () => {
  it('ships the scanner and the report renderer', () => {
    expect(scan, 'scan module must ship').not.toBeNull()
    expect(report, 'report module must ship').not.toBeNull()
  })

  it('exit 0 when every session on both profiles loads the expected version', () => {
    const w = world()
    const { result, text } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.1')),
    ])
    expect(result.exitCode).toBe(0)
    expect(result.sessions.map((s: { status: string }) => s.status)).toEqual(['current', 'current'])
    expect(result.sessions.map((s: { profile: string }) => s.profile).sort()).toEqual([w.home, w.work].sort())
    expect(text.split('\n')[0]).toMatch(/^loaded-version: plugin=demo expect=1\.0\.1 sessions=2 current=2 stale=0 absent=0 unknown=0 EXIT=0$/)
  })

  it('exit 1 lists the stale session with its id, profile and loaded version', () => {
    const w = world()
    const { result, text } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.0')),
    ])
    expect(result.exitCode).toBe(1)
    expect(text).toContain(`stale session=${SID_B} profile=${w.work} pid=200 version=1.0.0`)
  })

  it('a session that holds two server versions (a reload beside the old one) is stale', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')), server(102, 100, serverScript(w.home, '1.0.0')),
    ])
    expect(result.exitCode).toBe(1)
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0', '1.0.1'] })
  })

  it('reads the version from the process path even when the old version directory was deleted', () => {
    const w = world()
    const gone = serverScript(w.home, '0.9.0')
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, gone)])
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['0.9.0'] })
  })

  it('resolves a relative script path against the process working directory', () => {
    const w = world()
    const pluginDir = join(w.home, 'plugins', 'cache', 'market', 'demo')
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, './1.0.0/start.mjs', { cwd: pluginDir })])
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0'] })
  })

  it('counts a grandchild of a server, so an old grandchild makes the session stale', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      server(102, 101, serverScript(w.home, '1.0.0'), { comm: 'bun' }),
    ])
    expect(result.exitCode).toBe(1)
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0', '1.0.1'] })
  })

  it('a launcher child that is not the plugin cannot hide a stale server below it', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), { pid: 101, ppid: 100, comm: 'node', argv: ['node', '/opt/wrapper.mjs'], cwd: '/' },
      server(102, 101, serverScript(w.home, '1.0.0')),
    ])
    expect(result.exitCode).toBe(1)
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0'] })
  })

  it('never counts a plugin path under a shell child (the Bash tool or a hook)', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      { pid: 103, ppid: 100, comm: 'zsh', argv: ['zsh', '-c', 'cat "$1"', 'sh', serverScript(w.home, '1.0.0')], cwd: '/' },
      server(104, 103, serverScript(w.home, '1.0.0')),
    ])
    expect(result.exitCode).toBe(0)
    expect(result.sessions[0]).toMatchObject({ status: 'current', versions: ['1.0.1'] })
  })

  it('a session without the plugin is absent and does not fail the check', () => {
    const w = world()
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, '/usr/lib/other/server.js')])
    expect(result.exitCode).toBe(0)
    expect(result.sessions[0]).toMatchObject({ status: 'absent', versions: [] })
  })

  it('exit 2 names the reason when a server command line is unreadable, never clean', () => {
    const w = world()
    const { result, text } = run(w, [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1'), { unreadableCommandLine: true })])
    expect(result.exitCode).toBe(2)
    expect(result.sessions[0].status).toBe('unknown')
    expect(text).toMatch(/unknown session=.* reason=command line of pid 101 unreadable: EACCES/)
  })

  it('exit 2 when a session descriptor list is unreadable', () => {
    const w = world()
    const row = { ...session(100, w.home, SID_A), unreadableDescriptors: true }
    const { result } = run(w, [row, server(101, 100, serverScript(w.home, '1.0.1'))])
    expect(result.exitCode).toBe(2)
    expect(result.sessions[0].reason).toMatch(/descriptors of pid 100 unreadable: EACCES/)
  })

  it('stale wins the exit code over an unknown session, and both are listed', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.0')),
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.1'), { unreadableCommandLine: true }),
    ])
    expect(result.exitCode).toBe(1)
    expect(result.sessions.map((s: { status: string }) => s.status).sort()).toEqual(['stale', 'unknown'])
  })

  it('exit 2 in a foreign PID namespace', () => {
    const w = world()
    const { result } = run(w, [session(100, w.home, SID_A)], { tree: { selfLink: '4' } })
    expect(result.exitCode).toBe(2)
    expect(result.reason).toMatch(/foreign PID namespace/)
  })

  it.each(['darwin', 'win32'])('exit 2 with a named reason on %s', (platform) => {
    const result = scan!.checkLoadedVersions({ plugin: 'demo', expect: '1.0.1', platform, selfPid: SELF, uid: 1 })
    expect(result.exitCode).toBe(2)
    expect(result.reason).toBe(`live-session inspection needs Linux /proc (platform ${platform})`)
  })

  it('skips a zombie session row', () => {
    const w = world()
    const { result } = run(w, [{ ...session(100, w.home, SID_A), state: 'Z' }, server(101, 100, serverScript(w.home, '1.0.0'))])
    expect(result.sessions).toEqual([])
  })

  it('skips sessions of another user (real uid from status)', () => {
    const w = world()
    const { result } = run(w, [
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.0')),
      { ...session(300, w.home, SID_A), uid: 12345 }, server(301, 300, serverScript(w.home, '1.0.1')),
    ], { uid: 12345 })
    expect(result.sessions.map((s: { pid: number }) => s.pid)).toEqual([300])
  })

  it('a census with no session of this user is exit 2 unless --allow-none', () => {
    const w = world()
    const { result } = run(w, [
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.0')),
    ], { uid: 12345 })
    expect(result.sessions).toEqual([])
    expect(result.exitCode).toBe(2)
    expect(result.reason).toBe(scan!.NO_SESSION_REASON)
  })

  it('shows the descriptor profile and still matches a --profile naming the module profile', () => {
    const w = world()
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, serverScript(w.work, '1.0.1'))], { profiles: [w.work] })
    expect(result.sessions[0]).toMatchObject({ pid: 100, profile: w.home, status: 'current' })
  })

  it('takes the profile from the module path when no config-dir descriptor is held, and keeps an unknown session id visible', () => {
    const w = world()
    const row = { ...session(100, '/dev/null', null) }
    const { result, text } = run(w, [row, server(101, 100, serverScript(w.work, '1.0.1'))])
    expect(result.sessions[0]).toMatchObject({ profile: w.work, sessionId: null, status: 'current' })
    expect(text).toContain(`current session=unknown profile=${w.work} pid=100 version=1.0.1`)
  })

  it('--profile narrows the listing to the named profiles', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.0')),
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.1')),
    ], { profiles: [w.work] })
    expect(result.exitCode).toBe(0)
    expect(result.sessions.map((s: { pid: number }) => s.pid)).toEqual([200])
  })

  it('without --expect it lists loaded versions and exits 0', () => {
    const w = world()
    const { result, text } = run(w, [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.0'))], { expect: null })
    expect(result.exitCode).toBe(0)
    expect(text).toContain(`loaded session=${SID_A} profile=${w.home} pid=100 version=1.0.0`)
  })

  it('never reads an environment file, never reads inside a profile, never prints a command line', () => {
    const w = world()
    const { reads, text, result, lookups } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.0')),
    ])
    expect(reads.length).toBeGreaterThan(10)
    expect(reads.filter(path => path.endsWith('/environ'))).toEqual([])
    expect(lookups.length).toBeGreaterThan(0)
    expect(lookups.filter(([kind, path]) => kind === 'isDirectory' && !path.endsWith('/plugins/cache'))).toEqual([])
    expect(text).not.toContain('argv-secret-value')
    expect(JSON.stringify(report!.renderJson(result))).not.toContain('argv-secret-value')
  })

  it('a process that vanishes between listing and reading is skipped, not unreadable', () => {
    const w = world()
    const tree = procTree(w.root, { selfPid: SELF, processes: [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1'))] })
    trees.push(tree)
    const { procfs } = recordingProcfs(tree.proc)
    const racing = { ...procfs, listProcesses: () => [...procfs.listProcesses(), '555'] }
    const result = scan!.checkLoadedVersions({ plugin: 'demo', expect: '1.0.1', procfs: racing, platform: 'linux', selfPid: SELF, uid: process.getuid!(), env: {} })
    expect(result.exitCode).toBe(0)
    rmSync(join(tree.proc, '101'), { recursive: true, force: true })
    const after = scan!.checkLoadedVersions({ plugin: 'demo', expect: '1.0.1', procfs, platform: 'linux', selfPid: SELF, uid: process.getuid!(), env: {} })
    expect(after.sessions[0].status).toBe('absent')
  })

  it('attributes a session whose process holds the .claude-work config dir to that profile', () => {
    const w = world()
    const { result, text } = run(w, [session(200, w.work, SID_B), server(201, 200, serverScript(w.work, '1.0.0'))])
    expect(w.work.endsWith('/.claude-work')).toBe(true)
    expect(result.sessions[0]).toMatchObject({ pid: 200, profile: w.work, sessionId: SID_B, status: 'stale' })
    expect(text).toContain(`stale session=${SID_B} profile=${w.work} pid=200 version=1.0.0`)
  })

  it('an empty census prints "no live session", never a bare zero', () => {
    const w = world()
    const { result, text } = run(w, [{ pid: 300, ppid: 1, comm: 'bash', argv: ['bash'], cwd: '/' }], { allowNone: true })
    expect(result.exitCode).toBe(0)
    expect(text.split('\n')).toEqual([expect.stringMatching(/ sessions=0 current=0 /), 'no live session'])
  })

  it('a requested profile with no session gets its own "no live session" line', () => {
    const w = world()
    const { text } = run(w, [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1'))], { profiles: [w.home, w.work] })
    expect(text).toContain(`current session=${SID_A} profile=${w.home}`)
    expect(text).toContain(`no live session profile=${w.work}`)
    expect(text.split('\n')).not.toContain(`no live session profile=${w.home}`)
  })

  it.each(['../x', '..', '.', 'a b'])('refuses the plugin name %j', (plugin) => {
    expect(() => scan!.checkLoadedVersions({ plugin, expect: '1', platform: 'linux', selfPid: SELF, uid: 1 })).toThrow(/plugin name/)
  })

  it('a server whose working directory was deleted after an update still reads stale', () => {
    const w = world()
    const oldRoot = join(w.home, 'plugins', 'cache', 'market', 'demo', '0.9.0')
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, './start.mjs', { cwd: `${oldRoot} (deleted)` })])
    expect(result.exitCode).toBe(1)
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['0.9.0'], profile: w.home })
  })

  it('a server started with a bare file name is recognised by its working directory', () => {
    const w = world()
    const pluginRoot = join(w.home, 'plugins', 'cache', 'market', 'demo', '1.0.0')
    const { result } = run(w, [session(100, w.home, SID_A), { pid: 101, ppid: 100, comm: 'node', argv: ['node', 'server.js'], cwd: pluginRoot }])
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0'] })
  })

  it('a version directory linked to a checkout outside the cache keeps the version it was given', () => {
    const w = world()
    const linked = join(w.home, 'plugins', 'cache', 'market', 'demo', '2.0.0')
    mkdirSync(join(w.root, 'checkout'))
    symlinkSync(join(w.root, 'checkout'), linked)
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, join(linked, 'start.mjs'))])
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['2.0.0'] })
  })

  it('a version label that resolves to another cached version is judged by the resolved one', () => {
    const w = world()
    const cache = join(w.home, 'plugins', 'cache', 'market', 'demo')
    symlinkSync(join(cache, '1.0.0'), join(cache, '9.9.9'))
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, join(cache, '9.9.9', 'start.mjs'), { cwd: '/' })])
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0'] })
  })

  it('a profile path holding a space is still recognised', () => {
    const root = fixtureRoot()
    const spaced = profileDir(root, 'A B/.claude', 'demo', ['1.0.0'])
    const { result } = run({ root, home: spaced, work: spaced }, [session(100, spaced, SID_A), server(101, 100, serverScript(spaced, '1.0.0'))])
    expect(result.sessions[0]).toMatchObject({ status: 'stale', versions: ['1.0.0'], profile: spaced })
  })

  it('a path-shaped argument outside any real profile is neither counted nor printed', () => {
    const w = world()
    const secret = '/private/SECRET_PREFIX/plugins/cache/m/demo/SECRET_VERSION/value'
    const { result, text } = run(w, [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1'), { argv: ['node', serverScript(w.home, '1.0.1'), '--token', secret] })])
    expect(result.sessions[0]).toMatchObject({ status: 'current', versions: ['1.0.1'] })
    const json = JSON.stringify(report!.renderJson(result))
    for (const out of [text, json]) { expect(out).not.toContain('SECRET_PREFIX'); expect(out).not.toContain('SECRET_VERSION') }
  })

  it('a failing metadata lookup (not a missing path) makes the session unknown', () => {
    const w = world()
    const files = { isDirectory: () => true, realpath: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
    const { result } = run(w, [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1'))], { files })
    expect(result.exitCode).toBe(2)
    expect(result.sessions[0].reason).toMatch(/realpath of a module path failed: EACCES/)
  })

  it('a command line that vanishes while its process is still present is unknown, not absent', () => {
    const w = world()
    const tree = procTree(w.root, { selfPid: SELF, processes: [session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1'))] })
    trees.push(tree)
    const { procfs } = recordingProcfs(tree.proc)
    const flaky = { ...procfs, readCommandLine: (pid: string, ...rest: unknown[]) => {
      if (pid === '101') throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return procfs.readCommandLine(pid, ...rest)
    } }
    const result = scan!.checkLoadedVersions({ plugin: 'demo', expect: '1.0.1', procfs: flaky, platform: 'linux', selfPid: SELF, uid: process.getuid!(), env: {} })
    expect(result.sessions[0]).toMatchObject({ status: 'unknown' })
    expect(result.sessions[0].reason).toMatch(/command line of pid 101 unreadable: ENOENT while the process is still present/)
  })

  it('an empty command line of a live process is unknown; of a zombie, gone', () => {
    const w = world()
    const live = run(w, [session(100, w.home, SID_A), { pid: 101, ppid: 100, comm: 'node', argv: [], cwd: '/' }])
    expect(live.result.sessions[0].status).toBe('unknown')
    const tree = procTree(fixtureRoot(), { selfPid: SELF, processes: [session(100, w.home, SID_A), { pid: 101, ppid: 100, comm: 'node', argv: [], cwd: '/' }] })
    trees.push(tree)
    const { procfs } = recordingProcfs(tree.proc)
    let statReads = 0
    const exiting = { ...procfs, readProcessStat: (pid: string, ...rest: unknown[]) => {
      const text = procfs.readProcessStat(pid, ...rest) as string
      if (pid !== '101') return text
      statReads += 1
      return statReads > 1 ? text.replace(') S ', ') Z ') : text
    } }
    const after = scan!.checkLoadedVersions({ plugin: 'demo', expect: null, procfs: exiting, platform: 'linux', selfPid: SELF, uid: process.getuid!(), env: {} })
    expect(after.sessions[0].status).toBe('absent')
    expect(statReads).toBeGreaterThan(1)
  })

  it('a shell child whose command text names an old cache path is neither counted nor printed', () => {
    const w = world()
    const text = `eval 'node ${serverScript(w.home, '0.9.0')} SECRET_IN_COMMAND'`
    const { result, text: out } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      { pid: 102, ppid: 100, comm: 'zsh', argv: ['/bin/zsh', '-c', text], cwd: join(w.home, 'plugins', 'cache', 'market', 'demo', '0.9.0') },
    ])
    expect(result.sessions[0]).toMatchObject({ status: 'current', versions: ['1.0.1'] })
    expect(out).not.toContain('SECRET_IN_COMMAND')
    expect(JSON.stringify(report!.renderJson(result))).not.toContain('SECRET_IN_COMMAND')
  })

  it('a current server beside an unreadable sibling is unknown, not current', () => {
    const w = world()
    const { result } = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      { pid: 102, ppid: 100, comm: 'node', argv: ['node', '/x.js'], cwd: '/', unreadableCommandLine: true },
    ])
    expect(result.exitCode).toBe(2)
    expect(result.sessions[0]).toMatchObject({ status: 'unknown', versions: ['1.0.1'] })
  })

  it('two session-id descriptors are both shown, never one picked silently', () => {
    const w = world()
    const row = session(100, w.home, SID_A)
    ;(row.fds as string[]).push(`/tmp/claude-1000/-home-project/${SID_B}/tasks`)
    const { result } = run(w, [row, server(101, 100, serverScript(w.home, '1.0.1'))])
    expect(result.sessions[0].sessionId).toBe(`${SID_A},${SID_B}`)
  })

  it('two config-dir descriptors leave the profile to the module path, or unknown without one', () => {
    const w = world()
    const row = { ...session(100, w.home, SID_A), fds: [w.home, w.work, `/tmp/claude-1000/-p/${SID_A}/tasks`] }
    const both = run(w, [row, server(101, 100, serverScript(w.work, '1.0.1'))])
    expect(both.result.sessions[0].profile).toBe(w.work)
    const none = run(world(), [{ ...row, pid: 100 }], { expect: null })
    expect(none.result.sessions[0].profile).toBeNull()
  })

  it('a --profile that does not exist is exit 2, never an empty listing', () => {
    const w = world()
    const { result } = run(w, [session(100, w.home, SID_A)], { profiles: [join(w.root, 'missing')] })
    expect(result.exitCode).toBe(2)
    expect(result.reason).toMatch(/--profile .*missing does not exist/)
  })

  it('a reader launched from a Claude session that sees no session is exit 2, even with --allow-none', () => {
    const w = world()
    const hidden = run(w, [{ pid: 300, ppid: 1, comm: 'node', argv: ['node'], cwd: '/' }], { env: { CLAUDECODE: '1' }, allowNone: true })
    expect(hidden.result.exitCode).toBe(2)
    expect(hidden.result.reason).toMatch(/launched from a Claude session .* census shows none/)
  })

  it('a detached reader outside any session ancestry still judges the sessions it sees', () => {
    const w = world()
    const seen = run(w, [
      session(100, w.home, SID_A), server(101, 100, serverScript(w.home, '1.0.1')),
      { pid: SELF, ppid: 1, comm: 'node', argv: ['node'], cwd: '/' },
    ], { env: { CLAUDECODE: '1' } })
    expect(seen.result.exitCode).toBe(0)
    expect(seen.result.sessions.map((s: { status: string }) => s.status)).toEqual(['current'])
  })

  it('parses a stat line whose command name holds spaces and parentheses', () => {
    expect(census!.parseStat('42 (a) (b c) S 7 1 1')).toEqual({ comm: 'a) (b c', state: 'S', ppid: '7' })
  })
})
