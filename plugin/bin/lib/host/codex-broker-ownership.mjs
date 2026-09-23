import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BROKER_PATTERN = /openai-codex[\\/]codex.*scripts[\\/]app-server-broker/i
const START_TIME_TOLERANCE_MS = 1_500

function brokerFromState(root) {
  let entries
  try { entries = readdirSync(path.join(root, 'state'), { withFileTypes: true }) } catch { return null }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const state = JSON.parse(readFileSync(path.join(root, 'state', entry.name, 'broker.json'), 'utf8'))
      if (Number.isSafeInteger(state.pid) && state.pid > 0) return state.pid
    } catch { continue }
  }
  return null
}

function descendants(processes, rootPid) {
  const pids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const item of processes) {
      if (!pids.has(item.pid) && pids.has(item.ppid)) {
        pids.add(item.pid)
        changed = true
      }
    }
  }
  return pids
}

function processStart(item, observedAt) {
  return Number.isFinite(item?.elapsedMs) ? observedAt - item.elapsedMs : null
}

function processIdentity(item, observedAt) {
  const startedAt = processStart(item, observedAt)
  return startedAt === null ? null : { pid: item.pid, startedAt, command: String(item.command ?? '') }
}

function sameIdentity(item, identity, observedAt) {
  if (!item || item.pid !== identity.pid || String(item.command ?? '') !== identity.command) return false
  const startedAt = processStart(item, observedAt)
  return startedAt !== null && Math.abs(startedAt - identity.startedAt) <= START_TIME_TOLERANCE_MS
}

function sameProcess(item, identity, observedAt) {
  return BROKER_PATTERN.test(String(item?.command ?? '')) && sameIdentity(item, identity, observedAt)
}

const pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)

