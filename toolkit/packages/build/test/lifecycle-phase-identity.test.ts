import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

describe('lifecycle phase hook mirror', () => {
  it('is byte-identical to the state machine export', () => {
    expect(() => execFileSync(process.execPath, ['toolkit/scripts/mirror-lifecycle-phases.mjs', '--check'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    })).not.toThrow()
  })
})
