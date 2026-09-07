import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GATE = join(REPO_ROOT, 'plugin/bin/wt-plugin-eval-gate.mjs')
const FIXTURE = join(REPO_ROOT, '.lane/first-run-result.json')

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [GATE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

describe('wt-plugin-eval-gate', () => {
  it('skips honestly when the early-access flag is absent', () => {
    const result = run({ CLAUDE_CODE_WALNUT_SPIRE: undefined })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('plugin eval: not run (early access flag absent)')
  })

  it('returns failure for a recorded eval result containing a failed case', () => {
    const result = run({
      CLAUDE_CODE_WALNUT_SPIRE: '1',
      WT_PLUGIN_EVAL_RESULT: FIXTURE,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('plugin eval: failed 1/1 case(s)')
  })

  it('returns success for a recorded eval result when every case passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-plugin-eval-gate-'))
    const fixture = join(dir, 'result.json')
    writeFileSync(fixture, JSON.stringify({ cases: [{ name: 'passing-case', arms: { with: [{ passed: true }] } }] }))
    try {
      const result = run({
        CLAUDE_CODE_WALNUT_SPIRE: '1',
        WT_PLUGIN_EVAL_RESULT: fixture,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('plugin eval: passed 1/1 case(s)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
