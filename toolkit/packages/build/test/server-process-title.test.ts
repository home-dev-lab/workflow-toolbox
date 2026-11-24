import { spawn, type SpawnOptions } from 'node:child_process'
import { it } from 'vitest'
// @ts-expect-error standalone Node regression test is shared with Vitest
import { checkServerProcessTitle, LINUX_SKIP_REASON } from './server-process-title.selftest.mjs'

// Other platforms have no Linux procfs comm contract; title assignment remains best-effort.
for (const kind of ['server', 'holder']) {
  it.skipIf(process.platform !== 'linux')(`${kind} sets kernel comm without renaming children (Linux only: ${LINUX_SKIP_REASON})`, async () => {
    await checkServerProcessTitle(kind, (file: string, args: string[], options: SpawnOptions) => spawn(file, args, options))
  })
}
