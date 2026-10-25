import { readdirSync, readFileSync } from 'node:fs'

export const DEFAULT_WATCH_WARN_PCT = 25
export const WATCH_SAMPLE_INTERVAL_MS = 5000
const readText = (file) => readFileSync(file, 'utf8')

export function readTsserverWatchCount(pid, { platform = process.platform, read = readText, list = readdirSync } = {}) {
  if (platform !== 'linux') return { status: 'skipped', reason: 'non-linux' }
  try {
    const max = Number(read('/proc/sys/fs/inotify/max_user_watches').trim())
    if (!Number.isSafeInteger(max) || max <= 0) return { status: 'unavailable' }
    const counts = list(`/proc/${pid}/fdinfo`).map((fd) => (read(`/proc/${pid}/fdinfo/${fd}`).match(/^inotify\b/gm) ?? []).length)
    return { status: 'measured', watches: counts.reduce((sum, count) => sum + count, 0), max }
  } catch { return { status: 'unavailable' } }
}

export function watchWarningThreshold(value) {
  const number = value === undefined || value.trim() === '' ? NaN : Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : DEFAULT_WATCH_WARN_PCT
}

export function createWatchWarning(stderr, { threshold = watchWarningThreshold(process.env.WT_TSLS_WATCH_WARN_PCT), ...reader } = {}) {
  let warned = false
  return (pid) => {
    const sample = readTsserverWatchCount(pid, reader)
    if (sample.status !== 'measured' || warned) return sample
    const percent = sample.watches / sample.max * 100
    if (percent > threshold) {
      warned = true
      try { stderr.write(`wt-tsls: warning: tsserver holds ${sample.watches} inotify watches (${percent.toFixed(1)}% of max_user_watches ${sample.max})\n`) } catch { /* Observational only. */ }
    }
    return sample
  }
}

export function monitorTsserverWatches(child, stderr, { platform = process.platform, read = readText, list = readdirSync } = {}) {
  if (platform !== 'linux') return { status: 'skipped', reason: 'non-linux' }
  const warn = createWatchWarning(stderr, { platform, read, list })
  const check = () => {
    try {
      const children = read(`/proc/${child.pid}/task/${child.pid}/children`).trim().split(/\s+/).filter(Boolean)
      for (const pid of children) {
        const args = read(`/proc/${pid}/cmdline`).split('\0')
        if (args.some((arg) => /(?:^|[/\\])_?tsserver\.js$/.test(arg))) warn(pid)
      }
    } catch { /* Children may exit between proc reads. Never affect the protocol. */ }
  }
  const timer = setInterval(check, WATCH_SAMPLE_INTERVAL_MS)
  timer.unref()
  child.once('close', () => clearInterval(timer))
  return { status: 'monitoring' }
}
