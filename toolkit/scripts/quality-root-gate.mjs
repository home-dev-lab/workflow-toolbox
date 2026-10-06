#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { isInvokedDirectly } from '../../plugin/bin/lib/host/entry-guard.mjs'
import { GATE_PASSES } from './lint-scope.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

// The gate and planted-fault witnesses use this same pass, including file selection.
export async function runAreaPass(area, { root: passRoot = root } = {}) {
  const eslint = new ESLint({ cwd: passRoot, overrideConfigFile: resolve(passRoot, 'toolkit/eslint.config.mjs') })
  const results = await eslint.lintFiles(area.targets)
  const warnings = results.reduce((sum, result) => sum + result.warningCount, 0)
  const errors = results.reduce((sum, result) => sum + result.errorCount, 0)
  const name = area.name.replace(/^area:/, '')
  const line = `quality:lint area ${name}: ${warnings} warnings, ${errors} errors (warn-only; a follow-up sets its ratchet)`
  const formatter = await eslint.loadFormatter('stylish')
  return { warnings, errors, line, results, output: formatter.format(results) }
}

function run(argv) {
  const result = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' })
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  return result.status ?? 2
}

export function qualityExitCode(failed, areaResults) {
  return failed || (areaResults.some((result) => result.errors > 0) ? 1 : 0)
}

async function main(gate) {
  if (gate === 'dead') {
    process.exitCode = run(['toolkit/node_modules/knip/bin/knip.js', '--config', 'knip.json', '--max-issues', '189'])
    return
  }
  if (gate !== 'lint') throw new Error('usage: quality-root-gate.mjs lint|dead')
  let failed = 0
  const areaResults = []
  for (const pass of GATE_PASSES.filter((pass) => pass.gate === 'quality')) {
    if (pass.warnOnly) {
      const result = await runAreaPass(pass)
      areaResults.push(result)
      process.stdout.write(result.output)
      process.stdout.write(`${result.line}\n`)
    } else {
      const status = run(['toolkit/node_modules/eslint/bin/eslint.js', '--config', 'toolkit/eslint.config.mjs',
        ...pass.targets, '--max-warnings', String(pass.maxWarnings)])
      failed = failed || status
    }
  }
  process.exitCode = qualityExitCode(failed, areaResults)
}

if (isInvokedDirectly(import.meta.url)) {
  if (process.argv.includes('--help')) process.stdout.write('usage: quality-root-gate.mjs lint|dead\nRuns the quality ratchet and per-area warning counts, or dead-code checks.\n')
  else await main(process.argv[2])
}
