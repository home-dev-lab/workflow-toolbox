import { it } from 'vitest'
// @ts-expect-error executable JavaScript fixtures
import { releasePublicationRetryCase, releasePutBackCase } from './suite-lock-release-accounting-cases.mjs'

it('publishes service before put-back and journals release only after ticket cleanup succeeds', releasePutBackCase)
it('records a project turn when release retries after publication and ticket cleanup fail', releasePublicationRetryCase)
