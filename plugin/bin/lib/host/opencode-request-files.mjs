import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function canonicalOpencodeDirectory(dir) {
  // The native API follows symlinks before '..', just as the process cwd does.
  return realpathSync.native(dir)
}

function requestDirectory(outDir) {
  try {
    return mkdtempSync(path.resolve(outDir, 'requests-'))
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error
    return mkdtempSync(path.join(tmpdir(), 'opencode-requests-'))
  }
}

export function requestDigest(taskfile) {
  return createHash('sha256').update(readFileSync(taskfile)).digest('hex')
}

export function renderEnvelopeRequests(tasks, outDir) {
  // Numeric prefixes keep distinct ids with the same sanitized spelling distinct.
  const request = requestDirectory(outDir)
  const taskfiles = tasks.map((task, index) => {
    const safeId = String(task.id).replace(/[^A-Za-z0-9_.-]/g, '_')
    const taskfile = path.join(request, `${index}-${safeId}.task.md`)
    writeFileSync(taskfile, String(task.prompt ?? ''), 'utf8')
    return { taskfile, sha256: requestDigest(taskfile) }
  })
  return { request, taskfiles }
}
