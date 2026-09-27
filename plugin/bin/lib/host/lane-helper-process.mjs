import { readFileSync, rmSync } from 'node:fs'

// A host-side helper of a sandboxed lane (the egress proxy, the suite-lock broker) serves ONE unix
// socket for the lane and must not outlive the process that started it: every helper shares the
// argument shape, the fatal path that removes its socket, and the parent watchdog below.

// /proc/<pid>/stat field 22: a pid whose start time changed is a DIFFERENT process (pid reuse).
export function processStartTicks(pid, readFile = (file) => readFileSync(file, 'utf8')) {
  try {
    const stat = readFile(`/proc/${pid}/stat`)
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    return Number.isFinite(start) ? start : null
  } catch { return null }
}

export function parentAlive(pid, startTicks, { kill = process.kill, readStart = processStartTicks } = {}) {
  try { kill(pid, 0) } catch { return false }
  return startTicks === null || readStart(pid) === startTicks
}

// `--socket`, `--parent`, `--parent-start` for every helper; `extra` maps a helper's own flags to a
// setter over the options object.
export function parseHelperArguments(argv, options, extra = {}) {
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--socket') options.socket = value
    else if (flag === '--parent') options.parent = Number(value)
    else if (flag === '--parent-start') options.parentStart = Number.isFinite(Number(value)) ? Number(value) : null
    else extra[flag]?.(value)
  }
  return options
}

/**
 * Listens on `options.socket` and exits within one poll (2 s) of the parent's death, SIGKILL
 * included: the parent pid AND its start time are checked, so a reused pid does not keep it alive.
 * `beforeExit` runs first on that path (a helper releases what it holds). A listen failure is fatal
 * (the launch then refuses: its socket never appears); a later server error is reported once and
 * the helper keeps serving.
 */
export function runLaneHelper({ server, options, name, stoppedSuffix = '', beforeExit = () => {} }) {
  const fatal = (message) => {
    process.stderr.write(`workflow-toolbox: lane ${name} stopped: ${message}${stoppedSuffix}\n`)
    try { rmSync(options.socket, { force: true }) } catch { /* nothing to remove */ }
    process.exit(3)
  }
  if (!options.socket) fatal('--socket is required')
  process.on('uncaughtException', (error) => fatal(error?.message ?? String(error)))
  let listening = false
  let errorReported = false
  server.on('error', (error) => {
    if (!listening) fatal(`cannot listen on its socket (${error.code ?? error.message})`)
    if (!errorReported) process.stderr.write(`workflow-toolbox: lane ${name} accept error (${error.code ?? error.message}); still serving\n`)
    errorReported = true
  })
  server.listen(options.socket, () => { listening = true })
  if (Number.isSafeInteger(options.parent) && options.parent > 1) {
    setInterval(() => {
      if (parentAlive(options.parent, options.parentStart)) return
      try { beforeExit() } catch { /* exiting anyway */ }
      server.close()
      try { rmSync(options.socket, { force: true }) } catch { /* already gone */ }
      process.exit(0)
    }, 2_000)
  }
}
