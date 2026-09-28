import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { gateEnvironment } from '../../../../plugin/bin/lib/gate-evidence.mjs'

// Card 1873173639063406158: a variable the operator sets for the RUNNER must not reach the delivery's gates.
const RUNNER_ONLY = {
  WT_AGENT_SDK_PATH: '/tmp/runner-only-sdk/sdk.mjs',
  WT_EXECUTOR_CODE_MODEL: 'runner-only-model',
  WT_RUN_PIECES_TESTED: '1',
  WT_PLANKA_MCP_URL: 'http://runner-only.invalid/mcp',
  wt_lowercase_runner_key: 'dropped too (Windows keys are case-insensitive)',
}
const GATE_NEEDS = {
  PATH: '/usr/bin:/bin',
  HOME: '/tmp/wt-gate-env-home',
  LANG: 'C.UTF-8',
  WT_SUITE_LOCK: '1',
  WT_SUITE_LOCK_CMD: '/tmp/wt-suite-lock-run.mjs',
  WT_SUITE_LOCK_DIR: '/tmp/wt-gate-env-lock',
  WT_SUITE_LOCK_TIMEOUT: '7200',
  WT_TEST_MODE: 'blocking',
  WT_VITEST_MAX_WORKERS: '2',
}

describe('gate environment', () => {
  it('drops every runner WT_* key and keeps what a gate needs', () => {
    expect(gateEnvironment({ ...RUNNER_ONLY, ...GATE_NEEDS })).toEqual(GATE_NEEDS)
  })

  it('does not mutate the environment it reads', () => {
    const env = { ...RUNNER_ONLY, ...GATE_NEEDS }
    gateEnvironment(env)
    expect(env).toEqual({ ...RUNNER_ONLY, ...GATE_NEEDS })
  })
})
