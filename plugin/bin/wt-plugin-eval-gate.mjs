#!/usr/bin/env node
// Release-only model gate. It deliberately never participates in pnpm test.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RESULT = process.env.WT_PLUGIN_EVAL_RESULT || join(ROOT, '.lane/plugin-eval-result.json')

function claudeBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN
  const installed = join(process.env.HOME || '', '.local/share/claude/versions')
  try {
    const latest = readdirSync(installed).sort().at(-1)
    if (latest) return join(installed, latest)
  } catch {
    // Normal installs expose `claude` on PATH instead.
  }
  return 'claude'
}

function failedCases(result) {
  if (!Array.isArray(result.cases)) throw new Error('result has no cases array')
  return result.cases.filter((item) => {
    const runs = item.arms?.with
    return !Array.isArray(runs) || runs.some((run) => run.passed !== true)
  })
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: wt-plugin-eval-gate.mjs\nRuns the release-only plugin eval suite when early access is enabled.\n')
    return 0
  }
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: wt-plugin-eval-gate.mjs\n')
    return 2
  }
  if (!process.env.CLAUDE_CODE_WALNUT_SPIRE) {
    process.stdout.write('plugin eval: not run (early access flag absent)\n')
    return 0
  }

  if (!process.env.WT_PLUGIN_EVAL_RESULT) {
    const claude = claudeBinary()
    const run = spawnSync(claude, [
      'plugin', 'eval', './plugin', '--runs', '1', '--ablation', 'none', '--no-publish',
      '--model', 'haiku', '--json', RESULT, '--report', join(ROOT, '.lane/plugin-eval-report.html'),
    ], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
    if (run.error) {
      process.stderr.write(`plugin eval: could not start ${claude}: ${run.error.message}\n`)
      return 2
    }
    if (run.status !== 0 && !existsSync(RESULT)) return run.status ?? 2
  }

  if (!existsSync(RESULT)) {
    process.stderr.write(`plugin eval: result missing: ${RESULT}\n`)
    return 2
  }
  try {
    const result = JSON.parse(readFileSync(RESULT, 'utf8'))
    const failed = failedCases(result)
    if (failed.length > 0) {
      process.stdout.write(`plugin eval: failed ${failed.length}/${result.cases.length} case(s): ${failed.map((item) => item.name).join(', ')}\n`)
      return 1
    }
    process.stdout.write(`plugin eval: passed ${result.cases.length}/${result.cases.length} case(s)\n`)
    return 0
  } catch (error) {
    process.stderr.write(`plugin eval: invalid result: ${error.message}\n`)
    return 2
  }
}

process.exitCode = main()
