import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quarantinedTests, validateQuarantinedTests } from './quarantined-tests.mjs'

const VITEST = resolve(import.meta.dirname, '../node_modules/vitest/vitest.mjs')

export function releaseBlockingExitCode(blockingStatus, quarantineStatus) {
  void quarantineStatus
  return blockingStatus ?? 1
}

export function quarantineNotice(entries = quarantinedTests) {
  return [
    `QUARANTINE: ${entries.length} tests run separately and do not block release:`,
    ...entries.map((entry) => `- ${entry.file} > ${entry.name} [card ${entry.cardId}]: ${entry.waitingOn}`),
  ].join('\n')
}

export function runReleaseBlockingTests(run = spawnSync, write = (text) => process.stdout.write(text)) {
  validateQuarantinedTests()
  write(`${quarantineNotice()}\n`)
  const blocking = run(process.execPath, [VITEST, 'run', '--coverage'], {
    stdio: 'inherit',
    env: { ...process.env, WT_TEST_MODE: 'blocking' },
  })
  write('\nQUARANTINE RUN: failures below are reported but do not block release.\n')
  const quarantine = run(process.execPath, [VITEST, 'run'], {
    stdio: 'inherit',
    env: { ...process.env, WT_TEST_MODE: 'quarantine' },
  })
  write(`QUARANTINE RESULT: exit ${quarantine.status ?? 1} (non-blocking)\n`)
  return releaseBlockingExitCode(blocking.status, quarantine.status)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runReleaseBlockingTests()
}
