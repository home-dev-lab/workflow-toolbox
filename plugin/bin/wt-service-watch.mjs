#!/usr/bin/env node
// Anthropic service-status supervisor, shipped as a plugin monitor.
//
// WHAT IT WATCHES: https://status.claude.com/api/v2/summary.json (Anthropic's
// public Statuspage — no auth, no key). It gates on the two components that
// affect a Claude Code session: "Claude API (api.anthropic.com)" and
// "Claude Code". `claude.ai` (the web app) degrading does not stop a CLI
// session from working, so it is deliberately ignored.
//
// WHY: during a real Anthropic outage, every other monitor keeps running —
// they are scripts, nothing stops them — but their events become noise the
// session cannot reason about. This watcher maintains a flag file
// (`<configDir>/.wt-service-degraded.json`) that other monitors consult
// (see lib/service-flag.mjs) to fall silent while it is live, and lifts it on
// recovery.
//
// THE ONE INVARIANT THAT MATTERS MOST: a FAILED PROBE IS NOT AN OUTAGE. If the
// HTTP request fails, times out, returns non-200, or the JSON can't be parsed
// or doesn't contain either gated component, this script must NEVER write or
// refresh the flag — a probe that silences all monitoring when the probe
// itself breaks is the exact defect this file exists to prevent. On a probe
// failure the existing flag (if any) is left to expire on its own, and the
// failure goes to STDERR only, never stdout — stdout is reserved for the
// transition lines other consumers read as notifications.
//
// The flag also FAILS OPEN over time: it carries `expiresAt` and is refreshed
// on every poll that still sees degradation. A supervisor that dies mid-outage
// (crash, quota wall, `stop`) blinds the rest of the monitors for at most one
// expiry window, never indefinitely.

import { writeFile, rename, unlink, readFile } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { isServiceDegraded, defaultFlagPath } from './lib/service-flag.mjs'

const STATUS_URL = 'https://status.claude.com/api/v2/summary.json'

// The two components this user's Claude Code session actually depends on.
// `claude.ai` (the web app) is deliberately excluded — see file header.
// Matching is a normalised substring check, not exact equality: the upstream
// component NAMES are strings Anthropic controls and can rename; a defensive
// match with a documented fallback degrades gracefully where an exact-equality
// match would silently stop matching entirely the day the string changes.
function isApiComponent(name) {
  const n = String(name).toLowerCase()
  return n.includes('api.anthropic.com') || n.includes('claude api')
}
function isCodeComponent(name) {
  const n = String(name).toLowerCase()
  return n.includes('claude code')
}

function write(line) {
  process.stdout.write(`${line}\n`)
}

process.stdout.on('error', () => {
  process.exit(0)
})

