// ci-lifecycle-smoke.mjs — cross-OS lifecycle smoke for `wt-observe` (card
// #1813359570421023938 item d): start → status (per-OS state root + PID identity
// probes) → stop, on whatever OS the CI runner provides. No Claude auth needed —
// this exercises the SERVER lifecycle (native state paths I1, identity probes I2,
// portable node+tsx spawn I3), not SDK launches.
//
// Run from toolkit/: `node scripts/ci-lifecycle-smoke.mjs`
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TOOLKIT = process.cwd()
const CLI = join(TOOLKIT, 'bin', 'wt-observe.mjs')

// A minimal fake Claude config dir (a `projects/` store) so source resolution
// has something concrete — CI runners have no ~/.claude.
const fakeConfig = join(tmpdir(), `ci-smoke-config-${String(process.pid)}`)
mkdirSync(join(fakeConfig, 'projects'), { recursive: true })

// SANDBOX both collision surfaces so this script can NEVER touch a real
// developer server (adopting + stopping the real 5174 instance is exactly what
// an unsandboxed run does — burnt live 2026-07-08):
// - a throwaway XDG_STATE_HOME (doubles as the I1 cross-OS assertion: an
//   explicit XDG override must win on EVERY platform, Windows/macOS included);
// - a dedicated port, never the real server's 5174.
const sandboxState = join(tmpdir(), `ci-smoke-state-${String(process.pid)}`)
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: fakeConfig,
  XDG_STATE_HOME: sandboxState,
  OBSERVE_UI_SERVER_PORT: '5197',
}
const run = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: TOOLKIT, env, encoding: 'utf8', timeout: 90_000 })

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`)
  process.exit(1)
}

// ── start ──
console.log('[smoke] start…')
const startOut = run(['start', '--source', fakeConfig])
console.log(startOut.trim())
if (!/started|adopted/.test(startOut)) fail(`unexpected start output`)

try {
  // ── status: per-OS state root + PID identity ──
  const statusOut = run(['status'])
  console.log(statusOut.trim())
  const pidfile = statusOut.match(/pidfile\s*:\s*(\S+)/)?.[1]
  if (pidfile === undefined) fail('status did not print the pidfile path')
  // I1 assertion, cross-OS: the explicit XDG_STATE_HOME override must WIN on every
  // platform (Windows/macOS natives only apply when no override is set — those exact
  // formulas are unit-tested in observe-lifecycle.test.ts; the smoke proves the
  // override path against the real OS).
  if (!pidfile.includes(sandboxState)) {
    fail(`pidfile ${pidfile} escaped the sandboxed XDG_STATE_HOME (${sandboxState}) — home is ${homedir()}`)
  }
  if (!statusOut.includes('identity OK')) fail('status did not report "identity OK" — per-OS PID identity probes broken')
} finally {
  // ── stop (always — never leak a server on the runner) ──
  console.log('[smoke] stop…')
  const stopOut = run(['stop'])
  console.log(stopOut.trim())
  if (!/stopped/.test(stopOut)) fail('stop did not report stopping the server')
}

const after = run(['status'])
if (/pid state\s*:\s*alive/.test(after)) fail('server still alive after stop')
console.log('[smoke] PASS — start/status/stop lifecycle green on', process.platform)
