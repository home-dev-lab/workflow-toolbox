import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { artifactUrl, assignArtifactMounts, deriveArtifactPort } from '../../../../plugin/bin/lib/artifact-server.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SERVER = join(REPO_ROOT, 'plugin/bin/wt-artifact-server.mjs')
const ENSURE = join(REPO_ROOT, 'plugin/bin/wt-artifact-server-ensure.mjs')
const MONITORS = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const temporaryDirs: string[] = []
const children = new Set<ChildProcess>()
const detachedPids = new Set<number>()

function temporaryDir(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), `wt-artifact-${tag}-`))
  temporaryDirs.push(dir)
  return dir
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for artifact server state')
}

function statePath(stateHome: string) {
  return join(stateHome, 'wt-artifact-server', 'server.json')
}

function registrationsPath(stateHome: string) {
  return join(stateHome, 'wt-artifact-server', 'registrations')
}

type RootRecord = { name: string, path: string }
type Discovery = {
  version: string
  pid: number
  port: number
  baseUrl: string
  remoteUrl: string | null
  roots: RootRecord[]
  mounts?: RootRecord[]
  startedAt: string
}

function readState(stateHome: string): Discovery | null {
  try { return JSON.parse(readFileSync(statePath(stateHome), 'utf8')) as Discovery } catch { return null }
}

function baseEnv(stateHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = temporaryDir('tailscale-default-absent')
  const script = join(bin, 'tailscale')
  writeFileSync(script, '#!/bin/sh\nexit 1\n')
  chmodSync(script, 0o755)
  const git = join(bin, 'git')
  writeFileSync(git, '#!/bin/sh\nif [ -n "$WT_TEST_GIT_ROOT" ] && [ "$1 $2" = "rev-parse --show-toplevel" ]; then printf "%s\\n" "$WT_TEST_GIT_ROOT"; exit 0; fi\nexit 1\n')
  chmodSync(git, 0o755)
  return {
    ...process.env, PATH: bin, XDG_STATE_HOME: stateHome,
    WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS: '25', ...extra,
  }
}

async function reservePort(host = '127.0.0.1') {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listener has no TCP port')
  return { port: address.port, server }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child.pid || !pidAlive(child.pid)) return
  child.kill(signal)
  await waitFor(() => pidAlive(child.pid!) ? null : true, 3_000).catch(() => undefined)
}

async function stopDetached(pid: number) {
  if (!detachedPids.delete(pid) || !pidAlive(pid)) return
  process.kill(pid, 'SIGTERM')
  await waitFor(() => pidAlive(pid) ? null : true, 3_000).catch(() => undefined)
}

afterEach(async () => {
  for (const child of [...children]) {
    children.delete(child)
    await stopChild(child)
  }
  for (const pid of [...detachedPids]) await stopDetached(pid)
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function spawnEnsure(cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [ENSURE], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  return child
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function waitForState(stateHome: string, predicate: (state: Discovery) => boolean = () => true) {
  const state = await waitFor(() => {
    const value = readState(stateHome)
    return value && predicate(value) ? value : null
  })
  detachedPids.add(state.pid)
  return state
}

function rawRequest(port: number, pathname: string, host?: string, connectHost = '127.0.0.1', method = 'GET'): Promise<{ status: number, body: string, headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolvePromise, reject) => {
    const headers = host === undefined ? {} : { Host: host }
    const req = httpRequest({ host: connectHost, port, path: pathname, method, headers, setHost: host !== undefined }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body, headers: response.headers }))
    })
    req.once('error', reject)
    req.end()
  })
}

async function health(state: Discovery) {
  const response = await rawRequest(state.port, '/__wt-artifact-server/health', `localhost:${state.port}`)
  return JSON.parse(response.body) as { service: string, version: string, uid: number | string, pid: number, port: number, registeredSessions: number }
}

describe('review test infrastructure', () => {
  it('[B-01] retries awaited async predicates', async () => {
    let calls = 0
    const result = await waitFor(async () => ++calls === 3 ? 'ready' : null)
    expect(result).toBe('ready')
    expect(calls).toBe(3)
  })
})

function projectWithRoots(tag: string) {
  const project = temporaryDir(tag)
  const reports = join(project, '.claude', 'reports')
  const worktrees = join(project, '.claude', 'worktrees')
  mkdirSync(reports, { recursive: true })
  mkdirSync(worktrees, { recursive: true })
  return { project, reports, worktrees }
}

