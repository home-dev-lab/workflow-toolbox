// The environment a run's gates (`pnpm typecheck|lint|test` over the delivery) receive.
//
// WT_* is the toolbox's own configuration namespace. The operator sets such variables for the RUNNER
// (WT_AGENT_SDK_PATH, WT_EXECUTOR_*_MODEL, WT_RUN_PIECES_TESTED, WT_PLANKA_MCP_URL, ...); the gates test
// the toolbox itself, so any of them reaching the delivery's suite makes its verdict depend on how the
// runner was launched (card 1873173639063406158: WT_AGENT_SDK_PATH turned two correct tests red).
// Every WT_* key is therefore dropped, except the ones that configure the GATE machinery rather than
// the product under test. Everything outside WT_* (PATH, HOME, locale, temp, Windows system keys)
// passes unchanged: a gate cannot run without it, and an allow-list of it would differ per platform.
const GATE_WT_KEYS = Object.freeze([
  'WT_SUITE_LOCK', // `0` bypasses the machine-wide suite lock (wt-suite-lock.mjs)
  'WT_SUITE_LOCK_CMD', // the lock runner a lane invokes (wt-suite-lock-run.mjs)
  'WT_SUITE_LOCK_DIR', // where the suite lock lives
  'WT_SUITE_LOCK_TIMEOUT', // how long a suite waits for the lock
  'WT_TEST_MODE', // vitest.config.mts: all | blocking | quarantine
  'WT_VITEST_MAX_WORKERS', // vitest.config.mts: worker ceiling on a loaded machine
])

const KEEP = new Set(GATE_WT_KEYS)

export function gateEnvironment(env = process.env) {
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/^WT_/i.test(key) && !KEEP.has(key.toUpperCase())) continue
    result[key] = value
  }
  return result
}
