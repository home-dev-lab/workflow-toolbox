// Long-lived child processes a test starts and must not leave behind.
//
// A test that starts a keepalive through a wrapper (a lock runner, a launcher, a shell) and then
// kills the wrapper with SIGKILL leaves the wrapper's own child running: SIGKILL gives the wrapper
// no chance to forward anything, and the child is re-parented to init. Measured on this suite: one
// such keepalive per run of the suite-lock timeout case, accumulating for days.
//
// spawnHeld starts the child as the leader of a new process group (POSIX), so stopHeld can signal
// the whole group — the wrapper and everything it started that stayed in its group. Every held
// child is also stopped after each test (held-processes.setup.ts) and when the spawning process
// exits normally. A worker killed by a signal runs no exit handler; the run-level reaper
// (orphan-reaper.mjs) covers that case.
//
// Windows has no process groups to signal: there spawnHeld is a plain spawn and stopHeld kills the
// direct child only. A grandchild a wrapper started survives there, as it did before this fixture.
// A descendant that leaves the group on its own (setsid, a detached spawn) is not reached either.
// A group id is a pid: if a leader's group empties and the same number becomes another group's
// leader before the reap, that group is signalled. Held children are reaped within one test, far
// shorter than a pid wrap on a host whose pid_max is in the millions; on a host with a small
// pid_max the window is real and is not closed here.
import { spawn } from 'node:child_process'

const GROUPS = process.platform !== 'win32'
const held = new Set()
let exitHookInstalled = false

export function spawnHeld(command, args = [], options = {}) {
  const child = spawn(command, args, GROUPS ? { ...options, detached: true } : options)
  held.add(child)
  child.once('exit', () => { if (!GROUPS) held.delete(child) })
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => { reapHeld() })
  }
  return child
}

// Signals the child's whole group. The group outlives its leader while any member is alive, so a
// leader that already exited still lets its stray children be reached. ESRCH means nothing is left.
export function stopHeld(child, signal = 'SIGKILL') {
  held.delete(child)
  if (child.pid === undefined) return
  if (!GROUPS) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    return
  }
  try { process.kill(-child.pid, signal) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

export function reapHeld() {
  for (const child of [...held]) {
    try { stopHeld(child) } catch { /* Reaping is best effort: one failure must not keep the others alive. */ }
  }
}
