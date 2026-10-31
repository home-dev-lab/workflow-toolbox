import fs, { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error ESM runtime module
import { launchProcessWithOutput, waitForLaneReceipt } from '../../../../plugin/bin/lib/lifecycle-receipts.mjs'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function outputDir() {
  const root = mkdtempSync(join(tmpdir(), 'wt-launch-output-'))
  roots.push(root)
  const dir = join(root, 'snapshot')
  fs.mkdirSync(dir)
  return { dir, stdoutPath: join(dir, 'launcher.stdout'), stderrPath: join(dir, 'launcher.stderr') }
}

describe('launchProcessWithOutput', () => {
  // wt-lane.mjs holds its launch admission until the new lane is counted, so a short lane can
  // finish, and its worker remove the --brief-cleanup-dir holding these two files, before the
  // launcher exits. The caller must still read what the launcher printed, and never hang.
  it('returns the launcher output even when its directory was removed before the launcher exited', async () => {
    const { dir, stdoutPath, stderrPath } = outputDir()
    const script = "process.stdout.write('pid=4242\\nrun=1-2\\n'); process.stderr.write('note\\n'); require('fs').rmSync(process.argv[1], { recursive: true, force: true })"
    const result = await launchProcessWithOutput(process.execPath, ['-e', script, dir], { stdoutPath, stderrPath })
    expect(fs.existsSync(dir)).toBe(false)
    expect(result).toEqual({ code: 0, stdout: 'pid=4242\nrun=1-2\n', stderr: 'note\n' })
  }, 15_000)

  it('rejects instead of hanging when the launcher output cannot be read back', async () => {
    const { stdoutPath, stderrPath } = outputDir()
    const failure = Object.assign(new Error('EIO: read failed'), { code: 'EIO' })
    vi.spyOn(fs, 'readSync').mockImplementation(() => { throw failure })
    await expect(launchProcessWithOutput(process.execPath, ['-e', "process.stdout.write('pid=1\\n')"], { stdoutPath, stderrPath })).rejects.toThrow('EIO')
  }, 15_000)
})

describe('waitForLaneReceipt', () => {
  // readAttestation reports the log's terminal EXIT= value as a string.
  const receipt = { exit: '0' }
  const reads = (content: string) => ({
    readAttestation: () => receipt,
    readRegularFile: () => content,
  })

  it('returns a receipt already on disk even when the deadline passed before the first read', async () => {
    // The clock jumps past the deadline between arming it and the first read, as it does when a
    // loaded host deschedules the process. A lane that already finished still counts.
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? 1_000 : 100_000))
    const entry = await waitForLaneReceipt({ log: 'lane.log', nonce: 'n1', timeoutMs: 60_000, pollMs: 1, ...reads('LANE_NONCE=n1\nEXIT=0\n') })
    expect(entry).toBe(receipt)
  })

  it('still times out when the log never carries the launch nonce', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 30_000))
    const entry = await waitForLaneReceipt({ log: 'lane.log', nonce: 'n1', timeoutMs: 60_000, pollMs: 1, ...reads('LANE_NONCE=other\nEXIT=0\n') })
    expect(entry).toBeNull()
  })
})
