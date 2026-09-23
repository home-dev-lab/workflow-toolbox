import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BROKER_PATTERN = /openai-codex[\\/]codex.*scripts[\\/]app-server-broker/i

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

function brokerDescendant(processes, companionPid) {
  const descendants = new Set([companionPid])
  let changed = true
  while (changed) {
    changed = false
    for (const item of processes) {
      if (!descendants.has(item.pid) && descendants.has(item.ppid)) {
        descendants.add(item.pid)
        changed = true
      }
    }
  }
  return processes.find((item) => item.pid !== companionPid && descendants.has(item.pid) && BROKER_PATTERN.test(String(item.command ?? '')))?.pid ?? null
}

export function createCodexBrokerOwnership(adapter, env) {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-second-opinion-codex-'))
  let brokerPid = null
  let discoveryFailure = null
  let stopped = false

  function capture(companionPid) {
    brokerPid ??= brokerFromState(root)
    if (brokerPid || !companionPid) return brokerPid
    try {
      const table = adapter.readProcessSnapshot()
      if (!table.supported) discoveryFailure = table.reason ?? 'process discovery unavailable on this platform'
      else brokerPid = brokerDescendant(table.processes, companionPid)
    } catch {
      discoveryFailure = 'process discovery unavailable on this platform'
    }
    return brokerPid
  }

  function stop(companionPid) {
    if (stopped) return []
    capture(companionPid)
    stopped = true
    if (!brokerPid) {
      rmSync(root, { recursive: true, force: true })
      return discoveryFailure ? [`app-server cleanup unavailable: ${discoveryFailure}`] : []
    }
    const result = adapter.endProcessFamily(brokerPid)
    rmSync(root, { recursive: true, force: true })
    return result?.status === 'ended'
      ? [`stopped broker/app-server process family pid ${brokerPid} started by this call`]
      : [`app-server cleanup unavailable for owned broker pid ${brokerPid}: ${result?.reason ?? 'host termination unavailable'}`]
  }

  return { env: { ...env, CLAUDE_PLUGIN_DATA: root }, capture, stop }
}
