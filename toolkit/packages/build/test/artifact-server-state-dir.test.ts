import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { ensureSecureStateDir, stateDirModeBitsEnforced } from '../../../../plugin/bin/lib/artifact-server.mjs'

// Measured 2026-09-17 (cross-os run 33, the first Windows execution of the artifact-server suite): every ensure
// timed out because the server refused its state directory with `group- or world-writable` — on win32 Node's
// synthetic mode carries the group/other write bits for every directory. The check is a POSIX contract.
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('artifact server state directory', () => {
  it.skipIf(process.platform === 'win32')('refuses a group- or world-writable state directory on POSIX and accepts it under the win32 contract', () => {
    const home = mkdtempSync(join(tmpdir(), 'wt-artifact-state-')); roots.push(home)
    const stateDir = join(home, 'wt-artifact-server')
    mkdirSync(stateDir, { recursive: true }); chmodSync(stateDir, 0o777)
    const env = { XDG_STATE_HOME: home }
    expect(() => ensureSecureStateDir({ env, platform: 'linux' })).toThrow(/group- or world-writable/)
    expect(ensureSecureStateDir({ env, platform: 'win32' })).toBe(stateDir)
  })

  it('states where mode bits are enforced', () => {
    expect(stateDirModeBitsEnforced('linux')).toBe(true)
    expect(stateDirModeBitsEnforced('darwin')).toBe(true)
    expect(stateDirModeBitsEnforced('win32')).toBe(false)
  })
})
