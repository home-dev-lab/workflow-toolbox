import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { main, scanRunsForPrune } from '../src/observe-cli.js'
import { readBootId, readProcStartStamp, pidAlive, pidIdentityMatches, pidState } from '../src/observe-identity.js'
import { serializeObservePidfile, type ObservePidfile } from '../src/observe-lifecycle.js'

const originalEnv = { ...process.env }
const made: string[] = []
let root: string
const servers: Server[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-observe-entry-'))
  made.push(root)
  process.env['XDG_STATE_HOME'] = join(root, 'state')
  process.env['XDG_CONFIG_HOME'] = join(root, 'config')
  process.env['CLAUDE_CONFIG_DIR'] = join(root, '.claude')
  process.env['OBSERVE_UI_SERVER_PORT'] = '1'
  mkdirSync(join(root, '.claude', 'projects'), { recursive: true })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) server.close()
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

function touch(path: string, body = '{}'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function runGit(args: string[], cwd?: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  expect(result.status, result.stderr || result.stdout).toBe(0)
}

function pidfile(overrides: Partial<ObservePidfile> = {}): ObservePidfile {
  return {
    pid: 2_147_483_647,
    port: 1,
    configDir: process.env['CLAUDE_CONFIG_DIR']!,
    bootId: 'not-this-boot',
    procStartTicks: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    sources: [process.env['CLAUDE_CONFIG_DIR']!],
    ...overrides,
  }
}

describe('wt-observe entry dispatch', () => {
  it('characterizes help, unknown commands, and config source/remote persistence', async () => {
    const source = join(root, 'source')
    mkdirSync(source)

    expect(await main(['--help'])).toBe(0)
    expect(await main(['-h'])).toBe(0)
    expect(await main(['launch', '--help'])).toBe(0)
    expect(await main(['launch', '-h'])).toBe(0)
    expect(await main(['constructor', '--help'])).toBe(2)
    expect(await main(['not-a-command'])).toBe(2)
    expect(await main(['config', 'not-an-action'])).toBe(2)
    expect(await main(['config', 'add-source', source])).toBe(0)
    expect(await main(['config', 'add-source', source])).toBe(0)
    expect(await main(['config'])).toBe(0)
    expect(await main(['config', 'show'])).toBe(0)
    expect(await main(['config', 'remove-source', source])).toBe(0)
    expect(await main(['config', 'remove-source', source])).toBe(0)
    expect(await main(['config', 'add-remote', 'https://example.test/', '--token-file', join(root, 'token')])).toBe(0)
    expect(await main(['config', 'add-remote', 'https://example.test/', '--token', 'secret', '--label', 'replaced'])).toBe(0)
    expect(await main(['config', 'add-remote', 'https://second.example.test/'])).toBe(0)
    expect(await main(['config', 'show'])).toBe(0)
    expect(await main(['config', 'remove-remote', 'https://example.test'])).toBe(0)
    expect(await main(['config', 'remove-remote', 'https://absent.example.test'])).toBe(0)
    expect(await main(['config', 'add-remote', 'file:///tmp/nope'])).toBe(1)
  })

  it('characterizes absent and stale pidfile status/stop behavior', async () => {
    expect(await main(['stop'])).toBe(0)
    expect(await main([])).toBe(0)
    expect(await main(['status'])).toBe(0)

    const path = join(process.env['XDG_STATE_HOME']!, 'wt-observe', 'server.json')
    touch(path, serializeObservePidfile(pidfile()))
    expect(await main(['status'])).toBe(0)
    expect(await main(['stop'])).toBe(0)
    expect(existsSync(path)).toBe(false)
  })

  it('prunes only completed matching runs and preserves live runs without JSON', async () => {
    const config = process.env['CLAUDE_CONFIG_DIR']!
    const session = join(config, 'projects', 'slug', 'session')
    const json = join(session, 'workflows', 'wf_characterized.json')
    const script = join(session, 'workflows', 'scripts', 'probe-characterized-wf_characterized.js')
    const liveScript = join(session, 'workflows', 'scripts', 'probe-live-wf_live.js')
    touch(json)
    touch(script, '// completed')
    touch(liveScript, '// live')

    expect(scanRunsForPrune([config, config])).toHaveLength(1)
    expect(await main(['prune', '--run', 'wf_characterized'])).toBe(0)
    expect(existsSync(json)).toBe(true)
    expect(await main(['prune', '--run', 'wf_characterized', '--yes'])).toBe(0)
    expect(existsSync(json)).toBe(false)
    expect(existsSync(liveScript)).toBe(true)
    expect(await main(['prune', '--older-than', 'nonsense'])).toBe(2)
    expect(await main(['prune', '--run', 'wf_absent'])).toBe(0)
  })

  it('drives launch, await, and resume against an identity-verified local server', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      const url = request.url ?? ''
      if (url === '/api/health') {
        response.end(JSON.stringify({
          app: 'observe-ui',
          pid: process.pid,
          port: (server.address() as { port: number }).port,
          configDir: process.env['CLAUDE_CONFIG_DIR'],
          startedAt: '2026-01-01T00:00:00.000Z',
          launchEnabled: true,
        }))
      } else if (url === '/api/launch') {
        response.end(JSON.stringify({ runId: 'wf_done' }))
      } else if (url === '/api/workflows') {
        response.end('[]')
      } else if (url === '/api/runs/live') {
        response.end(JSON.stringify([{ runId: 'wf_done', finished: true, status: 'completed' }]))
      } else if (url === '/api/runs/wf_done') {
        response.end(JSON.stringify({ status: 'completed', io: { result: { marker: 'characterized' } } }))
      } else if (url === '/api/runs/wf_done/recover') {
        response.end(JSON.stringify({ runId: 'wf_recovered' }))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'missing' }))
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const path = join(process.env['XDG_STATE_HOME']!, 'wt-observe', 'server.json')
    touch(path, serializeObservePidfile(pidfile({
      pid: process.pid,
      port,
      bootId: readBootId(),
      procStartTicks: readProcStartStamp(process.pid),
      token: 'characterization-token',
    })))

    expect(await main(['status'])).toBe(0)
    expect(await main(['launch', 'workflow.js', '--args', '{"perAgent":{"model":"sonnet"}}'])).toBe(0)
    expect(await main(['await', 'wf_done', '--poll-s', '0.001'])).toBe(0)
    expect(await main(['resume', 'wf_done'])).toBe(0)
  })

  it('fails launch inputs before contacting a server', async () => {
    expect(await main(['launch'])).toBe(1)
    expect(await main(['launch', 'workflow.js', '--args', '{'])).toBe(1)
    expect(await main(['launch', 'workflow.js', '--args', '{}'])).toBe(1)
    expect(await main(['launch', 'workflow.js', '--args', '{"perAgent":{"model":"sonnet"},"capabilities":7}'])).toBe(1)
    expect(await main(['await'])).toBe(1)
    expect(await main(['resume'])).toBe(1)
  })

  it('characterizes server-side launch refusals, failed await output, timeout, and recovery refusal', async () => {
    let mode = 'launch-404'
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      const port = (server.address() as { port: number }).port
      const url = request.url ?? ''
      if (url === '/api/health') {
        response.end(JSON.stringify({ app: 'observe-ui', pid: process.pid, port, configDir: process.env['CLAUDE_CONFIG_DIR'], startedAt: '2026-01-01T00:00:00.000Z' }))
      } else if (url === '/api/workflows') {
        response.end(JSON.stringify([{ id: 'available.js' }]))
      } else if (url === '/api/launch' && mode === 'launch-404') {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'unknown workflow' }))
      } else if (url === '/api/launch' && mode === 'launch-disabled') {
        response.statusCode = 403
        response.end(JSON.stringify({ error: 'disabled', code: 'launch-disabled' }))
      } else if (url === '/api/launch' && mode === 'token-rejected') {
        response.statusCode = 403
        response.end(JSON.stringify({ error: 'forbidden' }))
      } else if (url === '/api/runs/live' && mode === 'await-failed') {
        response.end(JSON.stringify([{ runId: 'wf_failed', finished: true, status: 'failed' }]))
      } else if (url === '/api/runs/wf_failed' && mode === 'await-failed') {
        response.end(JSON.stringify({ status: 'failed', error: 'characterized failure' }))
      } else if (url === '/api/runs/live' && mode === 'await-timeout') {
        response.end('[]')
      } else if (url === '/api/runs/wf_missing' && mode === 'await-timeout') {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'missing' }))
      } else if (url.endsWith('/recover') && mode === 'recover-refused') {
        response.statusCode = 409
        response.end(JSON.stringify({ error: 'not recoverable', code: 'not-failed' }))
      } else {
        response.statusCode = 500
        response.end(JSON.stringify({ error: 'unexpected test route' }))
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const path = join(process.env['XDG_STATE_HOME']!, 'wt-observe', 'server.json')
    touch(path, serializeObservePidfile(pidfile({
      pid: process.pid,
      port,
      bootId: readBootId(),
      procStartTicks: readProcStartStamp(process.pid),
      token: 'characterization-token',
    })))
    const launch = ['launch', 'workflow.js', '--args', '{"perAgent":{"model":"sonnet"}}']

    expect(await main(launch)).toBe(1)
    mode = 'launch-disabled'
    expect(await main(launch)).toBe(1)
    mode = 'token-rejected'
    expect(await main(launch)).toBe(1)
    mode = 'await-failed'
    expect(await main(['await', 'wf_failed', '--poll-s', '0.001'])).toBe(2)
    mode = 'await-timeout'
    expect(await main(['await', 'wf_missing', '--timeout-s', '-1', '--poll-s', '0.001'])).toBe(3)
    mode = 'recover-refused'
    expect(await main(['resume', 'wf_failed'])).toBe(2)
  })

  it('classifies malformed, foreign, timed-out, and multi-source health responses', async () => {
    let health: unknown = null
    let status = 200
    const server = createServer((_request, response) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(health))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    process.env['OBSERVE_UI_SERVER_PORT'] = String(port)

    expect(await main(['status'])).toBe(0)
    health = { app: 'other', pid: process.pid, port, configDir: root, startedAt: 'now' }
    expect(await main(['status'])).toBe(0)
    health = { app: 'observe-ui', pid: 'bad', port, configDir: root, startedAt: 'now' }
    expect(await main(['status'])).toBe(0)
    health = { app: 'observe-ui', pid: process.pid, port, startedAt: 'now' }
    expect(await main(['status'])).toBe(0)
    health = { app: 'observe-ui', pid: process.pid, port: port + 1, configDir: root, startedAt: 'now' }
    expect(await main(['status'])).toBe(0)
    health = { app: 'observe-ui', pid: process.pid, port, sources: [{ key: 'one', configDir: root }], startedAt: 'now', claude: null, claudeVersion: null, launchEnabled: false }
    expect(await main(['status'])).toBe(0)
    status = 503
    expect(await main(['status'])).toBe(0)
  })

  it('adopts a healthy server from a temporary main-branch Observatory checkout', async () => {
    const observeRoot = join(root, 'observatory')
    const app = join(observeRoot, 'apps', 'observe-ui')
    const source = join(root, 'source')
    const sourceTwo = join(root, 'source-two')
    mkdirSync(join(app, 'server'), { recursive: true })
    mkdirSync(join(app, 'dist', 'assets'), { recursive: true })
    mkdirSync(source)
    mkdirSync(sourceTwo)
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@workflow-toolbox/observe-ui' }))
    writeFileSync(join(app, 'server', 'dev-api.ts'), '// characterization fixture')
    writeFileSync(join(app, 'dist', 'assets', 'index-characterized.js'), '// fixture')
    runGit(['init', '--initial-branch=main', observeRoot])
    runGit(['config', 'user.name', 'Fixture'], observeRoot)
    runGit(['config', 'user.email', 'fixture@example.invalid'], observeRoot)
    runGit(['config', 'commit.gpgSign', 'false'], observeRoot)
    runGit(['add', '.'], observeRoot)
    runGit(['commit', '-m', 'fixture'], observeRoot)
    process.env['DWT_OBSERVE_ROOT'] = observeRoot

    let launchEnabled = true
    let multiSource = false
    const server = createServer((request, response) => {
      const port = (server.address() as { port: number }).port
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/health') {
        response.end(JSON.stringify({
          app: 'observe-ui',
          pid: process.pid,
          port,
          ...(multiSource
            ? { sources: [{ key: 'one', configDir: source }, { key: 'two', configDir: sourceTwo }] }
            : { configDir: source }),
          startedAt: '2026-01-01T00:00:00.000Z',
          launchEnabled,
        }))
      } else if (request.url === '/api/launch-enable') {
        response.statusCode = 204
        response.end()
      } else {
        response.statusCode = 404
        response.end('{}')
      }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const path = join(process.env['XDG_STATE_HOME']!, 'wt-observe', 'server.json')
    touch(path, serializeObservePidfile(pidfile({
      pid: process.pid,
      port,
      configDir: source,
      sources: [source],
      bootId: readBootId(),
      procStartTicks: readProcStartStamp(process.pid),
      token: 'characterization-token',
    })))

    expect(await main(['start', '--source', source, '--watch', '--enable-launch', '--no-resume'])).toBe(0)
    expect(await main(['start', '--source', sourceTwo])).toBe(0)
    launchEnabled = false
    expect(await main(['start', '--source', source, '--enable-launch'])).toBe(0)
    multiSource = true
    expect(await main(['start', '--source', source, '--source', sourceTwo, '--enable-launch'])).toBe(0)
    runGit(['switch', '-c', 'feature'], observeRoot)
    expect(await main(['start', '--source', source])).toBe(1)
    expect(await main(['start', '--source', source, '--allow-branch'])).toBe(0)
    expect(await main(['start', '--source', join(root, 'absent'), '--allow-branch'])).toBe(1)
  })
})

describe('observe process identity probes', () => {
  it('reads the current Linux identity and rejects missing, stale, and unknown identities', () => {
    const bootId = readBootId()
    const start = readProcStartStamp(process.pid)
    expect(bootId).toBeTruthy()
    expect(start).toEqual(expect.any(Number))
    expect(readProcStartStamp(2_147_483_647)).toBeNull()
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2_147_483_647)).toBe(false)

    const current = pidfile({ pid: process.pid, bootId, procStartTicks: start })
    expect(pidIdentityMatches(current)).toBe(true)
    expect(pidIdentityMatches({ ...current, bootId: null })).toBe(false)
    expect(pidIdentityMatches({ ...current, bootId: 'stale' })).toBe(false)
    expect(pidState(current)).toEqual({ alive: true, idMatch: true })
    expect(pidState(null)).toEqual({ alive: false, idMatch: false })
  })
})
