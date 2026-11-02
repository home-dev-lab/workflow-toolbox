import { constants, getPriority, setPriority } from 'node:os'

// Lower the wrapper BEFORE spawn. POSIX nice and Windows IDLE priority are
// inherited by ordinary child creation, covering the native backend as well.
export function lowerTsPriority({ set = setPriority, get = getPriority, stderr = process.stderr } = {}) {
  try {
    const priority = constants.priority.PRIORITY_LOW
    set(0, priority)
    if (get(0) !== priority) throw new Error('OS did not retain the lowest priority')
    return { status: 'lowered', priority }
  } catch (error) {
    try { stderr.write(`wt-tsls: priority unavailable (${error.message}); scheduling priority is unknown\n`) }
    catch { /* Diagnostics cannot prevent protocol startup. */ }
    return { status: 'unavailable' }
  }
}
