#!/usr/bin/env node
// WHY: a sequential retry can launch another pilot before the first writes liveness.
// Read ownership from successful PostToolUse spawns AND card-scoped liveness; never reserve
// at PreToolUse. Concurrent spawns in one message remain outside this guard's guarantee.
// PROMOTION: deny only after human review of >=20 distinct real-origin firings as true,
// with none false. Review with `node <this file> review --list|--mark <fid> true|false`.
// An ack releases ownership here: acknowledging a pilot takes responsibility for a successor.
// The 12-hour horizon is heuristic: pilots waiting longer without transitions lose coverage.
// CROSS-PLATFORM: Node filesystem/path/crypto only, no process probes or shell commands.
// Missing/unreadable ownership degrades silently to no evidence, not proof of completion;
// unexpected errors fail open with a trace. Windows concurrent journal/review append is
// UNVERIFIED (same boundary as guard-journal.mjs); single-process append is portable.

import { createHash } from 'node:crypto'
import { pilotCardIds, respawnOf, isPilotType } from './lib/pilot-card-ids.mjs'
import { defaultLivenessDir } from './lib/liveness.mjs'
import { defaultRegistryDir } from './lib/host/delegate-wake-files.mjs'
import { homeDirectory } from './lib/host/home-directory.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'
import { pilotOwnershipSnapshot, pilotReviewSnapshot, appendPilotReview } from './lib/host/duplicate-pilot-files.mjs'
import { guardMode, recordGuardEvent } from './lib/guard-journal.mjs'
import { defaultGuardJournalDir } from './lib/guard-journal-read.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'

const GUARD = 'wt-duplicate-pilot-guard-hook.mjs'
const VERSION = 'v2'
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const nonEmpty = value => typeof value === 'string' && value.length > 0
const validFid = fid => typeof fid === 'string' && /^[a-f0-9]{16}$/.test(fid)

function clock() {
  const override = Date.parse(process.env.WT_GUARD_JOURNAL_NOW || '')
  return Number.isFinite(override) ? override : Date.now()
}

function horizon() {
  const milliseconds = Number(process.env.WT_DUPLICATE_PILOT_HORIZON_H) * 3600_000
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 12 * 3600_000
}

function timestamp(at, now) {
  const value = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(value) ? Math.min(value, now) : -Infinity
}

// One pass per registry builds name -> latest ack time; every spawn lookup is then O(1). A
// per-spawn rescan of the records is quadratic, and a live session registry holds tens of
// thousands of lines.
function latestAcks(records) {
  const acks = new Map()
  for (const record of records) {
    if (record.t !== 'ack' || typeof record.name !== 'string' || !record.name) continue
    const at = Date.parse(record.at)
    if (Number.isFinite(at) && !(acks.get(record.name) >= at)) acks.set(record.name, at)
  }
  return acks
}

function laterAck(acks, spawn, name) {
  return typeof name === 'string' && !!name && acks.get(name) > Date.parse(spawn.at)
}

// A NAMED ack is resolved inside the registry that recorded it: names are session-scoped, so a
// name acked in one session says nothing about an agent of another. It ends the raw id that name
// was spawned as, so that raw id's liveness file stops counting too. A raw id is unique machine-
// wide, so an ack of it counts from any session's registry, except where that session NAMED an
// agent with the same string: there the ack is of the name, not of the raw id.
function excludedOwners(snapshot) {
  const excluded = new Set(snapshot.liveness.filter(record => record.complete).map(record => record.agentId))
  const rawAcks = new Map()
  const perRegistry = snapshot.registries.map(registry => {
    const acks = latestAcks(registry.records)
    const spawns = registry.records.filter(record => record.t === 'spawn')
    const names = new Set(spawns.map(spawn => spawn.childName).filter(name => typeof name === 'string' && name))
    for (const [name, at] of acks) {
      if (!names.has(name) && !(rawAcks.get(name) >= at)) rawAcks.set(name, at)
    }
    return { acks, spawns }
  })
  for (const { acks, spawns } of perRegistry) {
    for (const spawn of spawns) {
      if (typeof spawn.child !== 'string' || !spawn.child) continue
      if (laterAck(acks, spawn, spawn.childName) || laterAck(rawAcks, spawn, spawn.child)) excluded.add(spawn.child)
    }
  }
  return excluded
}

