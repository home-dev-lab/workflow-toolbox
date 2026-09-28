import * as fs from 'node:fs'
import { existsSync, writeFileSync } from 'node:fs'
const [file, root, runId, kind, gate, label = '', modulePath] = process.argv.slice(2)
const { bindPilotDecision, decidePilotRun } = await import(new URL('../../../../../plugin/bin/lib/host/pilot-decision-store.mjs', import.meta.url).href)
if (kind === 'ready') {
  decidePilotRun({ runId, requestId: 'r', criterion: 1, reading: 'doomed', root, bindingOptions: {
    afterTempWrite: () => { writeFileSync(gate, 'ready'); while (true) {} },
  } })
} else {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const release = () => { while (!existsSync(gate)) Atomics.wait(pause, 0, 0, 2) }
  const afterTempWrite = () => {
    if (modulePath === 'check-then-write') return
    writeFileSync(`${gate}.${label}.ready`, '')
    release()
  }
  const options = { afterTempWrite, ...(modulePath === 'check-then-write' ? { fs: { ...fs, linkSync: (temporary, final) => {
    if (existsSync(final)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    writeFileSync(`${gate}.${label}.ready`, '')
    release()
    writeFileSync(final, fs.readFileSync(temporary))
  } } } : {}) }
  try {
    if (kind === 'fallback') {
      const result = bindPilotDecision(file, { requestId: runId, criterion: 1, source: 'fallback', at: Date.now() }, options)
      process.stdout.write(JSON.stringify({ source: result.source, winner: result.reading ?? null, loser: result.source !== 'fallback' }))
    } else {
      const result = decidePilotRun({ runId, requestId: runId, criterion: 1, reading: label, root, bindingOptions: options })
      process.stdout.write(JSON.stringify({ source: 'parent', winner: result.decision.reading }))
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ source: /already bound \(([^)]+)\)/.exec(error.message)?.[1], loser: true }))
  }
}
