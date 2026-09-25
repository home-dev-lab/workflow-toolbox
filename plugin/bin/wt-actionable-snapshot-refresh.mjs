#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveBoardProjectDir } from './lib/actionability-planka-producer-core.mjs'
import { snapshotPath, stateRoot } from './lib/actionability-state-paths.mjs'
import { createBoardClient } from './lib/board-http-client.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { produceSnapshot } from './wt-actionable-snapshot-producer-hook.mjs'

const PAGE_SIZE = 10
const DEFAULT_ENDPOINT = 'http://localhost:25478/mcp'
const USAGE = `Usage: wt-actionable-snapshot-refresh.mjs

Refresh the current project's actionability snapshot through bounded Planka pages.
The endpoint defaults to http://localhost:25478/mcp; override BOARD_LIST_MCP_URL if needed.
`

function pageShape(result, expectedOffset, expectedTotal) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.cards)) {
    throw new Error('find_cards response has no cards[] array')
  }
  if (!Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset) || result.offset < 0) {
    throw new Error('find_cards response has invalid pagination metadata')
  }
  if (result.offset !== expectedOffset) throw new Error(`find_cards returned offset ${result.offset}, expected ${expectedOffset}`)
  if (expectedTotal !== null && result.total !== expectedTotal) {
    throw new Error(`find_cards total changed from ${expectedTotal} to ${result.total} during refresh`)
  }
  if (result.cards.length > PAGE_SIZE) throw new Error(`find_cards returned ${result.cards.length} cards for a ${PAGE_SIZE}-card page`)
  if (result.cards.length === 0 && expectedOffset < result.total) throw new Error('find_cards returned an empty page before total was reached')
  return result
}

export async function collectCompleteCards(fetchPage) {
  const cards = []
  let total = null
  while (total === null || cards.length < total) {
    const page = pageShape(await fetchPage(cards.length, PAGE_SIZE), cards.length, total)
    total = page.total
    cards.push(...page.cards)
    if (cards.length > total) throw new Error(`find_cards returned ${cards.length} cards for total ${total}`)
  }
  const ids = cards.map((card) => String(card?.id ?? ''))
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('find_cards pages contain a missing or duplicate card id')
  }
  return cards
}

export async function refreshSnapshot({ cwd = process.cwd(), endpoint = process.env.BOARD_LIST_MCP_URL || DEFAULT_ENDPOINT } = {}) {
  const projectDir = resolveBoardProjectDir(resolve(cwd), (path) => {
    try { readFileSync(path); return true } catch { return false }
  })
  if (!projectDir) throw new Error('no .claude/planka.json for this project or its ancestors')
  const pointer = JSON.parse(readFileSync(resolve(projectDir, '.claude/planka.json'), 'utf8'))
  const boardId = typeof pointer.boardId === 'string' ? pointer.boardId : ''
  if (!boardId) throw new Error('.claude/planka.json has no boardId')

  const client = createBoardClient({ url: endpoint, boardId })
  const cards = await collectCompleteCards((offset, limit) => client.findCards({ limit, offset, includeDescription: true }))
  const startedAt = Date.now()
  produceSnapshot({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__planka__find_cards',
    tool_input: { boardId },
    tool_response: { content: [{ type: 'text', text: JSON.stringify(cards) }] },
    cwd: projectDir,
  })
  const snapshot = JSON.parse(readFileSync(snapshotPath(stateRoot(), projectDir), 'utf8'))
  if (typeof snapshot.at !== 'number' || snapshot.at < startedAt) throw new Error('producer did not write a fresh snapshot')
  return { cards: cards.length, actionable: snapshot.actionable }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(USAGE)
    return
  }
  if (args.length > 0) {
    process.stderr.write(`${USAGE}\nUnknown argument: ${args[0]}\n`)
    process.exitCode = 2
    return
  }
  try {
    const result = await refreshSnapshot()
    process.stdout.write(`Actionability snapshot refreshed: ${result.actionable} actionable from ${result.cards} cards.\n`)
  } catch (error) {
    process.stderr.write(`Actionability snapshot refresh failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (isInvokedDirectly(import.meta.url)) await main()
