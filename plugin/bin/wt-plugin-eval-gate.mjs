#!/usr/bin/env node
// Release-only model gate. Declared sandbox limitations are allowed until they resolve.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RESULT = process.env.WT_PLUGIN_EVAL_RESULT || join(ROOT, '.lane/plugin-eval-result.json')
const EXPECTED_FAILURES = join(ROOT, 'plugin/evals/expected-failures.json')

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

function expectedFailures() {
  if (!existsSync(EXPECTED_FAILURES)) return new Map()
  const declarations = JSON.parse(readFileSync(EXPECTED_FAILURES, 'utf8'))
  if (!Array.isArray(declarations)) throw new Error('declaration file must contain an array')
  const expected = new Map()
  for (const declaration of declarations) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
      throw new Error('each declaration must be an object')
    }
    const { case: name, reason, until } = declaration
    if (typeof name !== 'string' || !name || typeof reason !== 'string' || !reason) {
      throw new Error('each declaration requires non-empty case and reason strings')
    }
    if (until !== undefined && (typeof until !== 'string' || !until)) {
      throw new Error('declaration until must be a non-empty string when present')
    }
    if (expected.has(name)) throw new Error(`duplicate declaration for ${name}`)
    expected.set(name, { reason })
  }
  return expected
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: wt-plugin-eval-gate.mjs\nRuns the release-only plugin eval suite when early access is enabled, allowing declared expected failures.\n')
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
    let expected
    try {
      expected = expectedFailures()
    } catch (error) {
      process.stderr.write(`plugin eval: invalid expected failures: ${error.message}\n`)
      return 2
    }
    const failedNames = new Set(failed.map((item) => item.name))
    const expectedFailed = failed.filter((item) => expected.has(item.name))
    const unexpectedFailed = failed.filter((item) => !expected.has(item.name))
    const nowPassing = result.cases.filter((item) => expected.has(item.name) && !failedNames.has(item.name))
    for (const item of expectedFailed) {
      process.stdout.write(`plugin eval: expected failure ${item.name} — ${expected.get(item.name).reason}\n`)
    }
    for (const item of nowPassing) {
      process.stdout.write(`plugin eval: expected failure ${item.name} now passes — remove its declaration\n`)
    }
    const passed = result.cases.length - failed.length
    process.stdout.write(`plugin eval: passed ${passed}/${result.cases.length}, expected failures ${expectedFailed.length}\n`)
    if (unexpectedFailed.length > 0) {
      process.stdout.write(`plugin eval: failed ${unexpectedFailed.length}/${result.cases.length} case(s): ${unexpectedFailed.map((item) => item.name).join(', ')}\n`)
      return 1
    }
    if (nowPassing.length > 0) return 1
    return 0
  } catch (error) {
    process.stderr.write(`plugin eval: invalid result: ${error.message}\n`)
    return 2
  }
}

process.exitCode = main()
