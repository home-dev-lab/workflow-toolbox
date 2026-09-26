import { existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [file, root, runId, kind, gate, label = '', modulePath] = process.argv.slice(2)
const { bindPilotDecision, decidePilotRun } = await import(modulePath || new URL('../../../../../plugin/bin/lib/host/pilot-decision-store.mjs', import.meta.url).href)
if (kind === 'ready') {
  decidePilotRun({ runId, criterion: 1, reading: 'doomed', root, bindingOptions: {
    afterTempWrite: () => { writeFileSync(gate, 'ready'); while (true) {} },
  } })
} else {
  writeFileSync(`${gate}.${label}.ready`, '')
  const wait = () => {
    if (!existsSync(gate)) return setTimeout(wait, 1)
    try {
      if (kind === 'fallback') {
        const result = bindPilotDecision(file, { requestId: runId, criterion: 1, source: 'fallback', at: Date.now() })
        process.stdout.write(JSON.stringify({ source: result.source, winner: result.reading ?? null, loser: result.source !== 'fallback' }))
      } else if (!modulePath) {
        const cli = new URL('../../../../../plugin/bin/wt-pilot-runner.mjs', import.meta.url)
        const result = spawnSync(process.execPath, [cli.pathname, 'decide', '--run', runId, '--dod', '1', '--reading', label, '--state-root', root], { encoding: 'utf8' })
        if (result.status === 0) process.stdout.write(JSON.stringify({ source: 'parent', winner: label }))
        else process.stdout.write(JSON.stringify({ source: /already bound \(([^)]+)\)/.exec(result.stderr)?.[1], loser: true }))
      } else {
        const result = decidePilotRun({ runId, criterion: 1, reading: label, root })
        process.stdout.write(JSON.stringify({ source: 'parent', winner: result.decision.reading }))
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ source: /already bound \(([^)]+)\)/.exec(error.message)?.[1], loser: true }))
    }
  }
  wait()
}
