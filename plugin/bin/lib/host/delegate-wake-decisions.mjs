// Immutable terminal decisions are independent of the last-writer-wins retry
// throttle. Hard-link publication commits a complete file without overwriting a
// concurrent winner. Paths derive from issued identities, not timestamps.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { defaultRegistryDir } from './delegate-wake-files.mjs'

export function decisionPaths(sessionId) {
  const dir = process.env.WT_DELEGATE_WAKE_DIR || path.join(defaultRegistryDir(), 'delegate-wake')
  return { stateFile: path.join(dir, `${sessionId}.json`), decisions: path.join(dir, `${sessionId}.decisions`) }
}

const decisionFile = (dir, key) => path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`)

export function hasDecision(dir, key) {
  let text
  try { text = fs.readFileSync(decisionFile(dir, key), 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (JSON.parse(text).key !== key) throw new Error('decision identity mismatch')
  return true
}

// Retention bound, enforced at write time. A decision older than this is deleted by the next
// claim. Safe because it exceeds the relay age ceiling: any notice an old decision covers is by
// then past that ceiling, so an orphan is claimed silently again and a stale wake is never relayed.
export const DECISION_MAX_AGE_MS = 7 * 24 * 3_600_000

function listDecisionFiles(dir) {
  try { return fs.readdirSync(dir).filter((name) => /\.(json|tmp)$/.test(name)) } catch { return [] }
}

export function pruneDecisions(dir, now = Date.now()) {
  let removed = 0
  for (const name of listDecisionFiles(dir)) {
    try {
      const file = path.join(dir, name)
      if (now - fs.statSync(file).mtimeMs <= DECISION_MAX_AGE_MS) continue
      fs.unlinkSync(file)
      removed++
    } catch { /* a concurrent pruner or writer owns this file */ }
  }
  return removed
}

export function claimDecision(dir, key, now = Date.now()) {
  let tmp
  try {
    fs.mkdirSync(dir, { recursive: true })
    pruneDecisions(dir, now)
    tmp = path.join(dir, `${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify({ key }), { flag: 'wx' })
    fs.linkSync(tmp, decisionFile(dir, key))
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally { if (tmp) { try { fs.unlinkSync(tmp) } catch { /* private debris is never read */ } } }
}

// Quote each argument for the native shell. Windows uses the node command so
// its invocation also works in PowerShell without a quoted-executable operator.
const POSIX_QUOTE_ESCAPE = "'\"'\"'"
const quoted = (value) => process.platform === 'win32' ? `"${value.replace(/"/g, '""')}"`
  : `'${value.replace(/'/g, () => POSIX_QUOTE_ESCAPE)}'`
export function acknowledgementCommand(session, target) {
  const cli = fileURLToPath(new URL('../../wt-delegate-wake-scan.mjs', import.meta.url))
  const executable = process.platform === 'win32' ? 'node' : quoted(process.execPath)
  return `${executable} ${quoted(cli)} --session ${quoted(session)} --ack ${quoted(target)}`
}

export function unsettled(lines, dir) {
  return lines.filter((entry) => !hasDecision(dir, `ack:${entry.target}`) && !hasDecision(dir, `orphan:${entry.key}`))
}

export function claimOrphan(entry, dir) {
  return entry.kind !== 'ORPHANED BY RESTART' || claimDecision(dir, `orphan:${entry.key}`)
}

// An orphan older than the relay age ceiling is settled without a line: the decision is
// recorded so it stays settled, nothing is printed. Returns the entries still to announce.
// A claim that cannot be written is reported and retried next poll; it never mutes live WAKEs.
export function settleAged(entries, dir, onError = () => {}) {
  const live = []
  for (const entry of entries) {
    if (!entry.aged) { live.push(entry); continue }
    try { claimOrphan(entry, dir) } catch (error) { onError(error) }
  }
  return live
}
