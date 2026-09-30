#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'
import { createBoardClient } from './lib/board-http-client.mjs'
import { canonicalPath, resolveBoardPointer } from './lib/host/board-pointer.mjs'
import { readWorktreeRetentionMarker, removeLifecycleWorktree } from './lib/lifecycle-report-edge.mjs'

const USAGE = 'Usage: node wt-worktree-remove.mjs --dir <absolute-worktree-path> [--board-id <id>] [--force]'

function parseArgs(argv) {
  const options = { dir: null, boardId: null, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') options.dir = argv[++i] ?? null
    else if (argv[i] === '--board-id') {
      const value = argv[++i]
      if (!value || !value.trim() || value.startsWith('--')) throw new Error(`--board-id requires a value; ${USAGE}`)
      options.boardId = value
    }
    else if (argv[i] === '--force') options.force = true
    else if (argv[i] === '--help' || argv[i] === '-h') return { help: true }
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!options.dir) throw new Error(USAGE)
  options.dir = resolve(options.dir)
  return options
}

function removalBoard(marker, root, flag) {
  const markerPath = join(root, '.lane', 'worktree-retention.json')
  const prefix = `worktree removal refused: retention marker ${markerPath} for card ${marker.cardId}`
  const recorded = marker.expiry.boardId?.trim() ? marker.expiry.boardId : null
  if (recorded) {
    if (flag && flag !== recorded) throw new Error(`${prefix} names board ${recorded}; --board-id ${flag} disagrees; omit --board-id or pass --board-id ${recorded}`)
    return { boardId: recorded, boardIdFromMarker: true }
  }
  if (flag) return { boardId: flag, boardIdFromMarker: false }
  const pointer = resolveBoardPointer(root) ?? resolveBoardPointer(process.cwd())
  if (pointer?.boardId) return { boardId: pointer.boardId, boardIdFromMarker: false }
  if (pointer) throw new Error(`${prefix} records no board id; ${pointer.path} has no usable boardId; rerun with --board-id <board id>`)
  throw new Error(`${prefix} records no board id and no .claude/planka.json was found above ${root} or ${process.cwd()}; rerun with --board-id <board id>`)
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) process.stdout.write(`${USAGE}\n`)
  else {
    const root = canonicalPath(options.dir)
    const marker = readWorktreeRetentionMarker(root)
    const boardUrl = resolveWorkflowToolboxOption('planka_mcp_url').value
    const resolution = marker ? removalBoard(marker, root, options.boardId) : null
    const board = resolution ? createBoardClient({ url: boardUrl, boardId: resolution.boardId }) : null
    const result = await removeLifecycleWorktree({ root, board, boardIdFromMarker: resolution?.boardIdFromMarker ?? true, force: options.force })
    const expiry = result.expired ? ` after card ${result.cardId} retention expired` : ''
    process.stdout.write(`removed worktree ${options.dir}${expiry}\n`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
