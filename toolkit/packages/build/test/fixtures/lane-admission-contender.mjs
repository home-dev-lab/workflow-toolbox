import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withLaneLaunchAdmission } from '../../../../../plugin/bin/lib/host/lane-launch-admission.mjs'

const root = process.argv[2]
const counter = () => JSON.parse(readFileSync(join(root, 'count.json'), 'utf8'))
const visible = new Promise((resolve) => process.once('message', resolve))
const pending = withLaneLaunchAdmission(async (lease) => {
  process.send('entered')
  await visible
  writeFileSync(join(root, 'count.json'), JSON.stringify({ state: 'ok', count: 16, pids: [42] }))
  await lease.waitUntilVisible(() => 42)
  return 0
}, { lockPath: join(root, 'launch-admission.lock'), counter, pollMs: 1 })
// Let an erroneously resolved acquisition enter before announcing the contention barrier.
// The parent publishes visibility only after this message, making lock-deletion failures deterministic.
const started = new Promise((resolve) => setImmediate(() => { process.send('started'); resolve() }))
process.exitCode = await pending
await started
process.disconnect()
