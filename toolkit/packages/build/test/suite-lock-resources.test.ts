import { it } from 'vitest'

const casesUrl = new URL('../../../test-support/suite-lock-resources.selftest.mjs', import.meta.url).href
const { resourceCases } = await import(casesUrl)

for (const [name, test] of resourceCases) it(name, test)
