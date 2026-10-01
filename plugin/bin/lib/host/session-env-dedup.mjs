// Host access for wt-session-env-dedup-hook.mjs: every filesystem operation of the session-env
// cleanup lives here, behind the host adapter directory, so the hook itself stays free of raw host
// primitives.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOOK_FILE = /^sessionstart-hook-\d+\.sh$/
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// A line the shell cannot expand: single-quoted text, double-quoted text without $ ` \ !, or bare
// safe characters. One-character alternatives under `*` keep matching linear on adversarial lines.
const LITERAL_EXPORT = /^export [A-Za-z_][A-Za-z0-9_]*=(?:'[^'\n]*'|"[^"$`\\!\n]*"|[A-Za-z0-9_./:@%+,-])*$/
const MAX_DEDUP_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_FILES_PER_DIR = 64
const ALARM_BYTES = 65536
const STALE_TMP_MS = 60_000
const TMP_PREFIX = '.wt-session-env-dedup-'

export function readStdinJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function isRealDir(dir) {
  try {
    const st = fs.lstatSync(dir)
    return st.isDirectory() && !st.isSymbolicLink() && path.basename(path.dirname(dir)) === 'session-env'
  } catch {
    return false
  }
}

// The session-env directory must sit directly under the active Claude config directory, so a
// user-set CLAUDE_ENV_FILE that merely looks like a hook file is never rewritten.
function underConfigDir(dir, opts) {
  try {
    const configDir = opts.configDir || path.join(opts.home, '.claude')
    return fs.realpathSync(path.dirname(path.dirname(dir))) === fs.realpathSync(configDir)
  } catch {
    return false
  }
}

function targetDirs(envFile, sessionId, opts) {
  if (typeof envFile !== 'string' || envFile === '' || !HOOK_FILE.test(path.basename(envFile))) return []
  const d1 = path.dirname(path.resolve(envFile))
  if (!isRealDir(d1) || !underConfigDir(d1, opts)) return []
  const dirs = [d1]
  if (typeof sessionId === 'string' && SAFE_SEGMENT.test(sessionId) && sessionId !== '.' && sessionId !== '..') {
    const d2 = path.join(path.dirname(d1), sessionId)
    if (d2 !== d1 && isRealDir(d2)) dirs.push(d2)
  }
  return dirs
}

function hookNumber(name) {
  return Number(/\d+/.exec(name)[0])
}

function hookFiles(dir, maxFiles) {
  const files = []
  const names = fs.readdirSync(dir).filter((name) => HOOK_FILE.test(name))
  names.sort((a, b) => hookNumber(a) - hookNumber(b))
  for (const name of names.slice(0, maxFiles)) {
    const file = path.join(dir, name)
    try {
      if (fs.lstatSync(file).isFile()) files.push(file)
    } catch {
      // vanished between listing and stat
    }
  }
  return files
}