describe('owner decision 1: default enablement', () => {
  it('[B-02] starts by default and only WT_ARTIFACT_SERVER=0 disables it', async () => {
    const { project } = projectWithRoots('default-on')
    const stateHome = temporaryDir('default-on-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)

    const monitor = spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) }))
    const state = await waitForState(stateHome)
    expect(state.port).toBe(port)
    await waitFor(async () => (await health(state)).registeredSessions === 1 ? true : null)
    await stopChild(monitor)

    const offState = temporaryDir('explicit-off-state')
    const off = spawnSync(process.execPath, [ENSURE], {
      cwd: project,
      encoding: 'utf8',
      env: baseEnv(offState, { WT_ARTIFACT_SERVER: '0', WT_ARTIFACT_SERVER_PORT: String(port) }),
    })
    expect(off.status).toBe(0)
    expect(readState(offState)).toBeNull()
    const monitors = JSON.parse(readFileSync(MONITORS, 'utf8')) as Array<{ name: string, description: string }>
    expect(monitors.find((entry) => entry.name === 'artifact-server')?.description).not.toMatch(/opt-in/i)
  })
})

describe('owner decision 2: discovery and one instance', () => {
  it('[A-02] derives a stable per-user port outside Atrium range', () => {
    const username = userInfo().username
    expect(deriveArtifactPort(username)).toBe(deriveArtifactPort(username))
    expect(deriveArtifactPort(username)).toBeGreaterThanOrEqual(48_000)
    expect(deriveArtifactPort(username)).toBeLessThan(49_000)
    expect(deriveArtifactPort(`${username}-other`)).not.toBe(deriveArtifactPort(username))
  })

  it('[E-01] lets two concurrent monitors attach to one server', async () => {
    const { project } = projectWithRoots('race')
    const stateHome = temporaryDir('race-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
    spawnEnsure(project, env)
    spawnEnsure(project, env)
    const state = await waitForState(stateHome)
    await waitFor(async () => (await health(state)).registeredSessions === 2 ? true : null)
    expect((await health(state)).pid).toBe(state.pid)
    expect((await health(state)).version).toBe(state.version)
    expect((await health(state)).uid).toBe(typeof process.getuid === 'function' ? process.getuid() : userInfo().username)
    expect(statSync(statePath(stateHome)).mode & 0o777).toBe(0o600)
  })

  it('[A-02] probes all candidates before starting after a fallback port becomes free', async () => {
    const { project } = projectWithRoots('fallback')
    const stateHome = temporaryDir('fallback-state')
    const foreign = createServer((_request, response) => response.end('foreign'))
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject)
      foreign.listen(port, '127.0.0.1', resolve)
    })
    try {
      const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
      spawnEnsure(project, env)
      const state = await waitForState(stateHome)
      expect(state.port).toBe(port + 1)
      expect(foreign.listening).toBe(true)
      await closeServer(foreign)
      spawnEnsure(project, env)
      await waitFor(async () => (await health(state)).registeredSessions === 2 ? true : null)
      expect(readState(stateHome)?.pid).toBe(state.pid)
    } finally {
      if (foreign.listening) await closeServer(foreign)
    }
  })

  it('[E-04] refuses uid mismatch attachment and same-process forged stop identity', async () => {
    const stateHome = temporaryDir('mismatch-state')
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.add(decoy)
    if (!decoy.pid) throw new Error('decoy process has no pid')
    const foreign = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ service: 'workflow-toolbox-artifact-server', version: 'x', uid: 'foreign-user', pid: decoy.pid, port: addressPort, registeredSessions: 0 }))
    })
    let addressPort = 0
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject)
      foreign.listen(0, '127.0.0.1', resolve)
    })
    const address = foreign.address()
    if (!address || typeof address === 'string') throw new Error('foreign listener has no port')
    addressPort = address.port
    mkdirSync(join(stateHome, 'wt-artifact-server'), { recursive: true })
    writeFileSync(statePath(stateHome), JSON.stringify({
      version: 'x', pid: decoy.pid, port: address.port, baseUrl: `http://localhost:${address.port}`,
      remoteUrl: null, roots: [], startedAt: new Date().toISOString(),
    }))
    chmodSync(statePath(stateHome), 0o600)
    try {
      const stopped = await runCli(['stop', '--force'], baseEnv(stateHome))
      expect(stopped.code).not.toBe(0)
      expect(stopped.stderr).toMatch(/identity|mismatch/i)
      expect(foreign.listening).toBe(true)

      const { project } = projectWithRoots('uid-mismatch')
      spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(address.port) }))
      const own = await waitForState(stateHome, (value) => value.port === address.port + 1)
      expect(own.port).toBe(address.port + 1)
    } finally {
      await closeServer(foreign)
    }
  })
})

