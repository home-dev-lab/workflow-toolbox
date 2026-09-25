import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { census } from '../plugin-bin-import-safety-census.mjs'

// Locks the invariant: importing any module under plugin/bin/ must never run that module's
// CLI/hook entry point (no stdin read, no process.exit, no output). Regression case: on hosted
// Windows CI the test runner's own stdin is a pipe that is never closed. A module whose import
// unconditionally called its own main() — which read stdin via readFileSync(0) — blocked
// forever the moment a test imported it, and the whole vitest run hung to its 30-minute kill
// with no summary (CI run 36086352661, plugin/bin/wt-zsh-word-split-guard-hook.mjs).
//
// This test reproduces exactly that host condition — stdin left as an open, never-closed pipe —
// against every plugin/bin module the census (above) finds statically imported by a test, and
// requires each one to finish within a short bound instead of hanging.

const HANG_BOUND_MS = 4000

const scratchDir = mkdtempSync(join(tmpdir(), 'wt-plugin-bin-import-safety-'))

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true })
})

function importerScriptFor(modulePath: string) {
  const path = join(scratchDir, `${Buffer.from(modulePath).toString('hex')}.mjs`)
  const url = pathToFileURL(modulePath).href
  writeFileSync(
    path,
    `import(${JSON.stringify(url)}).then(() => { process.exit(0) }, () => { process.exit(0) })\n`,
  )
  return path
}

// Spawns a fresh Node process per module, stdin an open pipe we never write to or close — the
// exact shape of a CI runner's stdin. Resolves whether the import completed (any outcome) within
// the bound, or hung.
function importFinishesWithoutHang(modulePath: string): Promise<{ hung: boolean }> {
  const script = importerScriptFor(modulePath)
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolvePromise({ hung: true })
    }, HANG_BOUND_MS)
    child.on('exit', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ hung: false })
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ hung: false })
    })
    // Deliberately never write to or end child.stdin — that open, unclosed pipe is the
    // regression's exact trigger.
  })
}

const modules = census()

describe('plugin/bin modules imported by a test never run their entry on import', () => {
  it('census finds at least the modules known to be imported today', () => {
    // A sanity floor: if the census ever finds zero, it stopped walking the test tree rather
    // than legitimately finding nothing, since dozens of tests import plugin/bin helpers.
    expect(modules.length).toBeGreaterThan(0)
  })

  for (const { absolute, relative } of modules) {
    it(`${relative} finishes importing within ${HANG_BOUND_MS}ms with stdin held open`, async () => {
      const result = await importFinishesWithoutHang(absolute)
      expect(result.hung).toBe(false)
    })
  }
})
