const SIGNAL_EXITS = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }

export function watchSuiteWaitSignals() {
  const controller = new AbortController()
  const handlers = Object.keys(SIGNAL_EXITS).flatMap((signal) => {
    const handler = () => controller.abort(Object.assign(new Error(`suite lock interrupted by ${signal}`), { code: 'ABORT_ERR', signal }))
    try { process.on(signal, handler); return [[signal, handler]] } catch { return [] }
  })
  return { signal: controller.signal, close() {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  } }
}

export const suiteSignalExit = (reason) => SIGNAL_EXITS[reason?.signal]

export function linkSuiteSignal(source, controller) {
  const abort = () => controller.abort(source.reason)
  source?.addEventListener('abort', abort, { once: true })
  if (source?.aborted) abort()
  return () => source?.removeEventListener('abort', abort)
}
