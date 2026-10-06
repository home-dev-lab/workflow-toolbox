// operator-cli-population.ts — the ONE definition of "which plugin/bin/*.mjs files are operator CLIs",
// shared by every test that sweeps them (cli-help.test.ts, cli-help-flag-value.test.ts), so the
// two sweeps can never disagree about the population.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
export const BIN_DIR = join(REPO_ROOT, 'plugin/bin')

// Files that legitimately do NOT get an operator --help, and WHY — never a silent exclusion.
// Both are `plugin/bin/*.mjs` matches (not filtered by the -hook.mjs discovery rule below), so
// without this list the sweep would wrongly flag them.
export const JUSTIFIED_EXCLUSIONS: Record<string, string> = {
  'wt-quota-probe.mjs':
    'Takes no arguments at all (usage is `node wt-quota-probe.mjs`, no flags) — it reads only ' +
    'the active config dir\'s stored OAuth credentials. Nothing to parse or describe beyond ' +
    'its own header comment; "every argument-parsing CLI" does not reach a CLI that parses none.',
  'wt-wake-channel.mjs':
    'MCP stdio server invoked only through plugin/.mcp.json, not an operator CLI. Its stdout is ' +
    'exclusively newline-delimited JSON-RPC, so emitting help text would corrupt the protocol.',
  'wt-suite-lock-run.mjs':
    'Variable-facing runner, not an operator CLI: every argv word must name a command literally, so ' +
    'reserving --help or -h would violate its lock-and-run contract. Use wt-suite-lock.mjs for operator help.',
  'wt-tsls.mjs':
    'LSP stdio transport launched from the plugin declaration: stdout must contain protocol frames only; '
    + 'there is no operator-facing argv contract or usage output.',
}

/**
 * The operator-CLI population: every plugin/bin/*.mjs file EXCEPT
 *   - a `*-hook.mjs` file — the harness invokes these with a JSON payload on stdin
 *     (PreToolUse/PostToolUse/SessionStart/Stop), never argv; --help is meaningless to a
 *     calling convention that never passes command-line flags at all.
 *   - anything under plugin/bin/lib/ — internal libraries, not invoked directly.
 *   - a `*.selftest.mjs` file — a known-answer selftest run as `node <file>` with no flags;
 *     it is a test, not an operator CLI, and its output is PASS/FAIL lines, not usage.
 * Derived from the directory listing, never a hand-kept name list — that is the whole point:
 * a CLI added next month is discovered by this glob on its very first run, not opted in later.
 */
export function allOperatorCliFiles(): string[] {
  return readdirSync(BIN_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('-hook.mjs') && !f.endsWith('.selftest.mjs'))
    .filter((f) => statSync(join(BIN_DIR, f)).isFile())
}

