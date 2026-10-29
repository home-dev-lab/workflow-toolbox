import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createProcfs, procfsProcessPresence } from './procfs.mjs'
import { createHostAdapter } from './adapter.mjs'
import { canonicalReference, checkedReference, observe } from './sweep-evidence.mjs'

const gone = error => ['ENOENT', 'ESRCH'].includes(error)
const empty = () => ({ status: 'known', references: [], foreignUnreadable: 0, nonDumpable: 0, mismatchExcluded: 0 })

// A namespace name, PID 1 and visible members are not an initial-host attestation.
// There is deliberately no environment or command-line override for this verdict.
export function hostNamespaceEvidence({ procfs = createProcfs() } = {}) {
  const namespace = observe(() => procfs.readPidNamespace())
  return { status: 'unknown', reason: 'not in the host PID namespace', namespace: namespace.value ?? null }
}

export function recordedProcessPresence(pid, { platform, procfs, processSnapshot } = {}) {
  if (platform === 'linux') return procfsProcessPresence(pid, { platform, stat: () => procfs.processDirectoryStat(pid) }).status
  try {
    const snapshot = processSnapshot ? processSnapshot() : createHostAdapter({ platform }).readProcessSnapshot()
    if (!snapshot.supported || !Array.isArray(snapshot.processes)) return 'unknown'
    return snapshot.processes.some(row => row.pid === Number(pid)) ? 'present' : 'absent'
  } catch { return 'unknown' }
}

function processLinks(procfs, pid) {
  return [
    [observe(() => procfs.readWorkingDirectory(pid)), args => procfs.statWorkingDirectory(pid, args)],
    [observe(() => procfs.readRootDirectory(pid)), args => procfs.statRootDirectory(pid, args)],
    [observe(() => procfs.readExecutable(pid)), args => procfs.statExecutable(pid, args)],
  ]
}

function descriptorLinks(procfs, pid, listing) {
  if (listing.error) return []
  return listing.value.map(fd => [observe(() => procfs.readDescriptorTarget(pid, fd)), args => procfs.statDescriptor(pid, fd, args)])
}

function excludedProcess(owner, links, descriptors, uid, result) {
  if (owner !== uid) {
    if (links[0][0].error) result.foreignUnreadable++
    return true
  }
  if ([links[0][0].error, links[2][0].error, descriptors.error].every(error => error === 'EACCES')) {
    result.nonDumpable++
    return true
  }
  return false
}

function mappedReferences(value) {
  // Kernel maps escapes newlines as \012; a literal backslash spelling is ambiguous.
  return [...new Set([value, value.replaceAll('\\012', '\n')])].map(reference => canonicalReference(reference))
}

function appendPaths(procfs, pid, cwd, result) {
  const maps = observe(() => procfs.readMaps(pid, 'utf8'))
  const argv = observe(() => procfs.readCommandLine(pid, 'utf8'))
  if (maps.error || argv.error) { result.status = 'unknown'; return }
  for (const line of maps.value.split('\n')) {
    const match = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/)
    if (match) result.references.push(...mappedReferences(match[1]))
  }
  for (const token of argv.value.split('\0').filter(Boolean)) {
    const value = token.startsWith('--') && token.includes('=') ? token.slice(token.indexOf('=') + 1) : token
    if (!value || value.startsWith('-')) continue
    result.references.push(canonicalReference(path.resolve(cwd, value)))
  }
}

function inspectReferences(links, options) {
  const references = []
  let unknown = false
  let excluded = false
  for (const [link, magicStat] of links) {
    if (gone(link.error)) continue
    if (link.error) { unknown = true; continue }
    const checked = checkedReference(link.value, magicStat, options)
    if (checked.mismatchExcluded) excluded = true
    if (checked.unknown) unknown = true
    if (checked.path) references.push(checked.path)
  }
  return { references, unknown, excluded: excluded && !unknown && references.length === 0 }
}

function inspectProcess(procfs, pid, options, result) {
  const owner = observe(() => procfs.processDirectoryStat(pid))
  if (gone(owner.error)) return
  if (owner.error) { result.status = 'unknown'; return }
  const links = processLinks(procfs, pid)
  const descriptors = observe(() => procfs.listDescriptors(pid))
  if (excludedProcess(owner.value.uid, links, descriptors, options.uid, result)) return
  if ([...links.map(([link]) => link.error), descriptors.error].some(gone)) return
  if (descriptors.error || links.some(([link]) => link.error)) { result.status = 'unknown'; return }
  const checked = inspectReferences([...links, ...descriptorLinks(procfs, pid, descriptors)], options)
  if (checked.excluded) result.mismatchExcluded++
  if (checked.unknown) result.status = 'unknown'
  result.references.push(...checked.references)
  appendPaths(procfs, pid, links[0][0].value, result)
}

function ownCwdWitness(current, descriptor, target, options) {
  return current === options.pid && descriptor === 'cwd' && target === canonicalReference(options.cwd)
}

function lsofReferences(stdout, options) {
  const references = []
  let current = null
  let descriptor = null
  let witnessed = false
  for (const line of stdout.split('\n')) {
    switch (line[0]) {
      case 'p': current = Number(line.slice(1)); descriptor = null; break
      case 'f': descriptor = line.slice(1); break
      case 'n': {
        const target = canonicalReference(line.slice(1))
        references.push(target)
        if (ownCwdWitness(current, descriptor, target, options)) witnessed = true
        break
      }
    }
  }
  return { references, witnessed }
}

function darwinProcesses({ lsofRun = spawnSync, uid, pid = process.pid, cwd = process.cwd() }) {
  const listing = lsofRun('lsof', ['-n', '-P', '-F', 'pfn', '-u', String(uid)], { encoding: 'utf8', timeout: 5000 })
  const { references, witnessed } = lsofReferences(listing.stdout ?? '', { pid, cwd })
  const result = { ...empty(), references }
  if (listing.status !== 0 || !witnessed) return { ...result, status: 'unknown', reason: 'lsof missing or own-cwd witness unavailable' }
  return result
}

function processOptions({ platform = process.platform, procfs = createProcfs(), uid = process.getuid?.(), ...options }) {
  return { ...options, platform, procfs, uid }
}

export function scanSweepProcesses(input = {}) {
  const options = processOptions(input)
  const { platform, procfs, uid } = options
  if (platform === 'win32') return { ...empty(), status: 'unknown', reason: 'holders unknown on Windows' }
  if (platform === 'darwin') return darwinProcesses({ ...options, uid })
  const result = empty()
  try {
    for (const pid of procfs.listProcesses().filter(value => /^\d+$/.test(value))) {
      inspectProcess(procfs, pid, { ...options, uid }, result)
    }
  } catch { result.status = 'unknown' }
  if (result.status === 'unknown') result.reason = 'unknown-process'
  return result
}
