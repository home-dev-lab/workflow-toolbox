// Exclusive, atomically published owner files. Dead owners are reclaimed by liveness/start
// identity, never by age. A populated-directory reclaim mutex prevents stale readers from
// unlinking a newer claim; its token-named member makes concurrent reaping safe as well.
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { hostAdapter } from './adapter.mjs'

const SELF_START_IDENTITY = `self:${performance.timeOrigin}`

function birthIdentity(pid) {
  const exact = hostAdapter.readProcessIdentity(pid)
  if (exact.status === 'known') return exact.startIdentity
  // Do not compare a Linux boot/tick identity with a fallback timestamp after a
  // transient procfs miss: different evidence formats cannot prove PID reuse.
  if (hostAdapter.platform === 'linux') return null
  const row = hostAdapter.readProcessSnapshot().processes?.find((item) => item.pid === pid)
  return Number.isFinite(row?.startIdentity) && row.startIdentity >= 0 ? row.startIdentity : null
}

function comparableBirth(identity) {
  return identity != null && !(typeof identity === 'string' && identity.startsWith('self:'))
}

function deadOwner(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.token !== 'string') return false
  const execution = hostAdapter.readProcessExecutionState(owner.pid)
  const live = execution.status === 'unknown' ? hostAdapter.readProcessLiveness(owner.pid) : execution
  if (live.status === 'gone') return true
  if (live.status !== 'alive' || !comparableBirth(owner.startIdentity)) return false
  const actual = birthIdentity(owner.pid)
  return actual !== null && actual !== owner.startIdentity
}

