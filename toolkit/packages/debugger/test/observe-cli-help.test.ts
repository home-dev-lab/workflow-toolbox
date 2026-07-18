// observe-cli-help.test.ts — TEST-LOCK for the `wt-observe --help` / `<verb> --help`
// handler (card #1821921686266578632). The load-bearing invariant: `--help` resolves
// to usage text BEFORE dispatch, so `launch --help` prints help and NEVER attempts a
// launch (no fetch). Before the handler existed, `launch --help` read `--help` as the
// positional workflow name and tried to launch it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { main } from '../src/observe-cli.js'

/** Run main() with stdout/stderr captured and fetch blocked, so a launch attempt
 *  surfaces as a called fetch spy rather than a real network hit. */
async function runCli(argv: string[]): Promise<{ code: number; stdout: string; fetchCalls: number }> {
  let stdout = ''
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('network blocked in test'))
  try {
    const code = await main(argv)
    return { code, stdout, fetchCalls: fetchSpy.mock.calls.length }
  } finally {
    outSpy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('wt-observe --help / -h (global)', () => {
  it('--help prints the multi-verb usage and exits 0', async () => {
    const { code, stdout, fetchCalls } = await runCli(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: wt-observe')
    // The command list is present (a couple of representative verbs).
    expect(stdout).toContain('launch')
    expect(stdout).toContain('await')
    expect(fetchCalls).toBe(0)
  })

  it('-h is an alias for --help', async () => {
    const { code, stdout } = await runCli(['-h'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: wt-observe')
  })
})

describe('wt-observe <verb> --help (per-verb)', () => {
  it('launch --help prints usage, mentions the sidecar + registry, and NEVER launches', async () => {
    const { code, stdout, fetchCalls } = await runCli(['launch', '--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: wt-observe launch')
    // The card's explicit requirement: launch help documents the capability wiring.
    expect(stdout).toContain('.capabilities.json')
    expect(stdout).toContain('WT_CAPABILITY_REGISTRY')
    // The lock: help resolves before dispatch, so no launch is attempted.
    expect(fetchCalls).toBe(0)
  })

  it('await --help prints the await usage and exits 0 without a network call', async () => {
    const { code, stdout, fetchCalls } = await runCli(['await', '--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: wt-observe await')
    expect(fetchCalls).toBe(0)
  })

  it('config --help prints the config usage and exits 0', async () => {
    const { code, stdout } = await runCli(['config', '--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: wt-observe config')
  })

  it('-h after a verb works like --help', async () => {
    const { code, stdout } = await runCli(['resume', '-h'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: wt-observe resume')
  })

  // Regression lock (review finding, run cli2): an Object.prototype key as the "verb" must
  // NOT be treated as a known verb by the help guard. `cmd in SYNOPSIS` matched inherited
  // keys ('constructor', 'toString', '__proto__', …) and printed the stringified native
  // constructor with exit 0; the guard now uses Object.hasOwn, so these fall through to the
  // exit-2 unknown-command path exactly like any other unknown verb.
  it('a prototype-key "verb" + --help is an unknown command (exit 2), not garbage help (exit 0)', async () => {
    for (const proto of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      const { code, stdout, fetchCalls } = await runCli([proto, '--help'])
      expect(code, `${proto} --help should be unknown-command exit 2`).toBe(2)
      // No stringified function / native code leaked to stdout, and no launch attempted.
      expect(stdout).toBe('')
      expect(fetchCalls).toBe(0)
    }
  })
})
