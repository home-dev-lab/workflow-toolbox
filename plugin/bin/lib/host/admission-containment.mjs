import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A group/session alone cannot contain setsid(). Install a subreaper before exec:
// even double-forked daemons become our children when their ancestors exit.
// Never reap between enumerating and signaling: every numeric PID remains pinned
// by our parent/child relationship (including zombies), without requiring pidfds.
const LINUX_ADMISSION_CONTAINER = String.raw`
import ctypes, os, select, signal, sys, time

shutdown_requested = False

def request_shutdown(signum, frame):
    global shutdown_requested
    shutdown_requested = True

for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
    signal.signal(signum, request_shutdown)

def children():
    with open('/proc/self/task/%s/children' % os.getpid(), 'rb') as stream:
        return [int(pid) for pid in stream.read().split()]

def reap():
    while True:
        try:
            if os.waitpid(-1, os.WNOHANG)[0] == 0:
                return True
        except ChildProcessError:
            return False

def cleanup():
    deadline = time.monotonic() + 1
    while True:
        for pid in children():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if not reap():
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('children still executing after cleanup deadline')
        time.sleep(0.002)

def supervise():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'cannot install admission subreaper')
    children()  # Fail before policy execution if our own children record is unavailable.
    ipc = int(os.environ['NODE_CHANNEL_FD'])
    pid = os.fork()
    if pid == 0:
        os.close(4)  # Only the containment owner may hold the shutdown pipe.
        os.set_inheritable(ipc, True)
        os.execve(sys.argv[2], [sys.argv[2], '--unhandled-rejections=strict', sys.argv[1]], os.environ)
    try:
        os.close(ipc)
        while not shutdown_requested and os.waitpid(pid, os.WNOHANG)[0] == 0:
            if select.select([4], [], [], 0.005)[0]:
                break
    finally:
        cleanup()

try:
    supervise()
except BaseException as error:
    print('admission containment unknown: %s' % error, file=sys.stderr)
    sys.exit(70)
`

export function admissionContainmentHost() {
  return { platform: process.platform, fork }
}

export function admissionContainmentRefusal(host) {
  if (host.platform === 'linux') return null
  return `containment unknown (${host.platform}): admission policy was not started; a native descendant container is unavailable`
}

export function startAdmissionContainer(env, host) {
  return host.fork(fileURLToPath(new URL('./admission-process.mjs', import.meta.url)), [process.execPath], {
    env, execPath: '/usr/bin/python3', execArgv: ['-I', '-c', LINUX_ADMISSION_CONTAINER], serialization: 'advanced',
    // Caller-group interrupts must not destroy the owner before it can reap.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
  })
}

export async function finishAdmissionContainer(child, exited) {
  // EOF requests cleanup without killing the subreaper. It must outlive ALL of
  // its children; its exit, rather than inherited pipe closure, is our barrier.
  const shutdown = child.stdio[4]
  // Closing the handle delivers EOF even when socket shutdown is denied. A late
  // pipe error may mean the owner is already finalizing, not that it needs TERM.
  shutdown.on('error', () => {})
  try { shutdown.end() } catch { /* The direct close still requests cleanup. */ }
  shutdown.destroy()
  child.stdout.destroy(); child.stderr.destroy()
  try {
    if (await admissionOwnerExited(exited, 1500)) return null
    // Signals are independent of socket shutdown. TERM requests Python cleanup;
    // KILL is only a final escape from a stuck owner and never proves containment.
    signalAdmissionOwner(child, 'SIGTERM')
    if (await admissionOwnerExited(exited, 1500)) return null
    signalAdmissionOwner(child, 'SIGKILL')
    const ended = await admissionOwnerExited(exited, 250)
    if (!ended) child.unref()
    return `containment unknown: owner shutdown exceeded its cleanup deadline; ${ended ? 'owner stopped by kill fallback' : 'owner exit could not be verified after kill fallback'}`
  } finally {
    shutdown.destroy()
    if (child.connected) child.disconnect()
  }
}

function signalAdmissionOwner(child, signal) {
  try { child.kill(signal) } catch { /* The bounded wait reports unverifiable shutdown. */ }
}

async function admissionOwnerExited(exited, milliseconds) {
  let timer
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}
