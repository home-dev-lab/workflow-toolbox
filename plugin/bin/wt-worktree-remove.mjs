#!/usr/bin/env node
import { resolve } from 'node:path'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'
import { createBoardClient } from './lib/board-http-client.mjs'
import { readWorktreeRetentionMarker, removeLifecycleWorktree } from './lib/lifecycle-report-edge.mjs'

const USAGE = 'Usage: node wt-worktree-remove.mjs --dir <absolute-worktree-path> [--force]'

function parseArgs(argv) {
  const options = { dir: null, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') options.dir = argv[++i] ?? null
    else if (argv[i] === '--force') options.force = true
    else if (argv[i] === '--help' || argv[i] === '-h') return { help: true }
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!options.dir) throw new Error(USAGE)
  options.dir = resolve(options.dir)
  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) process.stdout.write(`${USAGE}\n`)
  else {
    const marker = readWorktreeRetentionMarker(options.dir)
    const boardUrl = resolveWorkflowToolboxOption('planka_mcp_url').value
    const board = marker ? createBoardClient({ url: boardUrl, boardId: marker.expiry.boardId }) : null
    const result = await removeLifecycleWorktree({ root: options.dir, board, force: options.force })
    const expiry = result.expired ? ` after card ${result.cardId} retention expired` : ''
    process.stdout.write(`removed worktree ${options.dir}${expiry}\n`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
