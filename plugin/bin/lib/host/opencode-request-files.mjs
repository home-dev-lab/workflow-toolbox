import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

const temporaryRequests = new Set()

export function canonicalOpencodeDirectory(dir, admission) {
  if (!admission) return path.resolve(dir)
  // The native API follows symlinks before '..', just as the process cwd does.
  return realpathSync.native(dir)
}

function requestDirectory(outDir, allowFallback) {
  try {
    return mkdtempSync(path.resolve(outDir, 'requests-'))
  } catch (error) {
    if (!allowFallback) throw error
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error
    const request = mkdtempSync(path.resolve(tmpdir(), 'opencode-requests-'))
    temporaryRequests.add(request)
    return request
  }
}

export function cleanupEnvelopeRequests() {
  for (const request of temporaryRequests) {
    try { rmSync(request, { recursive: true, force: true }) } catch (error) {
      process.stderr.write(`wt-opencode-envelope: request cleanup warning: ${error.message}\n`)
    }
    temporaryRequests.delete(request)
  }
}

export function requireWritableEnvelopeOutput(outDir) {
  const probe = path.join(outDir, `.write-probe-${randomUUID()}`)
  try {
    writeFileSync(probe, '', { flag: 'wx' })
    rmSync(probe)
  } catch (error) {
    throw new Error(`output directory is not writable: ${outDir}: ${error.message}`, { cause: error })
  }
}

export function requestDigest(taskfile) {
  return createHash('sha256').update(readFileSync(taskfile)).digest('hex')
}

export function renderEnvelopeRequests(tasks, outDir, { allowFallback = true } = {}) {
  // Numeric prefixes keep distinct ids with the same sanitized spelling distinct.
  const request = requestDirectory(outDir, allowFallback)
  const taskfiles = tasks.map((task, index) => {
    const safeId = String(task.id).replace(/[^A-Za-z0-9_.-]/g, '_')
    const taskfile = path.join(request, `${index}-${safeId}.task.md`)
    writeFileSync(taskfile, String(task.prompt ?? ''), 'utf8')
    return { taskfile, sha256: requestDigest(taskfile) }
  })
  return { request, taskfiles }
}
