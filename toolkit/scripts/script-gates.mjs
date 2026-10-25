#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { spawnNeedsShell } from '../../plugin/bin/lib/suite-lock.mjs'

const [kind, ...rest] = process.argv.slice(2)
const variant = kind === 'test' && rest[0] === '--blocking' ? rest.shift() : undefined
const stages = kind === 'quality'
  ? [[process.execPath, 'scripts/skill-size-check.mjs'], ...['quality:lint', 'quality:changed', 'quality:host', 'quality:dup', 'quality:dead', 'quality:deps'].map((name) => ['pnpm', 'run', name])]
  : kind === 'test'
    ? [['pnpm', 'build:dist'], [process.execPath, 'scripts/cross-repo-typecheck.mjs'], [...(variant === '--blocking' ? [process.execPath, 'scripts/release-blocking-tests.mjs'] : ['vitest', 'run', '--coverage']), ...rest]]
    : null
if (!stages || (kind === 'quality' && rest.length)) throw new Error('usage: script-gates.mjs quality|test [--blocking] [args...]')
function failureReason(result) {
  if (result.error) return `spawn error: ${result.error.message}`
  if (result.signal) return `signal ${result.signal}`
  return result.status == null ? 'no exit status' : `exit code ${result.status}`
}
for (const [command, ...args] of stages) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: spawnNeedsShell(command) })
  if (result.error || result.status !== 0) {
    process.stderr.write(`${kind} failed: ${[command, ...args].join(' ')} (${failureReason(result)})\n`)
    process.exitCode = result.error ? 2 : result.status ?? 1
    break
  }
}
