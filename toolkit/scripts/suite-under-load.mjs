#!/usr/bin/env node
// Run the full suite alongside deliberate CPU contention and retain each run's evidence.
import { availableParallelism } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

function numberOption(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

const runs = numberOption('--runs', 3)
const workers = numberOption('--workers', Math.max(1, availableParallelism() - 1))
const outputDir = process.env.WT_SUITE_LOAD_OUTPUT_DIR || join(process.cwd(), '..', '.lane', 'suite-under-load')
mkdirSync(outputDir, { recursive: true })

const load = Array.from({ length: workers }, () =>
  spawn(process.execPath, ['-e', 'while (true) { Math.sqrt(Math.random()) }'], { stdio: 'ignore' }),
)

function failures(log) {
  return [...log.matchAll(/^ FAIL\s+(.+)$/gm)].map((match) => match[1])
}

const results = []
try {
  for (let run = 1; run <= runs; run += 1) {
    const started = Date.now()
    const result = spawnSync('pnpm', ['test'], { cwd: process.cwd(), encoding: 'utf8' })
    const durationMs = Date.now() - started
    const logPath = join(outputDir, `run-${run}.log`)
    writeFileSync(logPath, `${result.stdout ?? ''}${result.stderr ?? ''}`)
    const failed = failures(readFileSync(logPath, 'utf8'))
    results.push({ run, exit: result.status ?? 1, durationMs, failed, logPath })
    console.log(`run ${run}: exit=${result.status ?? 1} duration=${(durationMs / 1000).toFixed(1)}s failures=${failed.length ? failed.join(' | ') : 'none'}`)
  }
} finally {
  for (const child of load) child.kill('SIGKILL')
}

const failedRuns = results.filter((result) => result.exit !== 0).length
console.log(`base rate: ${failedRuns}/${runs} failed under ${workers} CPU workers`)
process.exitCode = failedRuns === 0 ? 0 : 1
