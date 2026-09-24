import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HARNESS = fileURLToPath(new URL('../process-enumeration-load.mjs', import.meta.url))

describe('process-enumeration load harness', () => {
  it('runs a command with at least six unrelated parents, children, and held file descriptors alive', () => {
    const result = spawnSync(process.execPath, [HARNESS, '--workers', '6', '--', process.execPath, '-e', "process.stdout.write(process.env.WT_PROCESS_LOAD_COUNT ?? '')"], {
      encoding: 'utf8',
      timeout: 15_000,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('6')
    expect(result.stderr).toContain('ready workers=6 children=6 held_fds=48')
  })
})