export function createCodexBrokerOwnership(adapter, env, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-second-opinion-codex-'))
  const now = options.now ?? Date.now
  const wait = options.wait ?? pause
  const remove = options.removeRoot ?? rmSync
  const stopTimeoutMs = options.stopTimeoutMs ?? (adapter.platform === 'win32' ? 3_000 : 750)
  const pollMs = options.pollMs ?? 25
  let identity = null
  const capturedDescendants = new Map()
  let claimedPid = null
  let discoveryFailure = null
  let stopped = false

  const removeRoot = () => {
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      try { remove(root, { recursive: true, force: true }); return } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt === 10) return
        wait(50)
      }
    }
  }

  function snapshot() {
    try {
      const table = adapter.readProcessSnapshot()
      if (table.supported) return table.processes
      discoveryFailure = table.reason ?? 'process discovery unavailable on this platform'
    } catch {
      discoveryFailure = 'process discovery unavailable on this platform'
    }
    return null
  }

  // This is called only while the spawned companion is known to be alive.
  function capture(companionPid) {
    if (!companionPid) return identity?.pid ?? null
    const observedAt = now()
    const processes = snapshot()
    if (!processes) return null
    if (!identity) {
      const companion = processes.find((item) => item.pid === companionPid)
      const companionStartedAt = processStart(companion, observedAt)
      if (companionStartedAt === null) return null
      const statePid = brokerFromState(root)
      if (statePid) claimedPid = statePid
      const family = descendants(processes, companionPid)
      const candidate = statePid
        ? processes.find((item) => item.pid === statePid)
        : processes.find((item) => item.pid !== companionPid && family.has(item.pid) && BROKER_PATTERN.test(String(item.command ?? '')))
      if (!candidate || !BROKER_PATTERN.test(String(candidate.command ?? ''))) return null
      const captured = processIdentity(candidate, observedAt)
      // A broker started before this companion cannot be ours; one started after it may lag by seconds under load.
      if (!captured || captured.startedAt < companionStartedAt - START_TIME_TOLERANCE_MS) return null
      claimedPid = candidate.pid
      identity = captured
    }
    const family = descendants(processes, identity.pid)
    for (const item of processes) {
      if (item.pid === identity.pid || !family.has(item.pid) || capturedDescendants.has(item.pid)) continue
      const captured = processIdentity(item, observedAt)
      if (captured) capturedDescendants.set(item.pid, captured)
    }
    return identity.pid
  }

  function currentOwnedProcess() {
    const observedAt = now()
    const processes = snapshot()
    if (!processes) return { status: 'unavailable', processes: [] }
    const item = processes.find((process) => process.pid === identity?.pid)
    if (!item) return { status: 'gone', processes }
    return sameProcess(item, identity, observedAt)
      ? { status: 'owned', processes }
      : { status: 'changed', processes }
  }

  function waitUntilGone() {
    const deadline = now() + stopTimeoutMs
    let state = currentOwnedProcess()
    while (state.status === 'owned' && now() < deadline) {
      wait(pollMs)
      state = currentOwnedProcess()
    }
    return state
  }

  function currentOwnedDescendants() {
    const observedAt = now()
    const processes = snapshot()
    if (!processes) return null
    return [...capturedDescendants.values()].filter((captured) => {
      const item = processes.find((process) => process.pid === captured.pid)
      return sameIdentity(item, captured, observedAt)
    })
  }

  function stopCapturedWindowsDescendants() {
    for (const captured of capturedDescendants.values()) {
      const observedAt = now()
      const processes = snapshot()
      if (!processes) return false
      const item = processes.find((process) => process.pid === captured.pid)
      if (sameIdentity(item, captured, observedAt)) adapter.forceEndProcessFamily(captured.pid)
    }
    return true
  }

  function waitUntilWindowsFamilyGone() {
    const deadline = now() + stopTimeoutMs
    let state = currentOwnedProcess()
    let ownedDescendants = currentOwnedDescendants()
    while ((state.status === 'owned' || ownedDescendants?.length) && now() < deadline) {
      wait(pollMs)
      state = currentOwnedProcess()
      ownedDescendants = currentOwnedDescendants()
    }
    return { state, ownedDescendants }
  }

  function stop() {
    if (stopped) return []
    stopped = true
    try {
      if (!identity) {
        if (claimedPid) return [`app-server cleanup unavailable for owned broker pid ${claimedPid}: broker identity changed before cleanup`]
        const reason = discoveryFailure ? `broker not captured; ${discoveryFailure}` : 'broker not captured before companion exit'
        return [`app-server cleanup unavailable: ${reason}`]
      }
      let state = currentOwnedProcess()
      if (adapter.platform === 'win32') {
        if (state.status === 'changed') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed before cleanup`]
        const descendantsBefore = currentOwnedDescendants()
        if (descendantsBefore === null) return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: process discovery unavailable on this platform`]
        if (state.status === 'gone' && descendantsBefore.length === 0) return [`broker/app-server process family pid ${identity.pid} already stopped`]
        if (state.status === 'owned') adapter.forceEndProcessFamily(identity.pid)
        if (!stopCapturedWindowsDescendants()) return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: process discovery unavailable on this platform`]
        let family = waitUntilWindowsFamilyGone()
        if (family.state.status !== 'owned' && !family.ownedDescendants?.length) return [`stopped broker/app-server process family pid ${identity.pid} started by this call`]
        adapter.forceEndProcessFamily(identity.pid)
        stopCapturedWindowsDescendants()
        family = waitUntilWindowsFamilyGone()
        if (family.state.status !== 'owned' && !family.ownedDescendants?.length) return [`force-stopped broker/app-server process family pid ${identity.pid} started by this call`]
        return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: process family remained alive after forced termination`]
      }
      if (state.status === 'gone') return [`broker/app-server process family pid ${identity.pid} already stopped`]
      if (state.status !== 'owned') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed before cleanup`]
      const graceful = adapter.endProcessFamily(identity.pid)
      state = waitUntilGone()
      if (state.status === 'gone' || state.status === 'changed') return [`stopped broker/app-server process family pid ${identity.pid} started by this call`]
      if (state.status !== 'owned') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed before cleanup`]
      const forced = adapter.forceEndProcessFamily(identity.pid)
      state = waitUntilGone()
      if (state.status === 'gone' || state.status === 'changed') return [`force-stopped broker/app-server process family pid ${identity.pid} started by this call`]
      const reason = forced?.reason ?? graceful?.reason ?? 'process family remained alive after SIGKILL'
      return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${reason}`]
    } catch (error) {
      return [`app-server cleanup unavailable for owned broker pid ${identity?.pid ?? claimedPid ?? 'unknown'}: ${error?.code ?? error?.message ?? String(error)}`]
    } finally {
      removeRoot()
    }
  }

  return { env: { ...env, CLAUDE_PLUGIN_DATA: root }, capture, stop }
}