describe('owner decision 3: session lifetime and operator controls', () => {
  it('tolerates a transient discovery miss and stops when its state home no longer registers the server', async () => {
    const stateHome = temporaryDir('removed-state-home')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const server = spawn(process.execPath, [SERVER, 'serve'], {
      env: baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) }),
      stdio: 'ignore',
    })
    children.add(server)
    if (!server.pid) throw new Error('artifact server process has no pid')
    const state = await waitForState(stateHome)
    expect(state.pid).toBe(server.pid)

    const displacedState = `${statePath(stateHome)}.displaced`
    renameSync(statePath(stateHome), displacedState)
    await new Promise((resolve) => setTimeout(resolve, 35))
    renameSync(displacedState, statePath(stateHome))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pidAlive(server.pid)).toBe(true)

    rmSync(stateHome, { recursive: true, force: true })

    await waitFor(() => pidAlive(server.pid!) ? null : true, 500)
  })

  it('[V3-idle-registration][V3-last-deregistration] keeps an idle registered session alive past grace and stops immediately after clean removal', async () => {
    const { project } = projectWithRoots('clean-stop')
    const stateHome = temporaryDir('clean-stop-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_IDLE_GRACE_S: '0.5',
    }))
    const state = await waitForState(stateHome)
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect(pidAlive(state.pid)).toBe(true)
    await stopChild(monitor)
    await waitFor(() => pidAlive(state.pid) ? null : true, 300)
  })

  it('[V3-dead-pid-grace] removes a dead registration and stops after grace', async () => {
    const { project } = projectWithRoots('dead-stop')
    const stateHome = temporaryDir('dead-stop-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_IDLE_GRACE_S: '0.2',
    }))
    const state = await waitForState(stateHome)
    await waitFor(async () => (await health(state)).registeredSessions === 1 ? true : null)
    await stopChild(monitor, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pidAlive(state.pid)).toBe(true)
    await waitFor(() => pidAlive(state.pid) ? null : true, 2_000)
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(0)
  })

  it('[V3-stop-refused][V3-force] refuses stop/restart with registrations and allows both with --force', async () => {
    const { project } = projectWithRoots('controls')
    const stateHome = temporaryDir('controls-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
    const monitor = spawnEnsure(project, env)
    const first = await waitForState(stateHome)
    await waitFor(async () => (await health(first)).registeredSessions === 1 ? true : null)

    for (const command of ['stop', 'restart']) {
      const refused = spawnSync(process.execPath, [SERVER, command], { encoding: 'utf8', env })
      expect(refused.status, command).not.toBe(0)
      expect(refused.stderr, command).toMatch(/registered session/i)
      expect(pidAlive(first.pid)).toBe(true)
    }

    const restarted = spawnSync(process.execPath, [SERVER, 'restart', '--force'], { encoding: 'utf8', env, timeout: 5_000 })
    expect(restarted.status).toBe(0)
    const second = await waitForState(stateHome, (state) => state.pid !== first.pid)
    expect(second.pid).not.toBe(first.pid)

    const stopped = spawnSync(process.execPath, [SERVER, 'stop', '--force'], { encoding: 'utf8', env, timeout: 5_000 })
    expect(stopped.status).toBe(0)
    await waitFor(() => pidAlive(second.pid) ? null : true)
    await stopChild(monitor)
  })
})

