import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectSlug } from '../src/source.js'

const originalEnv = { ...process.env }
const systemTmp = tmpdir()
const HERE = dirname(fileURLToPath(import.meta.url))
const COMPLETED = join(HERE, 'fixtures', 'real-completed.json')
const made: string[] = []

afterEach(() => {
  process.env = { ...originalEnv }
  vi.restoreAllMocks()
  vi.resetModules()
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function runHook(input: string, setup?: (root: string) => void): Promise<{ stdout: string; stderr: string }> {
  const root = mkdtempSync(join(systemTmp, 'wt-stop-entry-'))
  made.push(root)
  process.env['TMPDIR'] = root
  process.env['CLAUDE_CONFIG_DIR'] = join(root, '.claude')
  delete process.env['DWT_WORKFLOW_LOG_DIR']
  setup?.(root)

  const stdout: string[] = []
  const stderr: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  vi.spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin)
  vi.spyOn(process.stdin, 'on').mockImplementation(((event: string, listener: (value?: string) => void) => {
    if (event === 'data') listener(input)
    if (event === 'end') listener()
    return process.stdin
  }) as typeof process.stdin.on)

  await import('../src/stop-hook.js')
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalled())
  return { stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('Stop-hook source entry', () => {
  it('fails open for malformed input', async () => {
    expect((await runHook('{')).stdout).toBe('{}')
  })

  it('emits nothing stateful when the payload has no session id', async () => {
    expect((await runHook(JSON.stringify({ cwd: '/tmp/no-session' }))).stdout).toBe('{}')
  })

  it('fails open when the entry self-test forces an asynchronous rejection', async () => {
    const result = await runHook('{}', () => {
      process.env['WT_FAIL_OPEN_TRACE_SELF_TEST'] = 'wt-stop-hook.mjs'
    })
    expect(result.stdout).toBe('{}')
    expect(result.stderr).toContain('FAILED OPEN - forced fail-open self-test')
    delete process.env['WT_FAIL_OPEN_TRACE_SELF_TEST']
  })

  it('writes empty state and emits an empty surface when no workflows are present', async () => {
    const result = await runHook(JSON.stringify({
      session_id: 'session-characterization',
      cwd: '/tmp/stop-hook-characterization',
      stop_hook_active: false,
      background_tasks: [],
    }))
    expect(result.stdout).toBe('{}')
    expect(result.stderr).toBe('')
  })

  it('resolves a completed workflow journal and emits its full audit surface', async () => {
    const cwd = '/tmp/stop-hook-full-characterization'
    const sessionId = 'session-full-characterization'
    const result = await runHook(JSON.stringify({
      session_id: sessionId,
      cwd,
      stop_hook_active: false,
      background_tasks: [{ id: 'wsmktx6hv', type: 'workflow', status: 'completed', name: 'characterized' }],
    }), (root) => {
      const dir = join(root, '.claude', 'projects', projectSlug(cwd), sessionId, 'workflows')
      mkdirSync(dir, { recursive: true })
      copyFileSync(COMPLETED, join(dir, 'wf_characterized.json'))
    })
    expect(result.stdout).toContain('wf_characterized')
    expect(result.stderr).toBe('')
  })
})
