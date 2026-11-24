import { it } from 'vitest'
// @ts-expect-error executable JavaScript fixtures
import { releasePutBackCase } from './suite-lock-release-accounting-cases.mjs'

it('records service once across failed ticket cleanup, put-back and release retries', releasePutBackCase)
