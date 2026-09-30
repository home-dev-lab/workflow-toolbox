#!/usr/bin/env node
// The toolkit's lint gate: `eslint .` over toolkit/, then the shipped plugin scripts.
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
import { pathToFileURL } from 'node:url'

export const TOOLKIT_ROOT = resolve(import.meta.dirname, '..')
export const REPO_ROOT = resolve(TOOLKIT_ROOT, '..')
const ESLINT_BIN = resolve(TOOLKIT_ROOT, 'node_modules/eslint/bin/eslint.js')

// Repo-root-relative globs for every script a shipped plugin carries.
export const PLUGIN_LINT_TARGETS = ['plugin/**/*.mjs', 'plugin/**/*.js', 'plugins/**/*.mjs', 'plugins/**/*.js']

export function lintPasses() {
  return [
    { name: 'toolkit', cwd: TOOLKIT_ROOT, args: [ESLINT_BIN, '.'] },
    {
      name: 'plugins',
      cwd: REPO_ROOT,
      args: [ESLINT_BIN, '--config', 'toolkit/eslint.config.mjs', '--quiet', ...PLUGIN_LINT_TARGETS],
    },
  ]
}

function main() {
  let failed = 0
  for (const pass of lintPasses()) {
    const result = spawnSync(process.execPath, pass.args, { cwd: pass.cwd, stdio: 'inherit' })
    if (result.error) process.stderr.write(`lint (${pass.name}): ${result.error.message}\n`)
    const status = result.status ?? 2
    if (status !== 0) {
      process.stderr.write(`lint (${pass.name}) exited ${status}\n`)
      failed = failed || status
    }
  }
  process.exitCode = failed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
