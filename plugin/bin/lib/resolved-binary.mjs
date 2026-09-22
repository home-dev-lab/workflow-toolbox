// Resolve an executable exactly as the target shell platform does. A missing result is a
// genuine absence; lookup errors throw so callers can report the mechanism as unavailable.
export function resolvedBinary(bin, env, { accessSyncFn, constants, platform, realpathSyncFn, statSyncFn, pathApi }) {
  if (bin.includes('/') || bin.includes('\\')) {
    try { return realpathSyncFn(bin) } catch { return pathApi.resolve(bin) }
  }
  const pathKey = platform === 'win32' ? Object.keys(env).find((key) => key.toUpperCase() === 'PATH') : 'PATH'
  const pathExtKey = platform === 'win32' ? Object.keys(env).find((key) => key.toUpperCase() === 'PATHEXT') : undefined
  const searchPath = pathKey === undefined ? undefined : env[pathKey]
  if (!searchPath) return null
  const extensions = platform === 'win32' && pathApi.extname(bin) === ''
    ? String((pathExtKey === undefined ? undefined : env[pathExtKey]) || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const directory of searchPath.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = pathApi.resolve(directory || '.', `${bin}${extension}`)
      try {
        if (!statSyncFn(candidate).isFile()) continue
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw new Error(`could not search PATH for ${bin}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (platform !== 'win32') {
        try { accessSyncFn(candidate, constants.X_OK) } catch (error) {
          if (error?.code === 'EACCES' || error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
          throw new Error(`could not inspect PATH result for ${bin}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      try { return realpathSyncFn(candidate) } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue
        throw new Error(`could not resolve PATH result for ${bin}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return null
}

export function executableName(value, platform, pathExt = '') {
  const basename = String(value || '').split(/[\\/]/).at(-1) || ''
  if (platform !== 'win32') return basename
  const extensions = String(pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const extension = extensions.find((item) => basename.toLowerCase().endsWith(item.toLowerCase()))
  return extension ? basename.slice(0, -extension.length) : basename
}

export const IDLE_HELPER_SAFE_TO_STOP_SECONDS = 5 * 60

export function classifyIdleHelper({ argv, command, ageSeconds, relatedToTask, thresholdSeconds }) {
  const executableMatch = /codex(?:\.exe|\.cmd)?$/i.test(String(argv?.[0] ?? ''))
  const commandMatch = /codex(?:\.exe|\.cmd)?\s+app-server(?:\s|$)/i.test(String(command ?? ''))
  const helper = ((executableMatch && argv?.[1] === 'app-server') || commandMatch) && !relatedToTask
  return { helper, safeToStop: helper && Number.isFinite(ageSeconds) && ageSeconds > thresholdSeconds }
}

export function idleHelperEvents(rows, { ageByPid = new Map(), inspect = () => null } = {}) {
  const byPid = new Map(rows.map((item) => [item.pid, item]))
  const events = []
  const emitted = new Set()
  const relatedToTask = (pid) => {
    const seen = new Set()
    let current = byPid.get(pid)
    while (current && !seen.has(current.pid)) {
      if (/wt-second-opinion\.mjs|codex-companion\.mjs\s+task/i.test(current.command ?? '')) return true
      seen.add(current.pid)
      current = byPid.get(current.ppid)
    }
    return false
  }
  for (const item of rows) {
    const inspected = Array.isArray(item.argv) ? item : inspect(item.pid)
    const ageSeconds = Number.isFinite(item.elapsedMs) ? Number(item.elapsedMs) / 1000 : ageByPid.get(item.pid)
    const verdict = classifyIdleHelper({ argv: inspected?.argv ?? [], command: item.command, ageSeconds, relatedToTask: relatedToTask(item.pid), thresholdSeconds: IDLE_HELPER_SAFE_TO_STOP_SECONDS })
    const key = `idle-helper:${item.pid}:${inspected?.startTime ?? 'unknown'}`
    if (emitted.has(key)) continue
    if (verdict.safeToStop) events.push({ key, message: `IDLE HELPER safe to stop: Codex app-server pid=${item.pid} idle for more than ${IDLE_HELPER_SAFE_TO_STOP_SECONDS / 60} minutes` })
    else if (verdict.helper && !Number.isFinite(ageSeconds)) events.push({ key: `${key}:age-unavailable`, message: `IDLE HELPER age unavailable: Codex app-server pid=${item.pid}; safe-to-stop classification is degraded on this host` })
    emitted.add(key)
  }
  return events
}
