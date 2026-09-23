// Owns report commit reconciliation and archive publication; it must not decide lifecycle transitions or tools.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { treeSignature } from './gate-evidence.mjs'
import { costReportSection } from './run-cost-core.mjs'

const WORKTREE_RETENTION_FILE = path.join('.lane', 'worktree-retention.json')
const COST_BLOCK = /<!-- run-cost -->[\s\S]*?<!-- \/run-cost -->/g
const DELIVERED_ARTEFACT = /^-\s+Delivered artefact:\s+`([^`\r\n]+)`\s*$/

function declaredArtefactPaths(report) {
  const lines = report.split(/\r?\n/)
  const start = lines.findIndex((line) => /^## Implemented\s*$/.test(line))
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end)
    .map((line) => DELIVERED_ARTEFACT.exec(line)?.[1])
    .filter(Boolean)
}

function readBackDeclaredArtefacts({ root, report, startedAt, sha256 }) {
  const declarations = declaredArtefactPaths(report)
  if (new Set(declarations).size !== declarations.length) throw new Error('duplicate delivered artefact declaration')
  const canonicalRoot = fs.realpathSync(root)
  const startedAtMs = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt)
  return declarations.map((declaration) => {
    if (path.isAbsolute(declaration)) throw new Error(`declared artefact path must be relative: ${declaration}`)
    const requested = path.resolve(canonicalRoot, declaration)
    const relative = path.relative(canonicalRoot, requested)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`declared artefact path escapes the worktree: ${declaration}`)
    }
    let stat
    let canonical
    try {
      stat = fs.lstatSync(requested)
      canonical = fs.realpathSync(requested)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`missing declared artefact ${declaration}`)
      throw error
    }
    const canonicalRelative = path.relative(canonicalRoot, canonical)
    if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
      throw new Error(`declared artefact path escapes the worktree: ${declaration}`)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`declared artefact is not a regular file: ${declaration}`)
    if (stat.mtimeMs < startedAtMs) throw new Error(`declared artefact predates this run: ${declaration}`)
    const bytes = fs.readFileSync(requested)
    return {
      path: declaration,
      size: bytes.length,
      sha256: sha256(bytes),
      mtime: stat.mtime.toISOString(),
      modified_after_started: true,
    }
  })
}

function archiveFile(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`cannot read archive receipt ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`cannot read archive receipt ${file}: not a regular file`)
  try { return fs.readFileSync(file, 'utf8') } catch (error) {
    throw new Error(`cannot read archive receipt ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function divergentCostLine(expected, actual) {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const limit = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < limit; index += 1) {
    const expectedLine = expectedLines[index]
    const actualLine = actualLines[index]
    if (expectedLine === actualLine) continue
    if (expectedLine?.startsWith('| ') && actualLine?.startsWith('| ')) {
      const expectedCells = expectedLine.slice(1, -1).split('|').map((cell) => cell.trim())
      const actualCells = actualLine.slice(1, -1).split('|').map((cell) => cell.trim())
      const columns = ['Phase', 'Family', 'Model', 'Input', 'Cache write', 'Cache read', 'Output', 'Reasoning', 'First-pass input', 'Fresh', 'Wall ms']
      const cell = Math.max(0, expectedCells.findIndex((value, offset) => value !== actualCells[offset]))
      const phase = actualCells[0] || expectedCells[0] || 'unknown'
      const column = columns[cell] ?? `column ${cell + 1}`
      return `phase ${JSON.stringify(phase)}, ${column} expected ${JSON.stringify(expectedCells[cell] ?? '<missing>')} but report has ${JSON.stringify(actualCells[cell] ?? '<missing>')}`
    }
    return `line ${index + 1} expected ${JSON.stringify(expectedLine ?? '<missing>')} but report has ${JSON.stringify(actualLine ?? '<missing>')}`
  }
  return 'unknown divergence'
}

export function assertCostReportMatches({ report, cost, reportPath, costPath }) {
  const blocks = report?.match(COST_BLOCK) ?? []
  if (blocks.length === 0) throw new Error(`cost report consistency refused: missing Measured Run Cost block in ${reportPath}; cost receipt is ${costPath}`)
  const expected = costReportSection(cost).trimEnd()
  for (const [index, block] of blocks.entries()) {
    if (block === expected) continue
    // Never repair a stale report here: doing so would hide the ordering hazard this publication check exists to expose.
    const blockDetail = index === 0 ? '' : `; block ${index + 1}`
    throw new Error(`cost report consistency refused: first divergent row ${divergentCostLine(expected, block)}; report ${reportPath}; cost ${costPath}${blockDetail}`)
  }
}

function assertArchiveCostReport(directory, publishedDirectory = directory) {
  const report = archiveFile(path.join(directory, 'pilot-report.md'))
  const costContent = archiveFile(path.join(directory, 'cost.json'))
  const publishedReport = path.join(publishedDirectory, 'pilot-report.md')
  const publishedCost = path.join(publishedDirectory, 'cost.json')
  const block = report?.match(COST_BLOCK)?.[0] ?? null
  if (block === null && costContent === null) return
  if (block === null) throw new Error(`cost report consistency refused: missing Measured Run Cost block in ${publishedReport}; cost receipt is ${publishedCost}`)
  if (costContent === null) throw new Error(`cost report consistency refused: ${publishedReport} has a Measured Run Cost block but ${publishedCost} is missing`)
  let cost
  try { cost = JSON.parse(costContent) } catch (error) {
    throw new Error(`cost report consistency refused: cannot parse ${publishedCost}: ${error instanceof Error ? error.message : String(error)}; report is ${publishedReport}`, { cause: error })
  }
  assertCostReportMatches({ report, cost, reportPath: publishedReport, costPath: publishedCost })
}

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
    partial.reason === 'timeout' ||
    (partial.phase === 'critic' && /^plan not approved after \d+ critic rounds$/.test(partial.reason)) ||
    (['review', 'refutation'].includes(partial.phase) && partial.reason.startsWith(`${partial.phase} non-convergence:`))
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
  return path.resolve((fs.realpathSync.native ?? fs.realpathSync)(probe), ...suffix)
}

// The archive must never land inside the tree it archives: `git worktree remove` would destroy the run
// and its record in one act. Checked at construction (preflight) AND at archive time, on the resolved path.
export function assertArchiveOutsideWorktree({ root, archiveRoot, target = path.join(archiveRoot ?? '', '.claude', 'reports') }) {
  if (typeof archiveRoot !== 'string' || !path.isAbsolute(archiveRoot)) throw new Error('lifecycle archiveRoot must be an absolute path')
  const resolved = resolveThroughExisting(target)
  const relativeTarget = path.relative((fs.realpathSync.native ?? fs.realpathSync)(root), resolved)
  if (relativeTarget === '' || (relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget))) {
    throw new Error(`archive destination must be outside the lifecycle worktree: ${resolved} (pass --archive-root <project root>)`)
  }
  return resolved
}

export function archiveLifecycle({ root, archiveRoot, laneDir, cardId, route, head, phases, evidence, partial, deferred, implementation, delivery = { mode: 'commit', artifacts: [] }, routedCards = [], assertDirectories, copy, git, sha256, writeRegularFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = assertArchiveOutsideWorktree({ root, archiveRoot, target: path.join(archiveRoot ?? '', '.claude', 'reports', `${cardId}-${stamp}`) })
  const temporary = `${target}.tmp-${randomUUID()}`
  const manifestContent = `${JSON.stringify({ cardId, route, commit: head, phases, evidence, partial: partial ?? null, deferred: deferred ?? null, delivery, routed_cards: routedCards }, null, 2)}\n`
  const summary = { commit: head, archive: { path: target, manifest_sha256: sha256(manifestContent) }, lifecycle_implementation: implementation, partial: partial ?? null, deferred: deferred ?? null, delivery }
  let wroteLaneSummary = false
  try {
    assertDirectories()
    const statusBefore = git('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    copy(laneDir, temporary, { recursive: true, dereference: false })
    assertArchiveCostReport(temporary, target)
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
  startedAt,
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
      const report = readRegularFile(path.join(laneDir, 'pilot-report.md'))
      const artifacts = readBackDeclaredArtefacts({ root, report, startedAt, sha256 })
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
      if (artifacts.length > 0) {
        const baseTree = git('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim()
        if (state.report.tree === baseTree) {
          git('git', ['reset'], { cwd: root })
          state.report.stage = 'committed'
          state.report.head = base
          state.report.delivery = { mode: 'artefact-read-back', artifacts }
        }
      }
      let commitError = null
      if (state.report.stage === 'staged') try {
        git(
          'git',
          [
            'commit',
            ...(state.partial || state.deferred ? ['--allow-empty'] : []),
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
        if (state.report.stage === 'committed' && state.report.delivery?.mode === 'artefact-read-back') {
          head = base
        } else {
          git('git', ['reset'], { cwd: root })
          state.report = { stage: 'idle', base: null, head: null, tree: null, delivery: null }
          return refusal('report->awaiting_fidelity', 'changed HEAD; for a gitignored delivery add "- Delivered artefact: `relative/path`" under ## Implemented', root)
        }
      }
      state.report.stage = 'committed'
      state.report.head = head
      state.report.delivery ??= { mode: 'commit', artifacts }
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
      deferred: state.deferred,
      implementation,
      delivery: state.report.delivery,
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
      state.report = { stage: 'idle', base: null, head: null, tree: null, delivery: null }
    }
    return refusal(
      'report->awaiting_fidelity',
      `${state.report.stage === 'committed' ? 'archive' : 'commit'} (${error instanceof Error ? error.message : String(error)})`,
      root,
    )
  }
  return null
}
