import path from 'node:path'

function launchWindowReason(launch, lane) {
  if (!Number.isFinite(launch.recorded_at) || !Number.isFinite(lane.started_at)) return 'OpenCode launch record has no finite invocation window'
  if (launch.recorded_at < lane.started_at || Number.isFinite(lane.ended_at) && launch.recorded_at > lane.ended_at) return 'OpenCode launch recorded_at lies outside lane started_at..ended_at'
  return null
}

function launchSpellingReason(launch) {
  if (typeof launch.realpath !== 'string' || !path.isAbsolute(launch.realpath)) return 'OpenCode launch worktree identity unavailable'
  if (typeof launch.requested !== 'string' || !Array.isArray(launch.spellings)) return 'OpenCode launch spellings unavailable'
  const evidenced = new Set([launch.realpath])
  if (path.isAbsolute(launch.requested)) evidenced.add(launch.requested)
  if (launch.spellings.length !== evidenced.size || launch.spellings.some((value) => !evidenced.delete(value))) return 'OpenCode launch spellings differ from recorded evidence'
  return null
}

function launchReason(launch, lane) {
  if (launch?.version !== 1) return 'OpenCode launch record version unavailable'
  if (launch.launch_for !== lane.usage_file) return 'OpenCode launch_for differs from lane usage_file'
  if (!['private', 'shared'].includes(launch.store_kind)) return 'OpenCode launch store_kind unavailable or unknown'
  return launchWindowReason(launch, lane) ?? launchSpellingReason(launch)
}

function readLaunch(record, hostDir, readJson) {
  if (record.receipt?.launch !== undefined) return { launch: record.receipt.launch }
  if (!record.lane.usage_file) return {}
  if (typeof record.lane.usage_file !== 'string' || path.basename(record.lane.usage_file) !== record.lane.usage_file) return { reason: 'usage_file must name a host receipt basename' }
  try { return { launch: readJson(path.join(hostDir, `${record.lane.usage_file}.launch.json`)) } } catch (error) {
    if (error?.code === 'ENOENT') return {}
    return { reason: `OpenCode launch record unusable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function applyLaunch(record, launch, canonical) {
  record.launch = launch
  if (launch.realpath !== canonical) { record.blocked = true; record.reason = 'launch directory differs from report worktree realpath'; return }
  record.queryDirectories = new Set(launch.spellings)
  if (record.absent && launch.store_kind === 'private') { record.blocked = true; record.reason = 'private OpenCode store was not captured'; return }
  if (record.receipt?.alias_binding === 'stable') record.directories = new Set(launch.spellings)
}

export function bindLaneLaunch(record, hostDir, canonical, readJson) {
  record.directories = new Set([canonical])
  record.queryDirectories = new Set([canonical])
  if (record.family !== 'openai') return
  const evidence = readLaunch(record, hostDir, readJson)
  if (evidence.reason) { record.blocked = true; record.reason = evidence.reason; return }
  if (evidence.launch === undefined) {
    if (record.absent && record.lane.launch_evidence === true) {
      record.blocked = true
      record.reason = 'OpenCode launch evidence missing: no usable receipt or launch record'
    }
    return
  }
  const reason = launchReason(evidence.launch, record.lane)
  if (reason) { record.blocked = true; record.reason = reason; return }
  applyLaunch(record, evidence.launch, canonical)
}

export function ambiguousReceiptRows(record, canonical) {
  if (record.family !== 'openai' || !Array.isArray(record.receipt?.sessions)) return []
  return record.receipt.sessions.filter((row) => {
    if (!row || row.directory === canonical) return false
    if (record.launch?.spellings.includes(row.directory)) return !record.directories.has(row.directory)
    return record.receipt.store_kind !== 'private'
  })
}