function latestActivity(records, now) {
  const activity = new Map()
  for (const record of records) {
    if (typeof record.agentId !== 'string') continue
    activity.set(record.agentId, Math.max(activity.get(record.agentId) ?? -Infinity, timestamp(record.at, now)))
  }
  return activity
}

function livenessCards(scope) {
  if (!scope.startsWith('card:')) return []
  return [...scope.matchAll(/(?:^|[\s,])card:(\d{19})(?!\d)/g)].map(match => match[1])
}

function findOwners(cards, snapshot, now, age) {
  const excluded = excludedOwners(snapshot)
  const owners = new Map()
  const add = (id, ownedCards, source) => {
    if (typeof id !== 'string' || !id || excluded.has(id)) return
    const matched = cards.filter(card => ownedCards.includes(card))
    if (!matched.length) return
    const owner = owners.get(id) || { id, cards: new Set(), sources: new Set() }
    matched.forEach(card => owner.cards.add(card))
    owner.sources.add(source)
    owners.set(id, owner)
  }
  for (const record of snapshot.liveness) {
    if (!record.complete && now - timestamp(record.updatedAt, now) <= age) {
      add(record.agentId, livenessCards(record.scope), `liveness ${record.file}`)
    }
  }
  for (const registry of snapshot.registries) {
    if (now - Math.min(registry.mtime, now) > age) continue
    const acks = latestAcks(registry.records)
    const lastSeen = latestActivity(registry.records, now)
    for (const spawn of registry.records.filter(record => record.t === 'spawn' && isPilotType(record.subagentType))) {
      if (!Array.isArray(spawn.cardIds) || laterAck(acks, spawn, spawn.childName)) continue
      const activity = Math.max(lastSeen.get(spawn.child) ?? -Infinity, timestamp(spawn.at, now))
      if (now - activity <= age) add(spawn.child, spawn.cardIds, `registry ${registry.file}, spawned at ${spawn.at}`)
    }
  }
  return [...owners.values()]
}

function reviewState() {
  const snapshot = pilotReviewSnapshot(defaultGuardJournalDir())
  const firings = new Map()
  for (const event of snapshot.events) {
    if (event.guard !== GUARD || event.class !== 'duplicate-pilot' || event.evidence?.version !== VERSION) continue
    if (!['warned', 'blocked', 'silent'].includes(event.decision) || !validFid(event.evidence?.fid)) continue
    if (!firings.has(event.evidence.fid)) firings.set(event.evidence.fid, event)
  }
  const reviews = new Map()
  for (const review of snapshot.reviews) {
    if (validFid(review.fid) && typeof review.verdict === 'boolean') reviews.set(review.fid, review.verdict)
  }
  const real = [...firings].filter(([, event]) => event.origin === 'real')
  return {
    firings, reviews,
    clean: real.filter(([fid]) => reviews.get(fid) === true).length,
    falsePositives: real.filter(([fid]) => reviews.get(fid) === false).length,
    complete: snapshot.complete,
  }
}

function reviewCommand(args) {
  const state = reviewState()
  if (args.length === 1 && args[0] === '--list') {
    for (const [fid, event] of state.firings) {
      process.stdout.write(`${JSON.stringify({ fid, verdict: state.reviews.get(fid) ?? 'pending', ...event })}\n`)
    }
    return
  }
  const [command, fid, verdict] = args
  if (args.length !== 3 || command !== '--mark' || !validFid(fid) || !state.firings.has(fid) || !['true', 'false'].includes(verdict)) {
    process.stderr.write('Usage: review --list | review --mark <listed fid> true|false\n')
    process.exitCode = 1
    return
  }
  appendPilotReview(defaultGuardJournalDir(), { fid, verdict: verdict === 'true', at: new Date(clock()).toISOString() })
}

