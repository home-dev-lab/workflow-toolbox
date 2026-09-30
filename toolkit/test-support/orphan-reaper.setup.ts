import { writeFileSync } from 'node:fs'
// @ts-expect-error Plain ESM test-support script has no TypeScript declarations.
import { linuxStartTime } from './orphan-reaper.mjs'
import { inject } from 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    wtTestRunTag?: string
    wtTestWorkerRegistry?: string
  }
}

const tag = inject('wtTestRunTag')
const registry = inject('wtTestWorkerRegistry')
if (registry !== undefined) {
  try { writeFileSync(`${registry}/${process.pid}`, process.platform === 'linux' ? linuxStartTime(process.pid) ?? '' : '') }
  catch { /* A failed registration must not fail the test file. */ }
}
if (tag !== undefined) {
  process.env.WT_TEST_RUN_TAG = tag
}
