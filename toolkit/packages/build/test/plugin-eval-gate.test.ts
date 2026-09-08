import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const GATE = join(REPO_ROOT, 'plugin/bin/wt-plugin-eval-gate.mjs')

// The shape `claude plugin eval --json` wrote on 2026-09-07 (schemaVersion 1), reduced to the
// fields the gate reads. Kept INLINE: a fixture under the git-ignored `.lane/` directory exists
// only in the worktree that ran the eval and makes this lock fail everywhere else.
const FAILED_RESULT = {
  schemaVersion: '1',
  cases: [
    {
      name: 'external-lane-names-launcher',
      arms: { with: [{ score: 0, passed: false, graders: [{ name: 'criteria', passed: false, judgeVotes: [false, false, false] }] }] },
    },
  ],
}

function withFixture(content: unknown, body: (fixture: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-plugin-eval-gate-'))
  const fixture = join(dir, 'result.json')
  writeFileSync(fixture, JSON.stringify(content))
  try {
    body(fixture)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
    withFixture(FAILED_RESULT, (fixture) => {
      const result = run({ CLAUDE_CODE_WALNUT_SPIRE: '1', WT_PLUGIN_EVAL_RESULT: fixture })

      expect(result.status).toBe(1)
      expect(result.stdout).toContain('plugin eval: failed 1/1 case(s): external-lane-names-launcher')
    })
  })

  it('returns success for a recorded eval result when every case passed', () => {
    withFixture({ cases: [{ name: 'passing-case', arms: { with: [{ passed: true }] } }] }, (fixture) => {
      const result = run({ CLAUDE_CODE_WALNUT_SPIRE: '1', WT_PLUGIN_EVAL_RESULT: fixture })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('plugin eval: passed 1/1 case(s)')
    })
  })

  it('exits 2 when the recorded result cannot be read', () => {
    withFixture('not json', (fixture) => {
      const result = run({ CLAUDE_CODE_WALNUT_SPIRE: '1', WT_PLUGIN_EVAL_RESULT: fixture })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('plugin eval: invalid result')
    })
  })
})
