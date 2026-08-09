// cli-help.test.ts — locks the INVARIANT ("every operator-facing wt-* CLI answers --help/-h
// with its own usage and exits 0, and still refuses an unknown flag"), never an enumeration of
// today's binaries. This test globs plugin/bin/*.mjs itself, so a CLI added next month is
// covered automatically — a hardcoded list would stay green the day a 25th binary ships with
// no --help, exactly the convention nobody enforced that this test exists to replace.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN_DIR = join(REPO_ROOT, 'plugin/bin')

// Files that legitimately do NOT get an operator --help, and WHY — never a silent exclusion.
// Both are `plugin/bin/*.mjs` matches (not filtered by the -hook.mjs discovery rule below), so
// without this list the sweep would wrongly flag them.
const JUSTIFIED_EXCLUSIONS: Record<string, string> = {
  'wt-quota-probe.mjs':
    'Takes no arguments at all (usage is `node wt-quota-probe.mjs`, no flags) — it reads only ' +
    'the active config dir\'s stored OAuth credentials. Nothing to parse or describe beyond ' +
    'its own header comment; "every argument-parsing CLI" does not reach a CLI that parses none.',
  'wt-wake-channel.mjs':
    'MCP stdio server invoked only through plugin/.mcp.json, not an operator CLI. Its stdout is ' +
    'exclusively newline-delimited JSON-RPC, so emitting help text would corrupt the protocol.',
}

/**
 * The operator-CLI population: every plugin/bin/*.mjs file EXCEPT
 *   - a `*-hook.mjs` file — the harness invokes these with a JSON payload on stdin
 *     (PreToolUse/PostToolUse/SessionStart/Stop), never argv; --help is meaningless to a
 *     calling convention that never passes command-line flags at all.
 *   - anything under plugin/bin/lib/ — internal libraries, not invoked directly.
 * Derived from the directory listing, never a hand-kept name list — that is the whole point:
 * a CLI added next month is discovered by this glob on its very first run, not opted in later.
 */
function allOperatorCliFiles(): string[] {
  return readdirSync(BIN_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('-hook.mjs'))
    .filter((f) => statSync(join(BIN_DIR, f)).isFile())
}

function runCli(file: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(BIN_DIR, file), ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('cli-help — every operator wt-* CLI answers --help with usage and exits 0', () => {
  const files = allOperatorCliFiles()

  it('discovers real files, and the exclusion list names only files that still exist', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const name of Object.keys(JUSTIFIED_EXCLUSIONS)) {
      expect(files.includes(name), `exclusion names ${name}, which no longer exists under plugin/bin/`).toBe(true)
    }
  })

  const eligible = files.filter((f) => !JUSTIFIED_EXCLUSIONS[f])

  it.each(eligible)('%s: --help prints non-empty usage and exits 0', (file) => {
    const r = runCli(file, ['--help'])
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stdout.trim().length).toBeGreaterThan(0)
  })

  it.each(eligible)('%s: -h behaves identically to --help', (file) => {
    const r = runCli(file, ['-h'])
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stdout.trim().length).toBeGreaterThan(0)
  })

  it.each(eligible)('%s: an unknown flag still refuses and still exits non-zero (help did not make the parser permissive)', (file) => {
    const r = runCli(file, ['--this-flag-does-not-exist-cli-help-probe'])
    expect(r.status).not.toBe(0)
  })

  it.each(eligible)('%s: usage text is the CLI\'s own, not a generic banner (mentions its own basename)', (file) => {
    const r = runCli(file, ['--help'])
    // Weak-but-real anti-genericism check: the printed help must name the binary itself
    // somewhere (its own header comment or usage line almost always does), not just a
    // one-line "OK" — the length check above already rules that out; this rules out a
    // copy-pasted banner shared byte-for-byte across every CLI.
    expect(r.stdout).toContain(file.replace(/\.mjs$/, ''))
  })
})

describe('cli-help — exclusion reasons are non-empty prose, not a placeholder', () => {
  for (const [name, reason] of Object.entries(JUSTIFIED_EXCLUSIONS)) {
    it(`${name}: has a real reason`, () => {
      expect(reason.length).toBeGreaterThan(20)
    })
  }
})

// Sanity: the source files referenced by this test actually live where expected, so a future
// repo reshuffle fails loudly here rather than as a silent 0-file sweep everywhere above.
describe('cli-help — sweep sanity', () => {
  it('plugin/bin contains more than just this test\'s own fixtures', () => {
    expect(readFileSync(join(BIN_DIR, 'wt-quota-probe.mjs'), 'utf8').length).toBeGreaterThan(0)
  })
})
