import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const HOOK = join(PLUGIN_ROOT, 'bin', 'wt-artifact-server-context-hook.mjs')
const SERVER = join(PLUGIN_ROOT, 'bin', 'wt-artifact-server.mjs')
const temporaryDirs: string[] = []
const servers: Server[] = []

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-artifact-context-')))
  temporaryDirs.push(dir)
  return dir
}

function runHook(stateHome: string, source?: string) {
  return new Promise<{ status: number | null, stdout: string, stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, XDG_STATE_HOME: stateHome },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('exit', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fresh-session', ...(source ? { source } : {}) }))
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function liveServerFixture() {
  const stateHome = fixture()
  const reports = join(fixture(), 'reports')
  mkdirSync(reports)
  const report = join(reports, 'report.md')
  writeFileSync(report, '# report')
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      service: 'workflow-toolbox-artifact-server', version: 'test', pid: process.pid,
      uid: typeof process.getuid === 'function' ? process.getuid() : userInfo().username,
      port: (server.address() as { port: number }).port, registeredSessions: 1,
    }))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  const stateDir = join(stateHome, 'wt-artifact-server')
  mkdirSync(stateDir, { recursive: true })
  const discovery = join(stateDir, 'server.json')
  writeFileSync(discovery, JSON.stringify({
    version: 'test', pid: process.pid, port, baseUrl: `http://localhost:${port}`, remoteUrl: null,
    roots: [{ name: 'reports', path: reports }], startedAt: new Date().toISOString(),
  }))
  chmodSync(discovery, 0o600)
  return { stateHome, report, port }
}

describe('artifact server SessionStart context', () => {
  it('tells a fresh session how to turn an absolute report path into a link when the server is live', async () => {
    const { stateHome, report, port } = await liveServerFixture()

    const hook = await runHook(stateHome)
    expect(hook.status).toBe(0)
    const output = JSON.parse(hook.stdout) as { hookSpecificOutput: { hookEventName: string, additionalContext: string } }
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext.split('\n')).toHaveLength(1)
    expect(output.hookSpecificOutput.additionalContext).toContain('wt-artifact-server.mjs\" url \"<absolute-file-path>\"')

    const url = spawnSync(process.execPath, [SERVER, 'url', report], {
      encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: stateHome },
    })
    expect(url.status).toBe(0)
    expect(url.stdout.trim()).toBe(`http://localhost:${port}/reports/report.md`)
  })

  it('announces a command the session shell can run as written, without CLAUDE_PLUGIN_ROOT', async () => {
    const { stateHome, report, port } = await liveServerFixture()
    const hook = await runHook(stateHome)
    const context = (JSON.parse(hook.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    const announced = /run (node .+?) and hand over/.exec(context)?.[1]
    expect(announced).toBeDefined()
    const shellEnv: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: stateHome }
    delete shellEnv.CLAUDE_PLUGIN_ROOT
    const run = spawnSync(String(announced).replace('<absolute-file-path>', report), {
      encoding: 'utf8', shell: true, env: shellEnv,
    })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe(`http://localhost:${port}/reports/report.md`)
    expect(context).not.toContain('${')
  })

})

describe('artifact server SessionStart context — source and availability', () => {
  it('is silent after a compaction, live server or not', async () => {
    const { stateHome } = await liveServerFixture()
    expect((await runHook(stateHome, 'compact')).stdout).toBe('')
    expect((await runHook(fixture(), 'compact')).stdout).toBe('')
  })

  it('keeps its startup output unchanged: the same text as a payload with no source', async () => {
    const { stateHome } = await liveServerFixture()
    const startup = (await runHook(stateHome, 'startup')).stdout
    expect(startup).toContain('Artifact server is running')
    expect((await runHook(stateHome)).stdout).toBe(startup)
  })

  it('reports unknown without link instructions when the server is stopped', async () => {
    const result = await runHook(fixture())
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }
    expect(output.hookSpecificOutput.additionalContext).toMatch(/status is unknown.*no live server was verified/i)
    expect(output.hookSpecificOutput.additionalContext).not.toContain('wt-artifact-server.mjs" url')
  })

  it('is registered for SessionStart and the skill names the handoff moment and absolute path', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> }
    }
    const commands = manifest.hooks.SessionStart.flatMap((entry) => entry.hooks.map((hook) => hook.command))
    expect(commands.some((command) => command.includes('wt-artifact-server-context-hook.mjs'))).toBe(true)
    const skill = readFileSync(join(PLUGIN_ROOT, 'skills', 'artifact-server', 'SKILL.md'), 'utf8')
    expect(skill).toContain('argument-hint: "[absolute-file-path]"')
    expect(skill).toMatch(/hand(?:ing)? (?:the user )?(?:a |the )?(?:report|artifact).*path/i)
  })
})