describe('review decisions: filesystem roots and URLs', () => {
  it('[V1] extends a colliding short hash instead of dropping a root', () => {
    const assignments = new Map<string, string>()
    const roots = assignArtifactMounts([
      { name: 'reports', canonical: '/projects/one/reports' },
      { name: 'reports', canonical: '/projects/two/reports' },
      { name: 'reports', canonical: '/projects/three/reports' },
    ], assignments, (canonical: string) => canonical.includes('/two/') ? 'abcdef1' : 'abcdef2')

    expect(roots.map((root: { name: string }) => root.name)).toEqual(['reports', 'reports-abcdef', 'reports-abcdef2'])
    expect(new Set(roots.map((root: { name: string }) => root.name)).size).toBe(3)
  })

  it('[E-01] registers with owner-only per-session files and exposes no HTTP controls', async () => {
    const project = temporaryDir('multi-project')
    const rootA = temporaryDir('root-a')
    const rootB = temporaryDir('root-b')
    writeFileSync(join(rootA, 'a.txt'), 'A')
    writeFileSync(join(rootB, 'b.txt'), 'B')
    const stateHome = temporaryDir('multi-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = { WT_ARTIFACT_SERVER_PORT: String(port) }
    spawnEnsure(project, baseEnv(stateHome, { ...common, WT_ARTIFACT_SERVER_ROOTS: `alpha=${rootA}` }))
    spawnEnsure(project, baseEnv(stateHome, { ...common, WT_ARTIFACT_SERVER_ROOTS: `beta=${rootB}` }))
    const state = await waitForState(stateHome, (value) => value.roots.length === 2)
    expect(state.roots.map((root) => root.name).sort()).toEqual(['alpha', 'beta'])
    expect(statSync(join(stateHome, 'wt-artifact-server')).mode & 0o777).toBe(0o700)
    expect(statSync(registrationsPath(stateHome)).mode & 0o777).toBe(0o700)
    const registrations = readdirSync(registrationsPath(stateHome))
    expect(registrations).toHaveLength(2)
    expect(registrations.every((file) => (statSync(join(registrationsPath(stateHome), file)).mode & 0o777) === 0o600)).toBe(true)
    for (const file of registrations) {
      const registration = JSON.parse(readFileSync(join(registrationsPath(stateHome), file), 'utf8')) as Record<string, unknown>
      expect(registration).toEqual(expect.objectContaining({ pid: expect.any(Number), roots: expect.any(Array), deny: expect.any(Array), startedAt: expect.any(String) }))
    }
    expect((await rawRequest(port, '/alpha/a.txt', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/beta/b.txt', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/__wt-artifact-server/register?session=x', `localhost:${port}`)).status).toBe(404)
    expect((await rawRequest(port, '/__wt-artifact-server/deregister?session=x', `localhost:${port}`)).status).toBe(404)
  })

  it('[A-01] defaults to project-unique reports/worktrees names and chooses the longest URL root', async () => {
    const { project, reports, worktrees } = projectWithRoots('defaults')
    const nestedCwd = join(project, 'packages', 'nested')
    mkdirSync(nestedCwd, { recursive: true })
    const nested = join(reports, 'nested')
    mkdirSync(nested)
    const artifact = join(nested, 'report file.md')
    writeFileSync(artifact, '# Report')
    const stateHome = temporaryDir('defaults-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(nestedCwd, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port), WT_TEST_GIT_ROOT: project }))
    const state = await waitForState(stateHome, (value) => value.roots.length === 2)
    const prefix = basename(project)
    expect(state.roots).toEqual(expect.arrayContaining([
      { name: `${prefix}-reports`, path: reports }, { name: `${prefix}-worktrees`, path: worktrees },
    ]))
    expect(state.roots.some((root) => root.path === process.env.HOME)).toBe(false)

    const env = baseEnv(stateHome)
    expect(artifactUrl(artifact, { env })).toBe(`${state.baseUrl}/${prefix}-reports/nested/report%20file.md`)
    writeFileSync(statePath(stateHome), JSON.stringify({
      ...state, roots: [{ name: 'gone', path: join(project, 'removed-root') }, ...state.roots],
    }))
    expect(artifactUrl(artifact, { env })).toBe(`${state.baseUrl}/${prefix}-reports/nested/report%20file.md`)
    const outside = join(project, 'outside.txt')
    writeFileSync(outside, 'outside')
    const outsideResult = spawnSync(process.execPath, [SERVER, 'url', outside], { encoding: 'utf8', env })
    expect(outsideResult.status).toBe(3)
    const status = spawnSync(process.execPath, [SERVER, 'status'], { encoding: 'utf8', env })
    expect(status.status).toBe(0)
    expect(status.stdout).toContain(`port: ${port}`)
    expect(status.stdout).toContain(`baseUrl: ${state.baseUrl}`)
    expect(status.stdout).toContain('remoteUrl: null')
    expect(status.stdout).toContain(`${prefix}-reports=${reports}`)

    const duplicate = spawnSync(process.execPath, [ENSURE], {
      cwd: project, encoding: 'utf8', timeout: 3_000,
      env: baseEnv(temporaryDir('duplicate-state'), {
        WT_ARTIFACT_SERVER_ROOTS: `same=${reports}${delimiter}same=${worktrees}`,
      }),
    })
    expect(duplicate.status).not.toBe(0)
    expect(duplicate.stderr).toMatch(/duplicate root name/i)
  })

  it('[A-01] lets default roots from different projects coexist', async () => {
    const one = projectWithRoots('coexist-one')
    const two = projectWithRoots('coexist-two')
    writeFileSync(join(one.reports, 'one.txt'), 'one')
    writeFileSync(join(two.reports, 'two.txt'), 'two')
    const stateHome = temporaryDir('coexist-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
    spawnEnsure(one.project, env)
    spawnEnsure(two.project, env)
    const state = await waitForState(stateHome, (value) => value.roots.length === 4)
    const oneName = `${basename(one.project)}-reports`
    const twoName = `${basename(two.project)}-reports`
    expect((await rawRequest(port, `/${oneName}/one.txt`, `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, `/${twoName}/two.txt`, `localhost:${port}`)).status).toBe(200)
    expect(state.roots.map((root) => root.name)).toContain(oneName)
    expect(state.roots.map((root) => root.name)).toContain(twoName)
  })

  it('[A-01] adds stable hash suffixes when projects share a basename', async () => {
    const parentOne = temporaryDir('same-name-one')
    const parentTwo = temporaryDir('same-name-two')
    const projectOne = join(parentOne, 'project')
    const projectTwo = join(parentTwo, 'project')
    for (const project of [projectOne, projectTwo]) {
      mkdirSync(join(project, '.claude', 'reports'), { recursive: true })
      mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })
    }
    const stateHome = temporaryDir('same-name-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = { WT_ARTIFACT_SERVER_PORT: String(port) }
    spawnEnsure(projectOne, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectOne }))
    spawnEnsure(projectTwo, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectTwo }))
    const state = await waitForState(stateHome, (value) => value.roots.length === 4)
    const reportNames = state.roots.filter((root) => root.path.endsWith(join('.claude', 'reports'))).map((root) => root.name)
    expect(reportNames).toHaveLength(2)
    expect(new Set(reportNames).size).toBe(2)
    expect(reportNames).toContain('project-reports')
    expect(reportNames.filter((name) => /^project-reports-[0-9a-f]{6}$/.test(name))).toHaveLength(1)
  })

  it('[V2] keeps first-assigned mount URLs when projects join, leave, and rejoin', async () => {
    const parentOne = temporaryDir('stable-one')
    const parentTwo = temporaryDir('stable-two')
    const projectOne = join(parentOne, 'project')
    const projectTwo = join(parentTwo, 'project')
    for (const project of [projectOne, projectTwo]) mkdirSync(join(project, '.claude', 'reports'), { recursive: true })
    const reportOne = join(projectOne, '.claude', 'reports', 'one.txt')
    const reportTwo = join(projectTwo, '.claude', 'reports', 'two.txt')
    writeFileSync(reportOne, 'one')
    writeFileSync(reportTwo, 'two')
    const stateHome = temporaryDir('stable-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = { WT_ARTIFACT_SERVER_PORT: String(port) }
    const monitorOne = spawnEnsure(projectOne, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectOne }))
    const first = await waitForState(stateHome, (state) => state.roots.length === 1)
    const firstName = first.roots[0]!.name
    const firstUrl = `${first.baseUrl}/${firstName}/one.txt`

    const monitorTwo = spawnEnsure(projectTwo, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectTwo }))
    const joined = await waitForState(stateHome, (state) => state.roots.length === 2)
    const secondName = joined.roots.find((root) => root.path === join(projectTwo, '.claude', 'reports'))?.name
    expect(joined.roots.find((root) => root.path === join(projectOne, '.claude', 'reports'))?.name).toBe(firstName)
    expect(secondName).toBeTruthy()
    expect(secondName).not.toBe(firstName)

    await stopChild(monitorOne)
    const left = await waitForState(stateHome, (state) => state.roots.length === 1 && state.roots[0]?.path === join(projectTwo, '.claude', 'reports'))
    expect(left.roots[0]!.name).toBe(secondName)
    expect(left.mounts).toEqual(expect.arrayContaining([
      { name: firstName, path: join(projectOne, '.claude', 'reports') },
      { name: secondName, path: join(projectTwo, '.claude', 'reports') },
    ]))
    expect(statSync(statePath(stateHome)).mode & 0o777).toBe(0o600)

    spawnEnsure(projectOne, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectOne }))
    const rejoined = await waitForState(stateHome, (state) => state.roots.length === 2)
    expect(rejoined.roots.find((root) => root.path === join(projectOne, '.claude', 'reports'))?.name).toBe(firstName)
    expect(rejoined.roots.find((root) => root.path === join(projectTwo, '.claude', 'reports'))?.name).toBe(secondName)
    expect(artifactUrl(reportOne, { env: baseEnv(stateHome) })).toBe(firstUrl)
    expect((await rawRequest(port, `/${secondName}/two.txt`, `localhost:${port}`)).status).toBe(200)
    await stopChild(monitorTwo)
  })

  it('[E-01] refuses an insecure or foreign-owned state directory', () => {
    const { project } = projectWithRoots('insecure-state')
    const stateHome = temporaryDir('insecure-state-home')
    const stateDir = join(stateHome, 'wt-artifact-server')
    mkdirSync(stateDir)
    chmodSync(stateDir, 0o777)
    const result = spawnSync(process.execPath, [ENSURE], { cwd: project, encoding: 'utf8', env: baseEnv(stateHome), timeout: 1_500 })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/state directory.*writable|secure/i)
  })
})

describe('owner decision 5: Tailscale access', () => {
  function tailscaleStub(mode: 'present' | 'https' | 'absent') {
    const bin = temporaryDir(`tailscale-${mode}`)
    const script = join(bin, 'tailscale')
    const serveStatus = mode === 'https'
      ? `printf 'https://host.tailnet.ts.net\\n|-- / proxy http://127.0.0.1:%s\\n' "$WT_ARTIFACT_SERVER_PORT"`
      : "printf 'No serve config'"
    const body = mode !== 'absent'
      ? `#!/bin/sh\nif [ "$1 $2" = "ip -4" ]; then printf '127.0.0.2\\n'; exit 0; fi\nif [ "$1 $2" = "status --json" ]; then printf '{"Self":{"DNSName":"host.tailnet.ts.net."}}'; exit 0; fi\nif [ "$1 $2" = "serve status" ]; then ${serveStatus}; exit 0; fi\nexit 1\n`
      : '#!/bin/sh\nexit 1\n'
    writeFileSync(script, body)
    chmodSync(script, 0o755)
    return bin
  }

  it('[B-02] accepts MagicDNS, rejects an evil Host, and reports the tailnet URL', async () => {
    const { project } = projectWithRoots('tailscale')
    const stateHome = temporaryDir('tailscale-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const bin = tailscaleStub('present')
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, WT_ARTIFACT_SERVER_PORT: String(port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBe(`http://127.0.0.2:${port}`)
    expect((await rawRequest(port, '/__wt-artifact-server/health', 'host.tailnet.ts.net')).status).toBe(200)
    expect((await rawRequest(port, '/__wt-artifact-server/health', `127.0.0.2:${port}`, '127.0.0.2')).status).toBe(200)
    expect((await rawRequest(port, '/__wt-artifact-server/register?session=remote&roots=%5B%5D', 'host.tailnet.ts.net')).status).toBe(404)
    expect((await rawRequest(port, '/__wt-artifact-server/health', 'evil.example')).status).toBe(421)
  })

  it('[B-02] sets remoteUrl to null when the stubbed tailscale binary is absent', async () => {
    const { project } = projectWithRoots('no-tailscale')
    const stateHome = temporaryDir('no-tailscale-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const bin = tailscaleStub('absent')
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: bin, WT_ARTIFACT_SERVER_PORT: String(port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBeNull()
  })

  it('[B-02] uses the HTTPS MagicDNS URL only when the stub reports a matching Serve proxy', async () => {
    const { project, reports } = projectWithRoots('tailscale-https')
    const artifact = join(reports, 'phone.md')
    writeFileSync(artifact, '# Phone')
    const stateHome = temporaryDir('tailscale-https-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const bin = tailscaleStub('https')
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, WT_ARTIFACT_SERVER_PORT: String(port),
    }))
    const state = await waitForState(stateHome, (value) => value.roots.length > 0)
    expect(state.remoteUrl).toBe('https://host.tailnet.ts.net')
    const remote = spawnSync(process.execPath, [SERVER, 'url', artifact, '--remote'], {
      encoding: 'utf8', env: baseEnv(stateHome),
    })
    expect(remote.status).toBe(0)
    expect(remote.stdout.trim()).toBe(`https://host.tailnet.ts.net/${basename(project)}-reports/phone.md`)
  })
})

describe('review decisions: serving security matrix', () => {
  it('[B-02][E-02][E-03] serves each type with CSP and rejects aliases, traversal, hosts, and methods', async () => {
    const project = temporaryDir('security-project')
    const root = temporaryDir('security-root')
    const outside = temporaryDir('security-outside')
    writeFileSync(join(root, 'report.md'), '# Report\n\n<script>alert(1)</script>')
    mkdirSync(join(root, 'index'))
    writeFileSync(join(root, 'index', '<script>.txt'), 'index')
    writeFileSync(join(root, 'plain.txt'), '<b>text</b>')
    writeFileSync(join(root, 'events.log'), 'event')
    writeFileSync(join(root, 'data.json'), '{"ok":true}')
    writeFileSync(join(root, 'active.html'), '<script>top.location="https://evil.example"</script>')
    writeFileSync(join(root, 'active.svg'), '<svg><script>alert(1)</script></svg>')
    writeFileSync(join(root, 'blob.bin'), 'blob')
    writeFileSync(join(root, '.env'), 'secret')
    writeFileSync(join(root, '.ENV.PROD'), 'secret')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), 'secret')
    writeFileSync(join(root, 'id_ed25519.pub'), 'secret')
    symlinkSync(join(root, '.git'), join(root, 'git-alias'))
    symlinkSync(join(root, '.ENV.PROD'), join(root, 'env-alias'))
    symlinkSync(join(root, 'id_ed25519.pub'), join(root, 'key-alias'))
    writeFileSync(join(outside, 'outside.txt'), 'secret')
    symlinkSync(join(outside, 'outside.txt'), join(root, 'escape.txt'))
    const stateHome = temporaryDir('security-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `artifacts=${root}`,
    }))
    await waitForState(stateHome, (state) => state.roots.some((entry) => entry.name === 'artifacts'))

    const markdown = await rawRequest(port, '/artifacts/report.md', `localhost:${port}`)
    expect(markdown.status).toBe(200)
    expect(markdown.body).toContain('&lt;script&gt;')
    expect(markdown.body).not.toContain('<script>')
    expect(markdown.headers['content-security-policy']).toMatch(/default-src 'none'/)
    for (const file of ['plain.txt', 'events.log', 'data.json']) {
      const response = await rawRequest(port, `/artifacts/${file}`, `localhost:${port}`)
      expect(response.status, file).toBe(200)
      expect(response.headers['content-type'], file).toMatch(/^text\/html/)
      expect(response.headers['content-security-policy'], file).toMatch(/default-src 'none'/)
    }
    for (const file of ['active.html', 'active.svg', 'blob.bin']) {
      const response = await rawRequest(port, `/artifacts/${file}`, `localhost:${port}`)
      expect(response.status, file).toBe(200)
      expect(response.headers['content-security-policy'], file).toBe("sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      expect(response.headers['x-content-type-options'], file).toBe('nosniff')
    }
    const index = await rawRequest(port, '/artifacts/index/', `localhost:${port}`)
    expect(index.status).toBe(200)
    expect(index.body).toContain('&lt;script&gt;.txt')
    expect(index.body).not.toContain('<script>')
    expect(index.headers['content-security-policy']).toMatch(/default-src 'none'/)
    const head = await rawRequest(port, '/artifacts/report.md', `localhost:${port}`, '127.0.0.1', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0)
    for (const file of ['.env', '.ENV.PROD', 'id_ed25519.pub', 'git-alias/config', 'env-alias', 'key-alias']) {
      expect((await rawRequest(port, `/artifacts/${file}`, `localhost:${port}`)).status, file).toBe(403)
    }
    expect((await rawRequest(port, '/artifacts/escape.txt', `localhost:${port}`)).status).toBe(403)
    for (const target of [
      '/artifacts/../outside.txt', '/artifacts/%2e%2e/outside.txt', '/artifacts/%252e%252e/outside.txt',
      '/artifacts/%2e%2e%2foutside.txt', '/artifacts/..%5coutside.txt', '/artifacts/%00.txt',
    ]) expect([403, 404]).toContain((await rawRequest(port, target, `localhost:${port}`)).status)
    expect((await rawRequest(port, '/artifacts/report.md', `localhost.evil.com:${port}`)).status).toBe(421)
    expect((await rawRequest(port, '/artifacts/report.md', '[::1]')).status).toBe(421)
    expect([400, 421]).toContain((await rawRequest(port, '/artifacts/report.md')).status)
    const post = await fetch(`http://127.0.0.1:${port}/artifacts/report.md`, {
      method: 'POST', headers: { Host: `localhost:${port}` },
    })
    expect(post.status).toBe(405)
    expect(post.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('[E-01][E-02] pins canonical roots and applies deny policy per registration', async () => {
    const project = temporaryDir('pin-project')
    const rootA = temporaryDir('policy-a')
    const rootB = temporaryDir('policy-b')
    writeFileSync(join(rootA, 'blocked-a'), 'a')
    writeFileSync(join(rootA, 'blocked-b'), 'a')
    writeFileSync(join(rootB, 'blocked-a'), 'b')
    writeFileSync(join(rootB, 'blocked-b'), 'b')
    const stateHome = temporaryDir('pin-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `a=${rootA}`, WT_ARTIFACT_SERVER_DENY: 'blocked-a',
    }))
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `b=${rootB}`, WT_ARTIFACT_SERVER_DENY: 'blocked-b',
    }))
    await waitForState(stateHome, (state) => state.roots.length === 2)
    expect((await rawRequest(port, '/a/blocked-a', `localhost:${port}`)).status).toBe(403)
    expect((await rawRequest(port, '/a/blocked-b', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/b/blocked-a', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/b/blocked-b', `localhost:${port}`)).status).toBe(403)

    const moved = `${rootA}-moved`
    renameSync(rootA, moved)
    symlinkSync(rootB, rootA)
    expect((await rawRequest(port, '/a/blocked-b', `localhost:${port}`)).status).toBe(403)
  })

  it('[E-02] rejects a root whose own canonical basename is denied', async () => {
    const project = temporaryDir('denied-root-project')
    const parent = temporaryDir('denied-root-parent')
    const root = join(parent, '.git')
    mkdirSync(root)
    writeFileSync(join(root, 'config'), 'secret')
    const stateHome = temporaryDir('denied-root-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `hidden=${root}` }))
    await waitForState(stateHome, (state) => state.roots.length === 1)
    expect((await rawRequest(port, '/hidden/config', `localhost:${port}`)).status).toBe(403)
  })

  it('[MISSED] returns 400 for malformed URLs and survives handler exceptions', async () => {
    const { project } = projectWithRoots('malformed')
    const stateHome = temporaryDir('malformed-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) }))
    await waitForState(stateHome)
    expect((await rawRequest(port, '//[', `localhost:${port}`)).status).toBe(400)
    expect((await rawRequest(port, '/__wt-artifact-server/health', `localhost:${port}`)).status).toBe(200)
  })

  it('[V4] returns null for discovery that differs from a live state only by a dead PID', () => {
    const artifact = join(temporaryDir('discovery-file'), 'report.md')
    writeFileSync(artifact, '# report')
    const stateHome = temporaryDir('discovery-absent')
    const env = baseEnv(stateHome)
    expect(artifactUrl(artifact, { env })).toBeNull()
    const absent = spawnSync(process.execPath, [SERVER, 'url', artifact], { encoding: 'utf8', env })
    expect(absent.status).toBe(3)
    mkdirSync(join(stateHome, 'wt-artifact-server'), { recursive: true })
    const discovery = {
      version: 'x', pid: process.pid, port: 48_001, baseUrl: 'http://localhost:48001', remoteUrl: null,
      roots: [{ name: 'reports', path: join(artifact, '..') }], startedAt: new Date().toISOString(),
    }
    writeFileSync(statePath(stateHome), JSON.stringify(discovery), { mode: 0o600 })
    chmodSync(statePath(stateHome), 0o600)
    expect(artifactUrl(artifact, { env })).toBe('http://localhost:48001/reports/report.md')
    writeFileSync(statePath(stateHome), JSON.stringify({ ...discovery, pid: 999_999 }))
    expect(artifactUrl(artifact, { env })).toBeNull()
    const stale = spawnSync(process.execPath, [SERVER, 'url', artifact], { encoding: 'utf8', env })
    expect(stale.status).toBe(3)
  })
})
