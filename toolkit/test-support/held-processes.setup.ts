import { afterEach } from 'vitest'
// @ts-expect-error Plain ESM test-support script has no TypeScript declarations.
import { reapHeld } from './held-processes.mjs'

// Every process a test started through spawnHeld is stopped, with its whole process group, when the
// test ends — whether the test passed, failed, or forgot its own cleanup.
afterEach(() => { reapHeld() })
