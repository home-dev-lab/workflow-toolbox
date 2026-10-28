import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A group/session alone cannot contain setsid(). Install a subreaper before exec:
// even double-forked daemons become our children when their ancestors exit.
// Never reap between enumerating and signaling: every numeric PID remains pinned
// by our parent/child relationship (including zombies), without requiring pidfds.
const LINUX_ADMISSION_CONTAINER = String.raw`
import ctypes, os, select, signal, sys, time

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
    os.close(ipc)
    while os.waitpid(pid, os.WNOHANG)[0] == 0:
        if select.select([4], [], [], 0.005)[0]:
            break
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
    stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'],
  })
}

export async function finishAdmissionContainer(child, exited) {
  // EOF requests cleanup without killing the subreaper. It must outlive ALL of
  // its children; its exit, rather than inherited pipe closure, is our barrier.
  child.stdio[4].on('error', () => {})
  child.stdio[4].end()
  child.stdout.destroy(); child.stderr.destroy()
  await exited
  if (child.connected) child.disconnect()
}
