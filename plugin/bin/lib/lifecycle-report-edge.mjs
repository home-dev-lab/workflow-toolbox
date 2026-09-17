// Owns report commit reconciliation and archive publication; it must not decide lifecycle transitions or tools.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { treeSignature } from './gate-evidence.mjs'

const WORKTREE_RETENTION_FILE = path.join('.lane', 'worktree-retention.json')

export function readWorktreeRetentionMarker(root) {
  const markerPath = path.join(root, WORKTREE_RETENTION_FILE)
  let stat
  let marker
  try {
    stat = fs.lstatSync(markerPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`worktree removal refused: invalid retention marker ${markerPath} for card unknown (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  if (
    marker?.version !== 1 ||
    typeof marker.cardId !== 'string' ||
    !/^[A-Za-z0-9._-]+$/.test(marker.cardId) ||
    typeof marker.retainedAt !== 'string' ||
    typeof marker.reason !== 'string' ||
    typeof marker.phase !== 'string' ||
    typeof marker.worktree !== 'string' ||
    !path.isAbsolute(marker.worktree) ||
    !marker.expiry ||
    !('boardId' in marker.expiry) ||
    (marker.expiry.boardId !== null && typeof marker.expiry.boardId !== 'string') ||
    typeof marker.expiry.removeWhen !== 'string'
  ) {
    throw new Error(`worktree removal refused: invalid retention marker ${markerPath} for card ${typeof marker?.cardId === 'string' ? marker.cardId : 'unknown'}`)
  }
  return marker
}

export function writeWorktreeRetentionMarker({ root, cardId, partial, boardId = null, retainedAt }) {
  const spentBound = partial && (
    (partial.phase === 'critic' && /^plan not approved after \d+ critic rounds$/.test(partial.reason)) ||
    (['review', 'refutation'].includes(partial.phase) && new RegExp(`^${partial.phase} still requests changes after \\d+ harden rounds$`).test(partial.reason))
  )
  if (!spentBound) return false
  const resolvedRoot = fs.realpathSync(root)
  const markerPath = path.join(resolvedRoot, WORKTREE_RETENTION_FILE)
  const temporary = path.join(path.dirname(markerPath), `worktree-retention.${randomUUID()}.tmp`)
  const marker = {
    version: 1,
    cardId: String(cardId),
    worktree: resolvedRoot,
    retainedAt,
    reason: `bounded lifecycle spent: ${partial.reason}`,
    phase: partial.phase,
    expiry: { boardId: boardId === null ? null : String(boardId), removeWhen: 'card is absent or in Done or NotDoing' },
  }
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`)
    fs.renameSync(temporary, markerPath)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
  return true
}

function sameWorktree(left, right, platform) {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function removeLifecycleWorktree({ root, board, force = false, git = execFileSync, platform = process.platform }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('worktree path must be absolute')
  const resolvedRoot = fs.realpathSync(root)
  const markerPath = path.join(resolvedRoot, WORKTREE_RETENTION_FILE)
  const marker = readWorktreeRetentionMarker(resolvedRoot)
  let expired = false
  if (marker) {
    let markerWorktree
    try { markerWorktree = fs.realpathSync(marker.worktree) } catch { markerWorktree = marker.worktree }
    if (!sameWorktree(markerWorktree, resolvedRoot, platform)) {
      throw new Error(`worktree removal refused: retention marker ${markerPath} for card ${marker.cardId} names worktree ${markerWorktree}, not removal target ${resolvedRoot}`)
    }
    if (!board || typeof board.getCard !== 'function') {
      throw new Error(`worktree removal refused: retention marker ${markerPath} for card ${marker.cardId}; board unavailable, so retention expiry cannot be verified`)
    }
    let card
    let listName
    try {
      card = await board.getCard(marker.cardId)
      if (card) {
        listName = card.listName ?? card.list?.name
        if (!listName && card.listId && typeof board.listNameOf === 'function') listName = await board.listNameOf(String(card.listId))
        if (!listName) throw new Error('card list is unavailable')
      }
    } catch (error) {
      throw new Error(`worktree removal refused: retention marker ${markerPath} for card ${marker.cardId}; board unavailable (${error instanceof Error ? error.message : String(error)})`, { cause: error })
    }
    expired = card === null || card === undefined || ['Done', 'NotDoing'].includes(listName)
    if (!expired) {
      throw new Error(`worktree removal refused: retention marker ${markerPath} for open card ${marker.cardId} in list ${listName}: ${marker.reason}`)
    }
  }
  const commonOutput = git('git', ['-C', resolvedRoot, 'rev-parse', '--git-common-dir'], { cwd: path.dirname(resolvedRoot), encoding: 'utf8' })
  const commonDir = fs.realpathSync(path.resolve(resolvedRoot, String(commonOutput).trim()))
  const repositoryRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir
  git('git', ['-C', repositoryRoot, 'worktree', 'remove', ...(force ? ['--force'] : []), resolvedRoot], { cwd: repositoryRoot, stdio: 'inherit' })
  return { removed: true, expired, cardId: marker?.cardId ?? null }
}
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

export function archiveLifecycle({ root, archiveRoot, laneDir, cardId, route, head, phases, evidence, partial, implementation, routedCards = [], assertDirectories, copy, git, sha256, writeRegularFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = assertArchiveOutsideWorktree({ root, archiveRoot, target: path.join(archiveRoot ?? '', '.claude', 'reports', `${cardId}-${stamp}`) })
  const temporary = `${target}.tmp-${randomUUID()}`
  const manifestContent = `${JSON.stringify({ cardId, route, commit: head, phases, evidence, partial: partial ?? null, routed_cards: routedCards }, null, 2)}\n`
  const summary = { commit: head, archive: { path: target, manifest_sha256: sha256(manifestContent) }, lifecycle_implementation: implementation, partial: partial ?? null }
  let wroteLaneSummary = false
  try {
    assertDirectories()
    const statusBefore = git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    copy(laneDir, temporary, { recursive: true, dereference: false })
    writeRegularFile(path.join(temporary, 'manifest.json'), manifestContent)
    writeRegularFile(path.join(temporary, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    writeRegularFile(path.join(laneDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    wroteLaneSummary = true
    // The external copy cannot dirty root, but the lane summary still must remain ignored.
    if (git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) !== statusBefore) throw new Error('archive dirtied the tree')
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
  routedCards = [],
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
      routedCards,
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
