import { afterEach, it } from 'vitest'
// @ts-expect-error the standalone Node regression cases also run under Vitest
import { registerRetainedRootUnitTests } from './artifact-retained-roots.selftest.mjs'

registerRetainedRootUnitTests({ test: it, afterEach })
