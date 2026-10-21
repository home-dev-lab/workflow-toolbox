// Pure deadline and activity decisions; timestamps stay at full precision until rendered.
export function unattendedMaxSeconds({ timeout, decisionGrace, maxExtensions }) {
  return (maxExtensions + 1) * (timeout + decisionGrace)
}

export function liveDescendants(processes, rootPid) {
  const children = new Map()
  for (const row of processes) {
    const parent = row.ppid ?? row.parentPid
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(parent)) continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(row.pid)
  }
  const seen = new Set([rootPid])
  const pending = [rootPid]
  const descendants = []
  while (pending.length) {
    for (const pid of children.get(pending.pop()) ?? []) {
      if (seen.has(pid)) continue
      seen.add(pid)
      descendants.push(pid)
      pending.push(pid)
    }
  }
  return descendants
}

export function idleVerdict({ nowMs, lastActivityMs, windowSeconds, enforceSeconds, status }) {
  const silentSeconds = Math.max(0, (nowMs - lastActivityMs) / 1000)
  const known = status === 'known'
  return { silentSeconds, warn: known && silentSeconds >= windowSeconds, stop: known && enforceSeconds > 0 && silentSeconds >= enforceSeconds }
}

export function deadlineLine(kind, fields) {
  return `${kind} ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(' ')}`
}

export function laneBoundLine(opts, maxSeconds) {
  return deadlineLine('LANE_BOUND', { timeout: opts.timeout, decisionGrace: opts.decisionGrace, maxExtensions: opts.maxExtensions, unattendedMaxSeconds: maxSeconds, idleWindow: opts.idleWindow, idleTimeout: opts.idleTimeout || 'off' })
}

export function validateLaneTiming(out) {
  if (!Number.isFinite(out.maxBriefAge) || out.maxBriefAge <= 0) return '--max-brief-age must be a positive number of seconds'
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return '--timeout must be a positive number of seconds'
  if (!Number.isFinite(out.decisionGrace) || out.decisionGrace < 0) return '--decision-grace must be a non-negative number of seconds'
  if (!Number.isSafeInteger(out.maxExtensions) || out.maxExtensions < 0) return '--max-extensions must be a non-negative integer'
  return validateIdleOptions(out)
}

function validateIdleOptions(out) {
  if (!Number.isFinite(out.idleWindow) || out.idleWindow <= 0) return '--idle-window must be a positive number of seconds'
  if (!Number.isFinite(out.idleTimeout) || out.idleTimeout < 0) return '--idle-timeout must be a non-negative number of seconds'
  return null
}

function processActivity(snapshot, rootPid, requireCpu) {
  const rows = snapshot?.processes
  if (snapshot?.supported === false || !Array.isArray(rows)) return { status: 'unknown', reason: snapshot?.reason ?? 'process snapshot unavailable' }
  return familyActivity(snapshot, rows, rootPid, requireCpu)
}

function familyActivity(snapshot, rows, rootPid, requireCpu) {
  const usable = rows.filter((row) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid ?? row.parentPid))
  if (!usable.some((row) => row.pid === rootPid)) return { status: 'unknown', reason: snapshot?.reason ?? 'process snapshot missing child' }
  const descendants = liveDescendants(usable, rootPid)
  // Deadline defaults consume presence only; opt-in idle evidence also validates counters.
  if (!requireCpu) return { status: 'known', descendants }
  if (usable.length !== rows.length) return { status: 'unknown', reason: 'process snapshot contains unreadable ancestry' }
  const family = new Set([rootPid, ...descendants])
  return { descendants, ...validatedCpuEvidence(snapshot, usable, family) }
}

function validatedCpuEvidence(snapshot, usable, family) {
  const evidence = processCpuEvidence(snapshot, usable.filter((row) => family.has(row.pid)))
  if (evidence.status === 'known' && usable.some((row) => !isNamespaceInit(row) && (row.ppid ?? row.parentPid) <= 0)) return { status: 'unknown', reason: 'process snapshot contains unreadable ancestry' }
  return evidence
}

function isNamespaceInit(row) {
  // PID 1 legitimately has no visible parent; other nonpositive parents remain unknown.
  return row.pid === 1 && (row.ppid ?? row.parentPid) === 0
}

function processCpuEvidence(snapshot, family) {
  if (snapshot.unknownPids?.length) return { status: 'unknown', reason: 'process snapshot contains unreadable pids' }
  const unavailable = family.find((row) => !Number.isSafeInteger(row.cpuTicks) || row.cpuTicks < 0)
  if (unavailable) return { status: 'unknown', reason: `process CPU time unavailable for pid ${unavailable.pid}` }
  if (family.some((row) => row.activityTicks !== undefined && (!Number.isSafeInteger(row.activityTicks) || row.activityTicks < 0))) return { status: 'unknown', reason: 'process activity counters unavailable' }
  return { status: 'known', cpuTimes: family.map(({ pid, startIdentity, cpuTicks, activityTicks }) => ({ pid, startIdentity, cpuTicks, activityTicks })) }
}

export function activityEvidence({ snapshot, worktree, rootPid, requireCpu = true }) {
  if (!requireCpu) return baseActivityEvidence({ snapshot, worktree, rootPid })
  const processEvidence = processActivity(snapshot, rootPid, requireCpu)
  if (worktree.status !== 'known' || worktree.bounded) return { ...processEvidence, status: 'unknown', reason: 'worktree scan bounded or unknown' }
  return processEvidence
}

// Extracted unchanged from base; the default timeout consumes presence only.
function baseProcessActivity(snapshot, rootPid) {
  const rows = snapshot?.processes
  if (snapshot?.supported === false || !Array.isArray(rows)) return { status: 'unknown', reason: snapshot?.reason ?? 'process snapshot unavailable' }
  const usable = rows.filter((row) => Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid ?? row.parentPid))
  if (!usable.some((row) => row.pid === rootPid)) return { status: 'unknown', reason: snapshot?.reason ?? 'process snapshot missing child' }
  return { status: 'known', descendants: liveDescendants(usable, rootPid) }
}

export function baseActivityEvidence({ snapshot, worktree, rootPid }) {
  const processEvidence = baseProcessActivity(snapshot, rootPid)
  if (worktree.status !== 'known' || worktree.bounded) return { ...processEvidence, status: 'unknown', reason: 'worktree scan bounded or unknown' }
  return processEvidence
}
