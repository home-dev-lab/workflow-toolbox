// Drives the real exported wt-lane entry (main -> launchAndObserve -> admission) with injected
// admission seams, then prints one `ADMISSION-PROBE <json>` line: exit code, thrown message, every
// stopWorker call and every admission warning. The counter never counts a lane, so a launch that
// spawns a worker reaches the visibility timeout. WT_ADMISSION_PROBE_STOP=record records a stop
// without signalling anything; the default force-stops the recorded process family for real.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../../../../../../plugin/bin/wt-lane.mjs'
import { hostAdapter } from '../../../../../../plugin/bin/lib/host/adapter.mjs'

const root = mkdtempSync(join(tmpdir(), 'admission-probe-'))
const stops = []
const warnings = []
const recordOnly = process.env.WT_ADMISSION_PROBE_STOP === 'record'
const admissionOptions = {
  lockPath: join(root, 'admission.lock'),
  counter: () => ({ state: 'ok', count: 0, pids: [] }),
  visibilityMs: Number(process.env.WT_ADMISSION_PROBE_VISIBILITY_MS ?? 1500),
  warn: (line) => warnings.push(line),
  stopWorker: (pid) => {
    stops.push(pid)
    return recordOnly ? { status: 'ended' } : hostAdapter.forceEndProcessFamily(pid)
  },
}
let code = null
let error = null
try {
  code = await main({ argv: process.argv.slice(2), admissionOptions })
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught)
} finally { rmSync(root, { recursive: true, force: true }) }
process.stdout.write(`ADMISSION-PROBE ${JSON.stringify({ code, error, stops, warnings })}\n`)
