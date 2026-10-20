const inertDeadline = (options) => ({ options, close() {}, failure: (error) => error })

function expiryTimer(seconds, expire) {
  const deadline = performance.now() + seconds * 1000
  let timer
  const check = () => {
    const remaining = deadline - performance.now()
    if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
    else expire()
  }
  timer = setTimeout(check, Math.min(seconds * 1000, 2_147_483_647))
  return () => clearTimeout(timer)
}

/** Static tickets keep their no-progress budget at the head, without changing stale-holder policy. */
export function staticWaitDeadline(options) {
  if (!options.staticDomain) return inertDeadline(options)
  const seconds = Number(options.waitS ?? (options.env ?? process.env).WT_SUITE_LOCK_WAIT_S ?? 2700)
  if (!Number.isFinite(seconds) || seconds <= 0) return inertDeadline(options)
  const controller = new AbortController()
  let cancelTimer = () => {}
  let expired = false
  let lastWait = 'waiting for static lane'
  const abort = () => controller.abort()
  const renew = () => {
    cancelTimer()
    cancelTimer = expiryTimer(seconds, () => { expired = true; controller.abort() })
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  renew()
  return {
    options: { ...options, signal: controller.signal,
      onProgress(place) { renew(); options.onProgress?.call(this, place) },
      onRenew(place) { renew(); options.onRenew?.call(this, place) },
      onWait(line) { lastWait = line.replace('suite lock', 'static lane'); options.onWait?.call(this, line) } },
    close() { cancelTimer(); options.signal?.removeEventListener('abort', abort) },
    failure(error) {
      if (!expired || error?.code !== 'ABORT_ERR') return error
      return Object.assign(new Error(`timed out ${lastWait}; no static queue progress for ${seconds} s; inspect with wt-suite-lock status`), { code: 'WT_SUITE_LOCK_TIMEOUT' })
    },
  }
}
