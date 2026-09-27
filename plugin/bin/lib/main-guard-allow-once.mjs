import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pluginName, resolvePluginDataDir } from './plugin-data-dir.mjs'

export function mainGuardStateDir() {
  return resolvePluginDataDir({
    fallback: path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'wt-main-guard'),
    pluginName: pluginName(),
  }).dir
}

function readAllowanceText(file) {
  return fs.readFileSync(file, 'utf8')
}

function replaceAllowance(file, entry) {
  const temporary = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(entry)}\n`, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function testPauseAfterRead() {
  if (process.env.NODE_ENV !== 'test') return
  const milliseconds = Number(process.env.WT_MAIN_GUARD_TEST_AFTER_READ_MS)
  if (Number.isFinite(milliseconds) && milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

// A claim directory left behind by a crashed hook would otherwise refuse every later call for ever, silently:
// one older than ten seconds belongs to no live claimant (a claim is held for milliseconds) and is removed.
const STALE_CLAIM_MS = 10_000

function waitForClaim(file) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > STALE_CLAIM_MS) fs.rmSync(file, { recursive: true, force: true })
  } catch { /* already gone */ }
  const deadline = Date.now() + 1_000
  while (fs.existsSync(file) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  return !fs.existsSync(file)
}

// A refusal must be satisfiable in the step it refuses: when an allowance file is present but does not
// apply to this call, say WHY (read-only; call it BEFORE consuming, which removes a spent entry).
// Returns '' when no allowance file exists — the refusal's own instruction is then the whole answer.
export function describeMainGuardAllowOnceMiss(command, toolUseId) {
  const file = path.join(mainGuardStateDir(), 'allow-once.json')
  let raw
  try {
    raw = readAllowanceText(file)
  } catch {
    return ''
  }
  let entry
  try {
    entry = JSON.parse(raw)
  } catch {
    return `The allow-once file ${file} is present but is not valid JSON, so it was ignored.`
  }
  if (!entry || typeof entry !== 'object') return `The allow-once file ${file} does not hold a JSON object, so it was ignored.`
  if (entry.command !== command) {
    return `The allow-once file ${file} is present but names a different command: ${JSON.stringify(entry.command)} ` +
      `— this call runs ${JSON.stringify(command)}. The match is byte-exact (a dropped \`cd … &&\` prefix or a changed pipe is a different command).`
  }
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) return `The allow-once file ${file} names this command but its "reason" is empty.`
  if (typeof toolUseId !== 'string' || !toolUseId) return 'This call carries no tool_use_id, so no allowance can be recorded against it.'
  if (entry.consumedBy && entry.consumedBy !== toolUseId) {
    const when = entry.consumedAt ? ' at ' + entry.consumedAt : ''
    return `The allow-once entry for this command was already spent by tool call ${entry.consumedBy}${when}; it is now removed — write a fresh one.`
  }
  return ''
}

export function consumeMainGuardAllowOnce(command, toolUseId) {
  const file = path.join(mainGuardStateDir(), 'allow-once.json')
  try {
    const entry = JSON.parse(readAllowanceText(file))
    if (!entry || entry.command !== command) return null
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) return null
    if (typeof toolUseId !== 'string' || !toolUseId) return null
    if (entry.consumedBy) {
      if (entry.consumedBy === toolUseId) return entry.reason.trim()
      fs.unlinkSync(file)
      return null
    }
    testPauseAfterRead()
    const claim = `${file}.claim`
    try {
      fs.mkdirSync(claim)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (!waitForClaim(claim)) return null
      return consumeMainGuardAllowOnce(command, toolUseId)
    }
    try {
      const current = JSON.parse(readAllowanceText(file))
      if (!current || current.command !== command || typeof current.reason !== 'string' || !current.reason.trim()) return null
      if (current.consumedBy) {
        if (current.consumedBy === toolUseId) return current.reason.trim()
        fs.unlinkSync(file)
        return null
      }
      replaceAllowance(file, {
        command: current.command,
        reason: current.reason,
        consumedBy: toolUseId,
        consumedAt: new Date().toISOString(),
      })
    } finally {
      fs.rmSync(claim, { recursive: true, force: true })
    }
    return entry.reason.trim()
  } catch {
    return null
  }
}
