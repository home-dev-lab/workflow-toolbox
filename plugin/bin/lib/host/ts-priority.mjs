import { constants, getPriority, setPriority } from 'node:os'
import { readdirSync } from 'node:fs'
export { tsCpuScope } from './ts-cpu-scope.mjs'

function linuxThreads() {
  return readdirSync('/proc/self/task').map(Number).filter(id => Number.isSafeInteger(id) && id !== process.pid)
}

function lowerExistingThreads(set, get, platform, threads, priority) {
  if (platform !== 'linux') return
  for (const id of threads()) {
    set(id, priority)
    if (get(id) !== priority) throw new Error('OS did not retain thread priority')
  }
}

// Lower the wrapper BEFORE spawn. POSIX nice and Windows IDLE priority are
// inherited by ordinary child creation, covering the native backend as well.
export function lowerTsPriority({ set = setPriority, get = getPriority, stderr = process.stderr, platform = process.platform, threads = linuxThreads } = {}) {
  try {
    const priority = constants.priority.PRIORITY_LOW
    set(0, priority)
    if (get(0) !== priority) throw new Error('OS did not retain the lowest priority')
    lowerExistingThreads(set, get, platform, threads, priority)
    stderr.write('wt-tsls: lowest scheduling priority set; Linux nice competes within cgroup/session and is per thread; WSL2 nice does not reach Windows host priority; no CPU cap\n')
    return { status: 'lowered', priority }
  } catch (error) {
    try { stderr.write(`wt-tsls: priority unavailable (${error.message}); scheduling priority is unknown\n`) }
    catch { /* Diagnostics cannot prevent protocol startup. */ }
    return { status: 'unavailable' }
  }
}
