import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { busyProgram, stopLoadProcesses } from '../suite-under-load.mjs'

const children: ReturnType<typeof spawn>[] = []

function exited(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) await exited(child)
  }
})

describe('suite-under-load cleanup', () => {
  it('reports an unverified child and still stops every later verified load process', async () => {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    children.push(gone)
    await exited(gone)
    const live = spawn(process.execPath, ['-e', busyProgram], { stdio: 'ignore' })
    children.push(live)
    const liveExit = exited(live)
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => stopLoadProcesses([gone, live])).not.toThrow()
    await liveExit

    expect(report).toHaveBeenCalledWith(expect.stringContaining(`unverified load pid ${gone.pid}`))
    expect(live.signalCode).toBe('SIGKILL')
  })
})