function readOwner(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function removeOwnFile(file, owner) {
  if (readOwner(file)?.token !== owner.token) return
  try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function reapGuard(directory) {
  let names
  try { names = readdirSync(directory) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (names.length === 1 && deadOwner(readOwner(join(directory, names[0])))) {
    try { unlinkSync(join(directory, names[0])) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  // Publication always renames a NONEMPTY directory. Only a reaper can leave it empty;
  // rmdir cannot remove a newer, populated incarnation, even after a concurrent reap.
  try { rmdirSync(directory) } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

function takeGuard(file, owner) {
  const guard = `${file}.reclaim`
  reapGuard(guard)
  const stage = mkdtempSync(`${guard}.stage-`)
  try {
    writeFileSync(join(stage, owner.token), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    try { renameSync(stage, guard) } catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) return null
      throw error
    }
    return () => {
      removeOwnFile(join(guard, owner.token), owner)
      try { rmdirSync(guard) } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
      }
    }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

function reclaim(file, owner) {
  const release = takeGuard(file, owner)
  if (!release) return
  try {
    const current = readOwner(file)
    if (deadOwner(current)) removeOwnFile(file, current)
  } finally { release() }
}

function guardExists(file) {
  try { readdirSync(`${file}.reclaim`); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function tryClaim(file, stage, owner) {
  if (guardExists(file)) { reapGuard(`${file}.reclaim`); return false }
  try { linkSync(stage, file) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (deadOwner(readOwner(file))) reclaim(file, owner)
    return false
  }
  // A reclaimer which arrived just before publication must finish before we count.
  try {
    if (!guardExists(file)) return true
    removeOwnFile(file, owner)
    return false
  } catch (error) { removeOwnFile(file, owner); throw error }
}

// No age-based reclaim, and no advice to unlink a potentially live owner's claim.
function holderText(file) {
  const pid = readOwner(file)?.pid
  return Number.isSafeInteger(pid) ? `owner pid ${pid}` : 'no readable owner pid'
}

function busyMessage(file) {
  const guard = guardExists(file) ? `; reclaim guard ${file}.reclaim is present` : ''
  return `wt-lane: admission lock busy or owner unmeasured: ${file} (${holderText(file)}); wait for the owning launch to finish, then retry the same wt-lane command; dead owners are recovered automatically${guard}`
}

// Waiting has no default deadline, so a long wait names its holder once instead of going silent.
function waitNotice(file, start, { noticeMs = 30_000 }, warn) {
  const due = start + noticeMs
  let told = false
  return (now) => {
    if (told || now < due) return
    told = true
    warn(`wt-lane: still waiting for admission lock ${file} (${holderText(file)}); this launch keeps its place in the queue; a dead owner is recovered automatically and a live one is never broken`)
  }
}

// Runs after the claim was published or the wait failed: a leftover staging link is reported,
// never thrown, so it can neither take a published claim from its caller nor mask the wait's
// own error. The link holds no claim; only the lock file itself does.
function removeStage(stage, warn) {
  let unused = `${stage}.held`
  // Retire the queue ticket atomically before unlinking. An unlink failure must not leave
  // a completed acquisition at the head of the queue while its process remains alive.
  try { renameSync(stage, unused) } catch (error) {
    if (error.code === 'ENOENT') return
    unused = stage
    warn(`wt-lane: could not retire admission staging link ${stage} (${error.code ?? error.message})`)
  }
  try { rmSync(unused, { force: true }) } catch (error) {
    warn(`wt-lane: could not remove admission staging link ${unused} (${error.code ?? error.message}); it holds no claim and may be removed by hand`)
  }
}

const warnToStderr = (line) => process.stderr.write(`${line}\n`)

function queuedClaims(file) {
  const prefix = `${basename(file)}.`
  const entries = []
  for (const name of readdirSync(dirname(file))) {
    if (!name.startsWith(prefix) || !/\.claim(?:\.held)?$/.test(name)) continue
    const path = join(dirname(file), name)
    const owner = readOwner(path)
    if (deadOwner(owner)) { removeOwnFile(path, owner); continue }
    if (name.endsWith('.claim') && Number.isSafeInteger(owner?.ticket)) entries.push(owner)
  }
  return entries.sort((a, b) => a.ticket - b.ticket || a.token.localeCompare(b.token))
}

function watchWaitingStage(stage, warn) {
  const cleanup = () => removeStage(stage, warn)
  const signals = [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]
  const handlers = signals.map(([signal, code]) => [signal, () => process.exit(code)])
  process.once('exit', cleanup)
  for (const [signal, handler] of handlers) process.once(signal, handler)
  return () => {
    process.removeListener('exit', cleanup)
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}

function tryQueuedClaim(file, stage, owner) {
  return queuedClaims(file)[0]?.token === owner.token && tryClaim(file, stage, owner)
}

// Visible predecessors are ordered by ticket, not polling luck. Waiting has no default
// deadline: a burst of healthy bounded launches is not evidence of a saturated lane cap.
export async function acquireLaneAdmissionLock(file, { clock = performance.now.bind(performance), waitMs = Infinity, pollMs = 25, warn = warnToStderr, ...notices } = {}) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Own runtime start is available without an external process reader. A live self-only
  // identity is never judged reused from a later native identity in a different format.
  const ticket = Math.max(0, ...queuedClaims(file).map((owner) => owner.ticket)) + 1
  const owner = { pid: process.pid, startIdentity: birthIdentity(process.pid) ?? SELF_START_IDENTITY, token: randomUUID(), ticket }
  const stage = `${file}.${owner.token}.claim`
  writeFileSync(stage, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
  const detach = watchWaitingStage(stage, warn)
  const start = clock()
  const deadline = start + waitMs
  const notice = waitNotice(file, start, notices, warn)
  try {
    for (;;) {
      if (tryQueuedClaim(file, stage, owner)) return { file, owner }
      const now = clock()
      if (now >= deadline) throw new Error(busyMessage(file))
      notice(now)
      await delay(pollMs)
    }
  } finally { detach(); removeStage(stage, warn) }
}

export function releaseLaneLaunchAdmission(claim) {
  if (claim) removeOwnFile(claim.file, claim.owner)
}
