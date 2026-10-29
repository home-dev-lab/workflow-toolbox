import { displayArgv } from './suite-lock-display.mjs'
import { suiteLockLightHoldSeconds } from './suite-lock-priority.mjs'

// Node clamps larger delays to 1 ms. Re-arm at the ceiling instead of warning early.
const MAX_TIMER_MS = 2_147_483_647

// The owning run process watches its granted lease on either transport. No polling or pre-emption.
// Clock, scheduling and output seams keep boundary and cleanup tests independent of wall-clock waits.
export function watchLightSuiteLease(holder, options = {}) {
  if (holder.light !== true) return () => {}
  const now = options.now ?? Date.now
  const schedule = options.setTimer ?? setTimeout
  const clear = options.clearTimer ?? clearTimeout
  const write = options.write ?? ((line) => process.stderr.write(line))
  const boundS = suiteLockLightHoldSeconds(options.env ?? process.env)
  const recorded = Date.parse(holder.startedAt)
  const started = Number.isFinite(recorded) ? recorded : now()
  const emit = (line) => { try { write(line) } catch { /* a closed stderr must not end the run that holds the lease */ } }
  let active = true
  let timer
  function arm() {
    const remaining = boundS * 1000 - Math.max(0, now() - started) + 1
    timer = schedule(check, Math.min(MAX_TIMER_MS, Math.max(1, remaining)))
    timer.unref()
  }
  function check() {
    if (!active) return
    const ageMs = Math.max(0, now() - started)
    if (ageMs > boundS * 1000) {
      active = false
      emit(`wt-suite-lock: light lease past its class: held ${(ageMs / 1000).toFixed(1)} s above the ${boundS} s bound (${displayArgv(holder.argv)}); the lock is still held, nobody is pre-empted\n`)
      return
    }
    arm()
  }
  arm()
  return () => { active = false; clear(timer) }
}
