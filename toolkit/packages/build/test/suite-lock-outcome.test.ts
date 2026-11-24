import { it } from 'vitest'
// @ts-expect-error executable JavaScript cases shared with the standalone runner
import { outcomeCases } from './suite-lock-outcome-cases.mjs'

for (const [name, run] of Object.entries(outcomeCases) as [string, () => Promise<void>][]) {
  it(name, run)
}
