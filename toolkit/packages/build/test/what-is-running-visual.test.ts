import { describe, it } from 'vitest'

// @ts-expect-error The standalone Node locks also run directly before production edits.
import { locks } from './fixtures/what-is-running/visual-locks.selftest.mjs'

describe('What is running visual contract', () => {
  it.each(locks as Array<[string, () => void | Promise<void>]>)('%s', async (_name, run) => {
    await run()
  })
})
