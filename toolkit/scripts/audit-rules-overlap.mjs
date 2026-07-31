#!/usr/bin/env node
// audit-rules-overlap.mjs — maintainer-facing wrapper around the plugin's own
// `install-rules.mjs --audit-overlap --set rules`, exposed as `pnpm audit:rules-overlap`.
//
// WHY A WRAPPER INSTEAD OF CALLING install-rules.mjs DIRECTLY. `--audit-overlap` requires an
// explicit `--user-dir`, and on a maintainer's machine WITHOUT this project's own local rules
// layout (no `<config dir>/rules`), install-rules.mjs's own `fail()` on a missing dir exits 1
// — a HARD failure a maintainer without that layout cannot act on. This wrapper resolves the
// user's rules dir the same way `--global` does elsewhere in the tool (CLAUDE_CONFIG_DIR, or
// ~/.claude when unset), checks it EXISTS first, and only then defers to the real script — it
// does not reimplement any comparison logic, only the existence pre-check.
//
// EXIT CODE CONTRACT:
//   0  — no private rules dir found here (not applicable on this machine) — explicit message,
//        not silence, so a maintainer can tell "nothing to check" apart from "checked, clean".
//   0  — private rules dir found, audited, no non-partial duplicate/drift/unpaired finding.
//   1  — private rules dir found, audited, at least one non-partial finding (install-rules.mjs
//        decides this — see its own `partial` handling for e.g. delegation-lanes.md, which by
//        design never flips this to 1).
//
// This script never writes anything and never touches the plugin's `rule-pairs.json` — it is
// a thin, safe-to-run-anywhere entry point over a read-only audit.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_RULES = path.join(HERE, '..', '..', 'plugin', 'skills', 'adopt-rules', 'scripts', 'install-rules.mjs')

const configRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const userRulesDir = path.join(configRoot, 'rules')

if (!fs.existsSync(userRulesDir) || !fs.statSync(userRulesDir).isDirectory()) {
  console.log(
    `audit-rules-overlap: not applicable here — no local rules dir to compare ` +
      `(looked for ${userRulesDir}). Nothing to audit on this machine.`,
  )
  process.exit(0)
}

const result = spawnSync(
  process.execPath,
  [INSTALL_RULES, '--audit-overlap', '--set', 'rules', '--user-dir', userRulesDir],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
