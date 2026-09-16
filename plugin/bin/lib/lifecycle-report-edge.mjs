// Owns report commit reconciliation and archive publication; it must not decide lifecycle transitions or tools.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { treeSignature } from './gate-evidence.mjs'
function resolveThroughExisting(requested) {
  let probe = path.resolve(requested)
  const suffix = []
  while (!fs.existsSync(probe)) { suffix.unshift(path.basename(probe)); probe = path.dirname(probe) }
  return path.resolve(fs.realpathSync(probe), ...suffix)
}

// The archive must never land inside the tree it archives: `git worktree remove` would destroy the run
// and its record in one act. Checked at construction (preflight) AND at archive time, on the resolved path.
export function assertArchiveOutsideWorktree({ root, archiveRoot, target = path.join(archiveRoot ?? '', '.claude', 'reports') }) {
  if (typeof archiveRoot !== 'string' || !path.isAbsolute(archiveRoot)) throw new Error('lifecycle archiveRoot must be an absolute path')
  const resolved = resolveThroughExisting(target)
  const relativeTarget = path.relative(fs.realpathSync(root), resolved)
  if (relativeTarget === '' || (relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget))) {
    throw new Error(`archive destination must be outside the lifecycle worktree: ${resolved} (pass --archive-root <project root>)`)
  }
  return resolved
}

export function archiveLifecycle({ root, archiveRoot, laneDir, cardId, route, head, phases, evidence, partial, implementation, assertDirectories, copy, git, sha256, writeRegularFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = assertArchiveOutsideWorktree({ root, archiveRoot, target: path.join(archiveRoot ?? '', '.claude', 'reports', `${cardId}-${stamp}`) })
  const temporary = `${target}.tmp-${randomUUID()}`
  const manifestContent = `${JSON.stringify({ cardId, route, commit: head, phases, evidence, partial: partial ?? null }, null, 2)}\n`
  const summary = { commit: head, archive: { path: target, manifest_sha256: sha256(manifestContent) }, lifecycle_implementation: implementation, partial: partial ?? null }
  let wroteLaneSummary = false
  try {
    assertDirectories()
    copy(laneDir, temporary, { recursive: true, dereference: false })
    writeRegularFile(path.join(temporary, 'manifest.json'), manifestContent)
    writeRegularFile(path.join(temporary, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    writeRegularFile(path.join(laneDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    wroteLaneSummary = true
    // The external copy cannot dirty root, but the lane summary still must remain ignored.
    if (git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('archive dirtied the tree')
    fs.renameSync(temporary, target)
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    if (wroteLaneSummary) fs.rmSync(path.join(laneDir, 'summary.json'), { force: true })
    throw error
  }
  return summary
}

export function completeLifecycleReport({
  root,
  archiveRoot,
  laneDir,
  cardId,
  sessionTag,
  route,
  state,
  evidencePath,
  phases,
  implementation,
  assertDirectories,
  copy,
  git,
  sha256,
  readRegularFile,
  writeRegularFile,
  refusal,
}) {
  try {
    if (state.report.stage === 'commit-unknown' || state.report.stage === 'committed') {
      let currentHead
      try { currentHead = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {
        state.report.stage = 'commit-unknown'
        return refusal('report->awaiting_fidelity', 'commit unknown, retry', root)
      }
      if (state.report.stage === 'commit-unknown') {
        let currentTree
        try { currentTree = git('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim() } catch {
          return refusal('report->awaiting_fidelity', 'commit unknown, retry', root)
        }
        if (currentHead === state.report.base || !state.report.tree || currentTree !== state.report.tree) {
          return refusal('report->awaiting_fidelity', 'commit unknown, retry', root)
        }
        state.report.stage = 'committed'
        state.report.head = currentHead
      } else if (currentHead !== state.report.head) {
        return refusal('report->awaiting_fidelity', 'committed HEAD unchanged', root)
      }
    }
    if (state.report.stage === 'idle') {
      const base = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      state.report.base = base
      git('git', ['add', '-A'], { cwd: root })
      state.report.stage = 'staged'
      if (treeSignature(root) !== state.verifySnapshot.tree) {
        git('git', ['reset'], { cwd: root })
        state.report.stage = 'idle'
        return refusal('report->awaiting_fidelity', 'tree signature unchanged after staging', root)
      }
      try { state.report.tree = git('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim() } catch { state.report.tree = null }
      const report = readRegularFile(path.join(laneDir, 'pilot-report.md'))
      let commitError = null
      try {
        git(
          'git',
          [
            'commit',
            ...(state.partial ? ['--allow-empty'] : []),
            '-m',
            (report.split(/\r?\n/).find(Boolean) ?? `pilot lifecycle ${cardId}`).replace(/^#\s*/, ''),
            '-m',
            `card: ${cardId}\nsession: ${sessionTag}\ntree: ${treeSignature(root)}\nevidence: ${sha256(readRegularFile(evidencePath) ?? '')}`,
          ],
          { cwd: root },
        )
      } catch (error) { commitError = error }
      let head
      try {
        head = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      } catch {
        try { head = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() } catch {
          state.report.stage = 'commit-unknown'
          return refusal('report->awaiting_fidelity', 'commit unknown, retry', root)
        }
      }
      if (head === base) {
        git('git', ['reset'], { cwd: root })
        state.report = { stage: 'idle', base: null, head: null, tree: null }
        return refusal('report->awaiting_fidelity', 'changed HEAD', root)
      }
      state.report.stage = 'committed'
      state.report.head = head
      if (commitError) throw commitError
      if (git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
        return refusal('report->awaiting_fidelity', 'clean tree', root)
      }
    }
    archiveLifecycle({
      root,
      archiveRoot,
      laneDir,
      cardId,
      route,
      head: state.report.head,
      phases,
      evidence: sha256(readRegularFile(evidencePath) ?? ''),
      partial: state.partial,
      implementation,
      assertDirectories,
      copy,
      git,
      sha256,
      writeRegularFile,
    })
    state.report.stage = 'archived'
  } catch (error) {
    if (state.report.stage === 'staged') {
      try { git('git', ['reset'], { cwd: root }) } catch {}
      state.report = { stage: 'idle', base: null, head: null, tree: null }
    }
    return refusal(
      'report->awaiting_fidelity',
      `${state.report.stage === 'committed' ? 'archive' : 'commit'} (${error instanceof Error ? error.message : String(error)})`,
      root,
    )
  }
  return null
}
