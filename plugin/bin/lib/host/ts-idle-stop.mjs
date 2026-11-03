// POSIX backends are session leaders. Signal their owned group, including children
// that keep inherited stdio open after the leader exits. Windows has no POSIX group.
export function signalTsBackend(state, backend, signal) {
  try {
    if ((state.options.platform ?? process.platform) === 'win32') backend.child?.kill(signal)
    else if (backend.child?.pid) (state.options.killGroup ?? process.kill)(-backend.child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') state.streams.stderr.write(`wt-tsls: backend group signal failed (${error.message}); descendant cleanup unknown\n`)
  }
}

export function superviseTsStop(state, closed) {
  const backend = state.backend
  clearTimeout(state.idleTimer)
  state.stopTimer = setTimeout(() => {
    if (state.backend !== backend || state.phase === 'closed') return
    backend.forced = true
    backend.input.end()
    signalTsBackend(state, backend, 'SIGTERM')
    state.killTimer = setTimeout(() => {
      if (state.backend !== backend || state.phase === 'closed') return
      signalTsBackend(state, backend, 'SIGKILL')
      backend.killed = true
      backend.input.destroy(); backend.output.destroy()
      backend.child?.stdin.destroy(); backend.child?.stdout.destroy(); backend.child?.stderr.destroy()
      closed(state, backend, 0)
    }, 1000)
    state.killTimer.unref()
  }, state.stopMs)
  state.stopTimer.unref()
}
