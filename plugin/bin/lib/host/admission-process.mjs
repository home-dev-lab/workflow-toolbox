// Keep the supervisor responsive when policy code loops synchronously in its worker.
// Losing the caller's IPC channel must also stop the worker, including on caller SIGKILL.
import { Worker } from 'node:worker_threads'
import { isInvokedDirectly } from './entry-guard.mjs'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

export function formatAdmissionError(error) {
  try { return String(error instanceof Error ? error.message : error) } catch { return 'unprintable thrown value' }
}

export function admissionCleanupLimitation(platform = process.platform) {
  if (platform === 'linux') return 'cleanup limitation (linux): subreaper contains detached descendants without pidfds; uninterruptible processes or containment-owner death can escape and produce a containment unknown refusal'
  if (platform === 'darwin') return 'cleanup limitation (darwin): detached descendants can survive without a native container; configured policies refuse before execution'
  if (platform === 'win32') return 'cleanup limitation (win32): detached descendants can survive without a Job Object; configured policies refuse before execution'
  return `cleanup limitation (${platform}): descendant cleanup is unsupported; only the admission supervisor is stopped`
}

export function reportAdmissionCleanup(variable, detail = admissionCleanupLimitation()) {
  try { process.stderr.write(`${variable}: ${detail}\n`) } catch { /* diagnostics never replace the verdict */ }
}

function processRecord(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (!stat.startsWith(`${pid} (`) || !/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1])) {
      throw new Error('invalid process identity')
    }
    return { pid, ppid: Number(fields[1]), start: fields[19], state: fields[0] }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
}

export function admissionCleanupIdentity(child) {
  if (process.platform !== 'linux') return null
  try { return processRecord(child.pid) } catch { return null }
}

// Python's standard library exposes pidfds; Node has no identity-bound signal API.
// Open a handle BEFORE checking birth identity. Never fall back to numeric signals.
const LINUX_CLEANUP = String.raw`
import os, select, signal, sys, time

def record(pid):
    try:
        with open('/proc/%s/stat' % pid, 'rb') as stream:
            stat = stream.read()
        fields = stat[stat.rfind(b')') + 2:].split()
        if not stat.startswith(('%s (' % pid).encode()) or not fields[19].isdigit():
            raise RuntimeError('invalid process birth identity')
        return (pid, int(fields[1]), fields[19].decode('ascii'), fields[0])
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None

def own(pid, start):
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return None
    current = record(pid)
    if not current or current[2] != start:
        os.close(fd)
        return None
    return (pid, start, fd)

def ended(entry):
    poller = select.poll()
    poller.register(entry[2], select.POLLIN)
    return bool(poller.poll(0))

def send(entry, signum):
    try:
        signal.pidfd_send_signal(entry[2], signum)
    except ProcessLookupError:
        pass

def discover(family):
    added = False
    for name in os.listdir('/proc'):
        if not name.isdigit() or int(name) in family:
            continue
        current = record(int(name))
        if not current:
            continue
        parent = family.get(current[1])
        if not parent or ended(parent):
            continue
        entry = own(current[0], current[2])
        if entry:
            family[entry[0]] = entry
            send(entry, signal.SIGSTOP)
            added = True
    return added

def stopped(entry):
    if ended(entry):
        return True
    current = record(entry[0])
    return bool(current and current[3] in (b'T', b't', b'Z', b'X', b'x'))

def freeze(family):
    deadline = time.monotonic() + 0.15
    while time.monotonic() < deadline:
        added = discover(family)
        if not added and all(stopped(entry) for entry in family.values()):
            return
        time.sleep(0.002)
    raise RuntimeError('descendant census did not stabilize within 150 ms')

def cleanup(root):
    family = {root[0]: root}
    errors = []
    try:
        send(root, signal.SIGSTOP)
        freeze(family)
    except Exception as error:
        errors.append(str(error))
    descendants = list(family.values())[1:]
    for entry in reversed(descendants):
        try:
            send(entry, signal.SIGKILL)
        except Exception as error:
            errors.append(str(error))
    deadline = time.monotonic() + 0.15
    while any(not ended(entry) for entry in descendants):
        if time.monotonic() >= deadline:
            errors.append('descendants still executing after SIGKILL (150 ms cleanup bound)')
            break
        time.sleep(0.002)
    if errors:
        raise RuntimeError('; '.join(errors))

try:
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('python3 pidfd support is unavailable')
    pid = int(sys.argv[1])
    if pid <= 1 or pid == os.getpid() or pid == os.getppid():
        raise RuntimeError('unsafe cleanup target')
    root = own(pid, sys.argv[2])
    if root is None:
        raise RuntimeError('admission supervisor birth identity changed or ended')
    cleanup(root)
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
`

export function cleanupAdmissionDescendants(child, identity) {
  if (process.platform !== 'linux') return Promise.resolve(null)
  if (!identity || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve('cleanup incomplete: admission supervisor ended or its birth identity is unavailable')
  }
  return new Promise((resolve) => {
    const helper = spawn('/usr/bin/python3', ['-I', '-c', LINUX_CLEANUP, String(identity.pid), identity.start], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let error = ''
    const timer = setTimeout(() => { error = 'pidfd helper exceeded 1000 ms'; helper.kill('SIGKILL') }, 1000)
    helper.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(0, 4096) })
    helper.once('error', failure => { clearTimeout(timer); resolve(`cleanup incomplete: python3 pidfd helper: ${formatAdmissionError(failure)}`) })
    helper.once('close', code => {
      clearTimeout(timer)
      if (code === 0) return resolve(null)
      const detail = error.trim() || `pidfd helper exited with code ${code}`
      resolve(`cleanup incomplete: ${detail}`)
    })
  })
}

export async function workerAdmission({ repo, request }, env, timeout, moduleVariable, silent, admission) {
  const deadline = performance.now() + timeout
  const worker = new Worker(new URL('./admission-worker.mjs', import.meta.url), {
    workerData: { repo, request, env, moduleVariable, admission }, env, execArgv: ['--unhandled-rejections=strict'],
    ...(silent ? { stdout: true, stderr: true } : {}),
  })
  if (silent) { worker.stdout.resume(); worker.stderr.resume() }
  let timer
  const expired = `${moduleVariable}: timed out after ${timeout} ms`
  try {
    const refusal = await Promise.race([
      workerVerdict(worker, moduleVariable),
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), Math.max(0, deadline - performance.now())) }),
    ])
    return performance.now() >= deadline ? expired : refusal
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}

function workerVerdict(worker, variable) {
  return new Promise((resolve) => {
    let verdict
    let failure
    worker.on('message', (message) => { verdict = message })
    worker.on('error', (error) => { failure = `${variable}: admission worker failed: ${formatAdmissionError(error)}` })
    worker.on('exit', (code) => {
      if (failure) return resolve(failure)
      if (code !== 0) return resolve(`${variable}: admission worker exited with code ${code}`)
      if (verdict === null || typeof verdict === 'string') return resolve(verdict)
      resolve(`${variable}: admission worker exited without a verdict`)
    })
  })
}

async function run({ options, env, timeout, moduleVariable, silent, admission }) {
  let message
  try { message = { refusal: await workerAdmission(options, env, timeout, moduleVariable, silent, admission) } }
  catch (error) { message = { error: formatAdmissionError(error) } }
  // The outer containment owner stops and reaps this supervisor and all orphans.
  if (process.connected) process.send(message)
}

if (isInvokedDirectly(import.meta.url)) {
  process.once('disconnect', () => process.exit(0))
  process.once('message', run)
}
