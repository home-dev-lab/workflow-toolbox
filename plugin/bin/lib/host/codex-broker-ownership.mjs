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
  if (!item || item.pid !== identity.pid || !BROKER_PATTERN.test(String(item.command ?? ''))) return false
  const startedAt = processStart(item, observedAt)
  return startedAt !== null && Math.abs(startedAt - identity.startedAt) <= START_TIME_TOLERANCE_MS
}

const pause = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)

export function createCodexBrokerOwnership(adapter, env, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-second-opinion-codex-'))
  const now = options.now ?? Date.now
  const ownershipStartedAt = now()
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
    if (identity && adapter.platform !== 'win32') return identity.pid
    const observedAt = now()
    const processes = snapshot()
    if (!processes) return null
    if (!identity) {
      const companion = processes.find((item) => item.pid === companionPid)
      const companionStartedAt = processStart(companion, observedAt) ?? ownershipStartedAt
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
    if (adapter.platform !== 'win32') return identity.pid
    const currentBroker = processes.find((item) => item.pid === identity.pid)
    if (!sameIdentity(currentBroker, identity, observedAt)) return identity.pid
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
    const owned = adapter.platform === 'win32'
      ? BROKER_PATTERN.test(String(item.command ?? '')) && sameIdentity(item, identity, observedAt)
      : sameProcess(item, identity, observedAt)
    return owned
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
    if (!processes) return { status: 'unavailable', identities: [], reason: discoveryFailure }
    const identities = [...capturedDescendants.values()].filter((captured) => {
      const item = processes.find((process) => process.pid === captured.pid)
      return sameIdentity(item, captured, observedAt)
    })
    return { status: 'known', identities }
  }

  function forceEndVerifiedWindowsProcess(captured) {
    const observedAt = now()
    const processes = snapshot()
    if (!processes) return { status: 'unavailable', reason: discoveryFailure }
    const item = processes.find((process) => process.pid === captured.pid)
    if (!item) return { status: 'gone' }
    if (!sameIdentity(item, captured, observedAt)) return { status: 'changed' }
    const result = adapter.forceEndProcessFamily(captured.pid)
    return result?.status === 'ended'
      ? { status: 'signalled' }
      : { status: 'unavailable', reason: result?.reason ?? 'process termination unavailable on this platform' }
  }

  function stopCapturedWindowsDescendants() {
    for (const captured of capturedDescendants.values()) {
      const result = forceEndVerifiedWindowsProcess(captured)
      if (result.status === 'unavailable') return result
    }
    return { status: 'complete' }
  }

  function waitUntilWindowsFamilyGone() {
    const deadline = now() + stopTimeoutMs
    let state = currentOwnedProcess()
    let ownedDescendants = currentOwnedDescendants()
    while ((state.status === 'owned' || state.status === 'gone')
      && ownedDescendants.status === 'known'
      && (state.status === 'owned' || ownedDescendants.identities.length)
      && now() < deadline) {
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
        if (state.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${discoveryFailure}`]
        if (state.status === 'changed') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed before cleanup`]
        const descendantsBefore = currentOwnedDescendants()
        if (descendantsBefore.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${descendantsBefore.reason}`]
        if (state.status === 'gone' && descendantsBefore.identities.length === 0) return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker exited before cleanup; descendants cannot be safely discovered`]
        if (state.status === 'owned') {
          const rootResult = forceEndVerifiedWindowsProcess(identity)
          if (rootResult.status === 'changed') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed before cleanup`]
          if (rootResult.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${rootResult.reason}`]
        }
        const descendantResult = stopCapturedWindowsDescendants()
        if (descendantResult.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${descendantResult.reason}`]
        let family = waitUntilWindowsFamilyGone()
        if (family.state.status === 'unavailable' || family.ownedDescendants.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${family.ownedDescendants.reason ?? discoveryFailure}`]
        if (family.state.status === 'changed') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed during cleanup`]
        if (family.state.status === 'gone' && family.ownedDescendants.identities.length === 0) return [`stopped broker/app-server process family pid ${identity.pid} started by this call`]
        if (family.state.status === 'owned') {
          const rootResult = forceEndVerifiedWindowsProcess(identity)
          if (rootResult.status === 'changed') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed during cleanup`]
          if (rootResult.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${rootResult.reason}`]
        }
        const retryResult = stopCapturedWindowsDescendants()
        if (retryResult.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${retryResult.reason}`]
        family = waitUntilWindowsFamilyGone()
        if (family.state.status === 'unavailable' || family.ownedDescendants.status === 'unavailable') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: ${family.ownedDescendants.reason ?? discoveryFailure}`]
        if (family.state.status === 'changed') return [`app-server cleanup unavailable for owned broker pid ${identity.pid}: broker identity changed during cleanup`]
        if (family.state.status === 'gone' && family.ownedDescendants.identities.length === 0) return [`force-stopped broker/app-server process family pid ${identity.pid} started by this call`]
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
