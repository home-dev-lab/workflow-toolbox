import { isInvokedDirectly } from './entry-guard.mjs'
import { readSuiteMachine } from './suite-lock-machine.mjs'
import { readReservationState, watchReservationMemory } from './suite-lock-reservations.mjs'
import { RECLAIM_BUSY } from './suite-lock-section.mjs'

async function main(root, generation) {
  let unknown
  while (true) {
    const state = readReservationState(root)
    if (!watchdogOwns(state, generation)) return
    const machine = readSuiteMachine()
    if (machine.unknown && machine.unknown !== unknown) {
      process.stderr.write(`wt-suite-lock: memory watchdog unknown (${machine.unknown}); reservation admission closed\n`)
      unknown = machine.unknown
    }
    const result = watchReservationMemory(root, machine, { generation, pid: process.pid })
    if (result !== RECLAIM_BUSY && !result) return
    if (watchdogIdle(state)) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

function watchdogOwns(state, generation) {
  return Boolean(state && state.generation === generation && state.watchdog?.pid === process.pid)
}

function watchdogIdle(state) {
  return state.holders.length === 0 && (state.used || Date.now() - state.createdAt >= 10_000)
}

if (isInvokedDirectly(import.meta.url)) {
  await main(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`wt-suite-lock: memory watchdog unavailable (${error.code ?? error.message})\n`)
    process.exitCode = 1
  })
}
