// Launcher-mechanics fixtures use an injected counter, preserving their provider's
// original process topology and timing. The admission contract has its own tests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, parse } from '../../../../../../plugin/bin/wt-lane.mjs'
import { readCurrentSupervision } from '../../../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const root = mkdtempSync(join(tmpdir(), 'launcher-counter-'))
const argv = process.argv.slice(2)
const options = parse(argv)
const counter = () => {
  const state = options.dir ? readCurrentSupervision(options.dir) : null
  const pids = [state?.workerPid, state?.childPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  return { state: 'ok', count: 0, pids }
}
try {
  process.exitCode = await main({ argv, admissionOptions: { lockPath: join(root, 'admission.lock'), counter } })
} catch (error) {
  process.stderr.write(`wt-lane: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally { rmSync(root, { recursive: true, force: true }) }