function redact(text) {
  return String(text)
    .replace(/[A-Za-z0-9_.-]*[A-Za-z0-9][A-Za-z0-9_.-]{15,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m))
    .replace(/(bearer|token|authorization|api[-_ ]?key|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/[\r\n]+/g, ' ')
}

function fail(detail, code) {
  try {
    writeSync(2, `SERVICE WATCH FAILED: ${detail}\n`)
  } catch {
    // Nothing can be reported; the exit code is the only remaining signal.
  }
  process.exit(code)
}

function truncate(text, max) {
  const s = String(text)
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

function readPositiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// ---- CLI parsing (same shape as wt-arc-watch.mjs: paired --flag value) ----

const HELP = `wt-service-watch — poll Anthropic's status page and maintain a
degraded-service flag other monitors consult before emitting.

Options:
  --poll-healthy <seconds>   poll interval while operational (default 900 = 15min)
  --poll-degraded <seconds>  poll interval while degraded (default 180 = 3min) —
                              faster because the expensive thing is not noticing recovery
  --expiry <seconds>         flag time-to-live, refreshed each degraded poll (default 1200 = 20min)
  --timeout <ms>             HTTP request timeout (default 10000)
  --flag <path>              override the flag file path (default: <configDir>/.wt-service-degraded.json)
  --url <url>                override the status endpoint (default: ${STATUS_URL})
  --fixture <path>           TEST-ONLY: read a local JSON file instead of the network.
                              A missing/unreadable/malformed fixture is treated as a
                              probe failure, exactly like a real network error.
  --once                     run a single poll iteration then exit (used by tests)
  --help                     print this text and exit 0
`

let pollHealthySeconds = 900
let pollDegradedSeconds = 180
let expirySeconds = 1200
let timeoutMs = 10_000
let flagPath = defaultFlagPath()
let statusUrl = STATUS_URL
let fixturePath = null
let once = false

for (let i = 2; i < process.argv.length; i += 1) {
  const option = process.argv[i]
  if (option === '--help' || option === '-h') {
    write(HELP.trimEnd())
    process.exit(0)
  }
  if (option === '--once') {
    once = true
    continue
  }
  const raw = process.argv[i + 1]
  const value = typeof raw === 'string' && raw.startsWith('--') ? undefined : raw
  const shown = value === undefined ? '(missing)' : redact(value)
  if (option === '--poll-healthy') {
    const n = readPositiveNumber(value)
    if (n === null) fail(`invalid --poll-healthy: ${shown}`, 2)
    pollHealthySeconds = n
    i += 1
  } else if (option === '--poll-degraded') {
    const n = readPositiveNumber(value)
    if (n === null) fail(`invalid --poll-degraded: ${shown}`, 2)
    pollDegradedSeconds = n
    i += 1
  } else if (option === '--expiry') {
    const n = readPositiveNumber(value)
    if (n === null) fail(`invalid --expiry: ${shown}`, 2)
    expirySeconds = n
    i += 1
  } else if (option === '--timeout') {
    const n = readPositiveNumber(value)
    if (n === null) fail(`invalid --timeout: ${shown}`, 2)
    timeoutMs = n
    i += 1
  } else if (option === '--flag') {
    if (!value) fail(`missing value for --flag (got ${shown})`, 2)
    flagPath = value
    i += 1
  } else if (option === '--url') {
    if (!value) fail(`missing value for --url (got ${shown})`, 2)
    statusUrl = value
    i += 1
  } else if (option === '--fixture') {
    if (!value) fail(`missing value for --fixture (got ${shown})`, 2)
    fixturePath = value
    i += 1
  } else {
    fail(`unknown option: ${redact(option)}`, 2)
  }
}

// ---- probing ----

// Reads the raw status payload. Throws on ANY problem — network error,
// timeout, non-200, unparseable JSON, unreadable fixture. The caller treats
// every throw the same way: a probe failure, never an outage (invariant 1).
async function fetchPayload() {
  if (fixturePath) {
    const raw = await readFile(fixturePath, 'utf8')
    return JSON.parse(raw)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(statusUrl, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Turns a raw Statuspage payload into a decision. Throws when the payload
// cannot support one — missing/malformed `components`, or neither gated
// component present. An absent gated component is NOT "all clear": it means
// this script cannot tell, and "cannot tell" must never read as operational
// (invariant 2's closing clause).
function evaluate(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('payload is not an object')
  const components = payload.components
  if (!Array.isArray(components)) throw new Error('payload.components is missing or not an array')

  let apiComponent = null
  let codeComponent = null
  for (const c of components) {
    if (!c || typeof c.name !== 'string') continue
    if (!apiComponent && isApiComponent(c.name)) apiComponent = c
    if (!codeComponent && isCodeComponent(c.name)) codeComponent = c
  }
  if (!apiComponent && !codeComponent) {
    throw new Error('neither gated component ("Claude API" nor "Claude Code") found in payload')
  }

  const degradedComponents = [apiComponent, codeComponent].filter(
    (c) => c && typeof c.status === 'string' && c.status !== 'operational',
  )

  let incident = null
  if (degradedComponents.length > 0 && Array.isArray(payload.incidents) && payload.incidents.length > 0) {
    const inc = payload.incidents[0]
    const latestBody = inc?.incident_updates?.[0]?.body
    incident = {
      name: typeof inc?.name === 'string' ? truncate(inc.name, 200) : null,
      update: typeof latestBody === 'string' ? truncate(latestBody, 400) : null,
    }
  }

  return {
    degraded: degradedComponents.length > 0,
    indicator: typeof payload?.status?.indicator === 'string' ? payload.status.indicator : null,
    components: degradedComponents.map((c) => c.name),
    incident,
  }
}

// ---- flag persistence ----

async function writeFlagAtomic(targetPath, data) {
  const dir = path.dirname(targetPath)
  const tmp = path.join(dir, `.wt-service-degraded.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, targetPath)
}

async function removeFlagQuiet(targetPath) {
  try {
    await unlink(targetPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      process.stderr.write(`SERVICE WATCH: could not remove flag ${redact(targetPath)}: ${redact(error?.message ?? error)}\n`)
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---- one poll iteration ----

// `state` carries only what a single process cannot otherwise know: whether
// the LAST poll (this run or, seeded at startup, a still-live flag from a
// prior run) saw degradation, and since when. Everything else is recomputed
// fresh every poll.
async function pollOnce(state) {
  let evaluation
  try {
    const payload = await fetchPayload()
    evaluation = evaluate(payload)
  } catch (error) {
    // Invariant 1: a failed/unparseable probe is NOT an outage. Never touch
    // the flag; report to stderr only (stdout is transition-events-only).
    process.stderr.write(`SERVICE WATCH PROBE FAILED: ${redact(error?.message ?? error)}\n`)
    return state
  }

  const now = Date.now()

  if (evaluation.degraded) {
    const since = state.degraded ? state.degradedSince : now
    const flag = {
      since: new Date(since).toISOString(),
      expiresAt: new Date(now + expirySeconds * 1000).toISOString(),
      indicator: evaluation.indicator,
      components: evaluation.components,
      incident: evaluation.incident,
      writtenBy: process.pid,
      writtenAt: new Date(now).toISOString(),
    }
    try {
      await writeFlagAtomic(flagPath, flag)
    } catch (error) {
      process.stderr.write(`SERVICE WATCH: could not write flag ${redact(flagPath)}: ${redact(error?.message ?? error)}\n`)
    }
    if (!state.degraded) {
      const incidentText = evaluation.incident?.update ? ` — ${evaluation.incident.update}` : ''
      write(`SERVICE DEGRADED: ${evaluation.components.join(', ')}${incidentText}`)
    }
    return { degraded: true, degradedSince: since }
  }

  if (state.degraded) {
    const durationMin = Math.max(0, Math.round((now - state.degradedSince) / 60_000))
    write(`SERVICE RECOVERED: back to operational after ~${durationMin}min`)
    await removeFlagQuiet(flagPath)
  }
  return { degraded: false, degradedSince: null }
}

// ---- main ----

// Seed from an existing, still-live flag so a RESTART during an ongoing
// outage does not re-announce "DEGRADED" on its very next poll, and does not
// lose track of `since`.
let state = { degraded: false, degradedSince: null }
{
  const existing = await isServiceDegraded(flagPath)
  if (existing) {
    const since = Date.parse(existing.since)
    state = { degraded: true, degradedSince: Number.isFinite(since) ? since : Date.now() }
  }
}

for (;;) {
  state = await pollOnce(state)
  if (once) break
  const waitSeconds = state.degraded ? pollDegradedSeconds : pollHealthySeconds
  await wait(waitSeconds * 1000)
}
