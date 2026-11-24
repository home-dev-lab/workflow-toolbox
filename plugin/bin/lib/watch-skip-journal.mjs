import { join } from 'node:path'
import { pluginName, resolvePluginDataDir } from './plugin-data-dir.mjs'
import { homeDirectory } from './host/home-directory.mjs'
import { appendSkippedWake } from './host/watch-skip-journal.mjs'

export function skipJournalPath({ env = process.env, sessionId, watcher } = {}) {
  const dir = env.WT_WATCH_SKIP_JOURNAL_DIR || join(resolvePluginDataDir({
    env, fallback: join(homeDirectory(), '.local', 'state', 'wt-watch-skips'), pluginName: pluginName(),
  }).dir, 'watch-skips')
  const name = typeof sessionId === 'string' ? sessionId.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) : ''
  return join(dir, `${name || 'no-session'}.${watcher}.jsonl`)
}

export function recordSkippedWake(options = {}) {
  try {
    const { watcher, reason, line, path, nowMs = Date.now(), extra } = options
    const plain = extra && (Object.getPrototypeOf(extra) === Object.prototype || Object.getPrototypeOf(extra) === null)
    const record = { ...(plain ? extra : {}), at: new Date(nowMs).toISOString(), watcher, reason, line }
    const encoded = `${JSON.stringify(record)}\n`
    appendSkippedWake(path, encoded)
    return true
  } catch {
    return false
  }
}
