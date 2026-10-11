#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveBoardProjectDir } from './lib/actionability-planka-producer-core.mjs'
import { projectStatePath, snapshotPath, stateRoot } from './lib/actionability-state-paths.mjs'
import { createBoardClient } from './lib/board-http-client.mjs'
import { readJsonOrNull } from './lib/host/actionability-files.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { collectCompleteCards } from './lib/actionability-board-collect.mjs'
import { DEFAULT_REFRESH_TIMEOUT_MS, RefreshTimeout, remainingMilliseconds } from './lib/actionability-refresh-deadline.mjs'
import { positiveMilliseconds } from './lib/proposal-age.mjs'
import { produceSnapshot, recordBoardReadFailure, recordBoardReadStarted } from './wt-actionable-snapshot-producer-hook.mjs'

export { collectCompleteCards }

const DEFAULT_ENDPOINT = 'http://localhost:25478/mcp'
const USAGE = `Usage: wt-actionable-snapshot-refresh.mjs [--timeout-s <seconds>]

Refresh the current project's actionability snapshot through bounded Planka pages.
Default deadline: 90 s (WT_ACTIONABLE_REFRESH_TIMEOUT_MS overrides it).
The endpoint defaults to http://localhost:25478/mcp; override BOARD_LIST_MCP_URL if needed.
`

function pointerBoardId(projectDir) {
  const pointer = JSON.parse(readFileSync(resolve(projectDir, '.claude/planka.json'), 'utf8'))
  const boardId = typeof pointer?.boardId === 'string' ? pointer.boardId : ''
  if (!boardId) throw new Error('.claude/planka.json has no boardId')
  return boardId
}

function deadlineFetch(deadlineAt, request) {
  return (url, options) => request(url, { ...options,
    signal: AbortSignal.timeout(remainingMilliseconds(deadlineAt, 'board acquisition')) })
}

function freshPublication(state, startedAt) {
  return Boolean(state) && ['snapshot-written', 'superseded'].includes(state.lastOutcome) &&
    Number.isFinite(state.heartbeatAt) && state.heartbeatAt >= startedAt
}

function freshSnapshot(snapshot, startedAt) {
  return Number.isFinite(snapshot?.at) && snapshot.at >= startedAt
}

function checkedSnapshot(projectDir, startedAt) {
  const state = readJsonOrNull(projectStatePath(stateRoot(), projectDir))
  if (!freshPublication(state, startedAt)) {
    if (state?.lastReason === 'refresh-timeout') throw new RefreshTimeout('snapshot computation')
    throw new Error(`producer did not write a fresh snapshot (${state?.lastReason || state?.lastOutcome || 'no producer state'})`)
  }
  const snapshot = readJsonOrNull(snapshotPath(stateRoot(), projectDir))
  if (!freshSnapshot(snapshot, startedAt)) throw new Error('producer did not write a fresh snapshot (snapshot missing or stale)')
  return snapshot
}

function recordedComputationFailure(projectDir, phase) {
  const state = readJsonOrNull(projectStatePath(stateRoot(), projectDir))
  return phase === 'snapshot computation' && ['unavailable', 'unreachable'].includes(state?.lastOutcome)
}

function readFailureReason(error, phase) {
  if (phase === 'board pointer') return 'board-pointer-unreadable'
  return error?.transport === true ? 'board-unreachable' : 'board-read-failed'
}

function recordRefreshFailure(projectDir, error, deadlineAt, phase) {
  const timedOut = error instanceof RefreshTimeout || Date.now() >= deadlineAt
  if (!timedOut && recordedComputationFailure(projectDir, phase)) return error
  const reason = timedOut ? 'refresh-timeout' : readFailureReason(error, phase)
  const detail = (error instanceof Error ? error.message : String(error)).replace(/^board unavailable: /, '')
  recordBoardReadFailure(projectDir, reason, detail)
  return timedOut ? new RefreshTimeout(error.phase || phase) : error
}

// `produce` and `fetch` let tests exercise the real state contract without a live board.
export async function refreshSnapshot({ cwd = process.cwd(), endpoint = process.env.BOARD_LIST_MCP_URL || DEFAULT_ENDPOINT,
  produce = produceSnapshot, fetch: request = globalThis.fetch,
  timeoutMs = positiveMilliseconds(process.env.WT_ACTIONABLE_REFRESH_TIMEOUT_MS, DEFAULT_REFRESH_TIMEOUT_MS) } = {}) {
  const startedAt = Date.now()
  const deadlineAt = startedAt + timeoutMs
  const projectDir = resolveBoardProjectDir(resolve(cwd), existsSync) || resolve(cwd)
  let phase = 'board pointer'
  try {
    const boardId = pointerBoardId(projectDir)
    phase = 'board acquisition'
    recordBoardReadStarted(projectDir, deadlineAt)
    const client = createBoardClient({ url: endpoint, boardId, fetch: deadlineFetch(deadlineAt, request) })
    const cards = await collectCompleteCards((offset, limit) => client.findCards({ limit, offset, includeDescription: true }), { deadlineAt })
    phase = 'snapshot computation'
    remainingMilliseconds(deadlineAt, phase)
    produce({ hook_event_name: 'PostToolUse', tool_name: 'mcp__planka__find_cards', tool_input: { boardId },
      tool_response: { content: [{ type: 'text', text: JSON.stringify(cards) }] }, cwd: projectDir,
      acquisitionStartedAt: startedAt, deadlineAt })
    const snapshot = checkedSnapshot(projectDir, startedAt)
    const finishedAt = Date.now()
    return { cards: cards.length, actionable: snapshot.actionable, elapsedSeconds: (finishedAt - startedAt) / 1000,
      pastDeadline: finishedAt >= deadlineAt }
  } catch (error) {
    throw recordRefreshFailure(projectDir, error, deadlineAt, phase)
  }
}

function printRefreshResult(result, timeoutMs) {
  if (result.pastDeadline) {
    process.stderr.write(`Actionability snapshot refresh finished in ${result.elapsedSeconds.toFixed(2)} s, past its ${timeoutMs / 1000} s bound (snapshot was published)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`Actionability snapshot refreshed: ${result.actionable} actionable from ${result.cards} cards in ${result.elapsedSeconds.toFixed(2)} s.\n`)
}

function timeoutArgument(args) {
  if (args.length === 0) return positiveMilliseconds(process.env.WT_ACTIONABLE_REFRESH_TIMEOUT_MS, DEFAULT_REFRESH_TIMEOUT_MS)
  const seconds = Number(args[1])
  if (args.length !== 2 || args[0] !== '--timeout-s' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Unknown or invalid argument: ${args.join(' ')}`)
  }
  return seconds * 1000
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return process.stdout.write(USAGE)
  let timeoutMs
  try { timeoutMs = timeoutArgument(args) } catch (error) {
    process.stderr.write(`${USAGE}\n${error.message}\n`)
    process.exitCode = 2
    return
  }
  try {
    const result = await refreshSnapshot({ timeoutMs })
    printRefreshResult(result, timeoutMs)
  } catch (error) {
    const message = error instanceof RefreshTimeout
      ? `Actionability snapshot refresh did not finish within ${timeoutMs / 1000} s (${error.phase})`
      : `Actionability snapshot refresh failed: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}

if (isInvokedDirectly(import.meta.url)) await main()
