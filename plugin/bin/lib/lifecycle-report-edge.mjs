import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
export function archiveLifecycle({ root, laneDir, cardId, route, head, phases, evidence, implementation, assertDirectories, copy, git, sha256, writeRegularFile }) {
  assertDirectories()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(root, '.claude', 'reports', `${cardId}-${stamp}`)
  const temporary = `${target}.tmp-${randomUUID()}`
  const manifestContent = `${JSON.stringify({ cardId, route, commit: head, phases, evidence }, null, 2)}\n`
  const summary = { commit: head, archive: { path: target, manifest_sha256: sha256(manifestContent) }, lifecycle_implementation: implementation }
  try {
    assertDirectories()
    copy(laneDir, temporary, { recursive: true, dereference: false })
    writeRegularFile(path.join(temporary, 'manifest.json'), manifestContent)
    fs.renameSync(temporary, target)
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
  if (git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('archive dirtied the tree')
  writeRegularFile(path.join(target, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeRegularFile(path.join(laneDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}
