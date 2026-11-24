import { printLauncherEvent, takeLauncherEvent } from './host/launcher-events.mjs'

export async function waitForLauncher(id, options = {}) {
  const now = options.clock ?? (() => performance.now())
  const deadline = now() + (options.timeout ?? 3300) * 1000
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deliver = (event) => (options.write ?? printLauncherEvent)(event.line)
  while (true) {
    const event = takeLauncherEvent(id, { ...options, deliver })
    if (event) return 0
    if (now() >= deadline) return 125
    await sleep(Math.min((options.poll ?? 30) * 1000, deadline - now()))
  }
}

export function startLauncherWait(id, options) {
  waitForLauncher(id, options).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`wt-lane-wait: launcher delivery unknown: ${error.message}\n`)
    process.exitCode = 1
  })
}
