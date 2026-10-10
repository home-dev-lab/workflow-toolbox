#!/usr/bin/env node
// The toolkit's lint gate: toolkit/, shipped scripts and probes, then tracked scope.
//
// ESLint refuses to lint a file outside its base path, and `eslint .` run from toolkit/
// has toolkit/ as base path, so the plugin scripts under ../plugin and ../plugins were
// never read by this gate. The second pass runs ESLint from the repository root with the
// same config file, which puts those scripts inside the base path.
//
// The plugin pass reports errors only (`--quiet`): its warnings are the quality ratchet's
// business (`pnpm quality:lint`), and printing several hundred of them here would bury the
// errors this gate exists to surface.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isInvokedDirectly } from '../../plugin/bin/lib/host/entry-guard.mjs'
import { checkLintScope, GATE_PASSES, printLintScope } from './lint-scope.mjs'

export const TOOLKIT_ROOT = resolve(import.meta.dirname, '..')
export const REPO_ROOT = resolve(TOOLKIT_ROOT, '..')
const ESLINT_BIN = resolve(TOOLKIT_ROOT, 'node_modules/eslint/bin/eslint.js')

// Repo-root-relative globs for every script a shipped plugin carries.
export const PLUGIN_LINT_TARGETS = GATE_PASSES.find((pass) => pass.name === 'shipped-scripts').targets

export function lintPasses() {
  return GATE_PASSES.filter((pass) => pass.gate === 'lint').map((pass) => ({
    name: pass.name,
    cwd: resolve(REPO_ROOT, pass.cwd),
    args: [ESLINT_BIN, ...(pass.cwd === '.' ? ['--config', 'toolkit/eslint.config.mjs'] : []),
      ...(pass.quiet ? ['--quiet'] : []), ...pass.targets],
  }))
}

export function lintExitCode(failed, scope) {
  return failed || (scope.escaped.length ? 1 : 0)
}

async function main() {
  let failed = 0
  let scope = { escaped: [] }
  for (const pass of lintPasses()) {
    const result = spawnSync(process.execPath, pass.args, { cwd: pass.cwd, stdio: 'inherit' })
    if (result.error) process.stderr.write(`lint (${pass.name}): ${result.error.message}\n`)
    const status = result.status ?? 2
    if (status !== 0) {
      process.stderr.write(`lint (${pass.name}) exited ${status}\n`)
      failed = failed || status
    }
  }
  try {
    scope = await checkLintScope(REPO_ROOT)
    printLintScope(scope)
  } catch (error) {
    process.stderr.write(`lint (scope): ${error.message}\n`)
    failed = failed || 1
  }
  process.exitCode = lintExitCode(failed, scope)
}

if (isInvokedDirectly(import.meta.url)) {
  if (process.argv.includes('--help')) process.stdout.write('usage: lint-gate.mjs\nRuns toolkit and shipped-script lint passes, then checks tracked source coverage.\n')
  else await main()
}