function readAll(fd, size) {
  const buf = Buffer.alloc(size)
  let got = 0
  while (got < size) {
    const n = fs.readSync(fd, buf, got, size - got, got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

// Pure core: returns the deduplicated text, or null when the file is not eligible or has no
// duplicate. Text is latin1 so arbitrary bytes round-trip untouched.
function dedupText(text) {
  if (text.includes('\r')) return null
  const lines = text.split('\n')
  for (const line of lines) {
    if (line === '' || line.startsWith('#') || LITERAL_EXPORT.test(line)) continue
    return null
  }
  const seen = new Set()
  const keep = new Array(lines.length).fill(true)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith('export ')) continue
    if (seen.has(line)) keep[i] = false
    else seen.add(line)
  }
  if (keep.every(Boolean)) return null
  return lines.filter((_, i) => keep[i]).join('\n')
}

// Rewrites `file` without duplicate literal exports. `tmp` must live OUTSIDE the directory the
// harness sources. `hooks.afterRename` runs between the rename and the final fstat of the old fd
// (a test seam for the tail carry); `hooks.budget` ({ remaining }) bounds the bytes read across
// calls. The carried tail is written through the fd of the inode this call created, never by path.
// Returns true when the file was rewritten.
export function dedupFile(file, tmp, hooks = {}) {
  let fd
  let out
  let tmpMade = false
  try {
    fd = fs.openSync(file, 'r')
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.size > MAX_DEDUP_BYTES) return false
    if (hooks.budget) {
      if (st.size > hooks.budget.remaining) {
        hooks.budget.remaining = 0
        return false
      }
      hooks.budget.remaining -= st.size
    }
    const original = readAll(fd, st.size)
    const next = dedupText(original.toString('latin1'))
    if (next === null) return false

    const mode = st.mode & 0o7777
    out = fs.openSync(tmp, 'wx', mode & 0o777)
    tmpMade = true
    const nextBuf = Buffer.from(next, 'latin1')
    fs.writeFileSync(out, nextBuf)
    try {
      fs.fchmodSync(out, mode)
    } catch {
      // mode copy is best effort (Windows, odd filesystems)
    }
    fs.renameSync(tmp, file)
    tmpMade = false
    if (typeof hooks.afterRename === 'function') hooks.afterRename()

    // A parallel hook may have appended to the old inode after we read it; carry that tail over.
    const after = fs.fstatSync(fd)
    if (after.size > original.length) {
      const tail = Buffer.alloc(after.size - original.length)
      const n = fs.readSync(fd, tail, 0, tail.length, original.length)
      if (n > 0) fs.writeSync(out, tail, 0, n, nextBuf.length)
    }
    return true
  } catch {
    return false
  } finally {
    if (out !== undefined) {
      try {
        fs.closeSync(out)
      } catch {
        // already closed
      }
    }
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
    }
    if (tmpMade) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // nothing more to do
      }
    }
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Deletes only this run's own naming scheme for this directory, by exact shape and age.
function removeStaleTemps(dir) {
  const parent = path.dirname(dir)
  const own = new RegExp(
    `^${escapeRegExp(`${TMP_PREFIX}${path.basename(dir)}`)}-sessionstart-hook-\\d+\\.sh-\\d+-[0-9a-f]{8}\\.tmp$`,
  )
  try {
    for (const name of fs.readdirSync(parent)) {
      if (!own.test(name)) continue
      const p = path.join(parent, name)
      try {
        const st = fs.lstatSync(p)
        if (st.isFile() && Date.now() - st.mtimeMs > STALE_TMP_MS) fs.rmSync(p, { force: true })
      } catch {
        // another run removed it first
      }
    }
  } catch {
    // parent unreadable: nothing to clean
  }
}

// Counts every hook file the harness sources, not only the ones the dedup cap let through.
function alarmText(dir) {
  const sized = []
  for (const file of hookFiles(dir, Number.POSITIVE_INFINITY)) {
    try {
      sized.push({ file, bytes: fs.lstatSync(file).size })
    } catch {
      // vanished
    }
  }
  const total = sized.reduce((sum, f) => sum + f.bytes, 0)
  if (total <= ALARM_BYTES) return null
  const top = sized
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((f) => `${f.file} (${f.bytes} bytes)`)
    .join(', ')
  return (
    `[wt] session-env ${dir} holds ${total} bytes in its sessionstart-hook files (alarm above ${ALARM_BYTES}). ` +
    `Largest: ${top}. Files that could not be deduplicated contain non-literal lines, exceed 8 MiB, or could not be rewritten. ` +
    'Claude Code inlines these files into every Bash command and Linux refuses a single argument over 128 KiB (E2BIG). ' +
    'The harness reads them only at a session start or switch, so once the plugin that writes them is fixed a restart is needed.'
  )
}

// Deduplicates the current session's env files and returns the alarm text (or null). `opts` is the
// test seam: configDir, home, maxTotalBytes, maxFiles (defaults: the real environment and bounds).
export function runSessionEnvDedup(envFile, sessionId, opts = {}) {
  const config = {
    configDir: opts.configDir ?? process.env.CLAUDE_CONFIG_DIR,
    home: opts.home ?? os.homedir(),
  }
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_DIR
  const budget = { remaining: opts.maxTotalBytes ?? MAX_TOTAL_BYTES }
  const alarms = []
  for (const dir of targetDirs(envFile, sessionId, config)) {
    removeStaleTemps(dir)
    const name = path.basename(dir)
    for (const file of hookFiles(dir, maxFiles)) {
      const suffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
      const tmp = path.join(path.dirname(dir), `${TMP_PREFIX}${name}-${path.basename(file)}-${suffix}.tmp`)
      dedupFile(file, tmp, { budget })
    }
    const text = alarmText(dir)
    if (text) alarms.push(text)
  }
  return alarms.length > 0 ? alarms.join(' ') : null
}