function duplicateMessage(owners, override, state) {
  const cards = [...new Set(owners.flatMap(owner => [...owner.cards]))]
  const evidence = owners.map(owner => `${owner.id} (${[...owner.sources].join('; ')})`).join('\n')
  const probation = state.falsePositives
    ? `probation halted: ${state.falsePositives} reviewed false firing(s); fix the guard before promotion.`
    : `probation: ${state.clean}/20 reviewed true; review with node ${process.argv[1]} review --list`
  const incomplete = state.complete ? '' : ' probation evidence incomplete: part of the journal could not be read, so the guard only warns.'

  return `DUPLICATE PILOT — card ${cards.join(', ')} already has live ownership evidence:\n${evidence}\n` +
    `${probation}${incomplete}\n${override.length ? `RESPAWN-OF currently names: ${override.join(', ')}.\n` : ''}` +
    'Before taking over, confirm the predecessor ended AND its delegated work stopped first. ' +
    'For a deliberate successor, include this exact line (name every owner, including unresolved name/raw-id aliases):\n' +
    `RESPAWN-OF: ${owners.map(owner => owner.id).join(', ')}\n` +
    'For a batch with refused and launched spawns, map results by description, never position.'
}

function journalDecision(payload, owners, decision, cls, reason) {
  recordGuardEvent({
    guard: GUARD, decision, class: cls, reason, cwd: payload.cwd, session: payload.session_id, agent: payload.agent_id,
    evidence: {
      // A firing is reviewable only when both halves of its key exist; a partial key would merge
      // unrelated firings into one fid and let one verdict count for all of them.
      ...(nonEmpty(payload.session_id) && nonEmpty(payload.tool_use_id)
        ? { fid: digest(JSON.stringify([payload.session_id, payload.tool_use_id])) } : {}),
      version: VERSION,
      card: [...owners[0].cards][0], owner: digest(owners[0].id),
      source: digest(owners.flatMap(owner => [...owner.sources]).join('\n')),
    },
  })
}

function main() {
  if (process.argv[2] === 'review') return reviewCommand(process.argv.slice(3))
  const payload = readStdinJson()
  if (payload?.hook_event_name !== 'PreToolUse' || !['Agent', 'Task'].includes(payload.tool_name)) return
  if (!isPilotType(payload.tool_input?.subagent_type)) return
  // A resume continues an agent that already exists; it is never a second owner.
  if (payload.tool_input && Object.hasOwn(payload.tool_input, 'resume')) return
  const cards = pilotCardIds(payload.tool_input?.prompt)
  if (!cards.length) return
  const now = clock()
  const age = horizon()
  const snapshot = pilotOwnershipSnapshot(process.env.WT_LIVENESS_DIR || defaultLivenessDir(homeDirectory()), defaultRegistryDir(), now - age)
  const owners = findOwners(cards, snapshot, now, age)
  if (!owners.length) return
  const override = respawnOf(payload.tool_input?.prompt)
  if (owners.every(owner => override.includes(owner.id))) {
    journalDecision(payload, owners, 'silent', 'respawn-of', 'Explicit successor covers every owner')
    return
  }
  const state = reviewState()
  const deny = state.complete && state.clean >= 20 && state.falsePositives === 0
  const reason = duplicateMessage(owners, override, state)
  const observe = guardMode() === 'observe'
  journalDecision(payload, owners, observe ? 'silent' : (deny ? 'blocked' : 'warned'), 'duplicate-pilot', reason)
  if (observe) return
  const output = deny ? { permissionDecision: 'deny', permissionDecisionReason: reason } : { additionalContext: reason }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...output } }))
}

if (isInvokedDirectly(import.meta.url)) runFailOpenHook(GUARD, main, () => {
  process.exitCode = process.argv[2] === 'review' ? 1 : 0
})
