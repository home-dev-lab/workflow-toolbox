import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HARNESS = fileURLToPath(new URL('../process-enumeration-load.mjs', import.meta.url))

function descendantsOf(rootPid: number): number[] {
  const table = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).stdout
    .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
  const descendants: number[] = []
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.pop()
    for (const [pid, ppid] of table) {
      if (ppid === parent) {
        descendants.push(pid)
        pending.push(pid)
      }
    }
  }
  return descendants
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch {}
}

async function runHarness(
  args: string[],
  inspectStderr?: (stderr: string, pid: number) => void,
): Promise<{ status: number | null, stdout: string, stderr: string }> {
  const child = spawn(process.execPath, [HARNESS, ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let exited = false
  const result = new Promise<{ status: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      try { inspectStderr?.(stderr, child.pid!) } catch (error) { reject(error) }
    })
    child.once('error', reject)
    child.once('close', (status) => { exited = true; resolve({ status, stdout, stderr }) })
  })
  const timeout = setTimeout(() => killTree(child.pid!), 30_000)
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    if (!exited || process.platform !== 'win32') killTree(child.pid!)
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
}

describe('process-enumeration load harness', () => {
  it('runs a command with at least six unrelated parents, children, and held file descriptors alive', async () => {
    const result = await runHarness(['--workers', '6', '--', process.execPath, '-e', "process.stdout.write(process.env.WT_PROCESS_LOAD_COUNT ?? '')"])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('6')
    expect(result.stderr).toContain('ready workers=6 children=6 held_fds=48')
  }, 40_000)

  it.skipIf(process.platform === 'win32')('leaves no survivor when the harness is interrupted', async () => {
    let descendants: number[] = []
    await expect(runHarness(
      ['--workers', '6', '--', process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      (stderr, pid) => {
        if (!stderr.includes('ready workers=6')) return
        descendants = descendantsOf(pid)
        throw new Error('intentional failure after process tree became ready')
      },
    )).rejects.toThrow('intentional failure after process tree became ready')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(descendants.filter(isAlive)).toEqual([])
  })
})
