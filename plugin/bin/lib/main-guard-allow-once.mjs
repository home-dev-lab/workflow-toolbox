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

// The refusal prints this literal as the reason to fill in; copying the printed JSON verbatim must not authorize.
const REASON_PLACEHOLDER = '<why>'

function usableReason(reason) {
  if (typeof reason !== 'string') return null
  const trimmed = reason.trim()
  return trimmed && trimmed !== REASON_PLACEHOLDER ? trimmed : null
}

// Another allowance's command is never echoed: the state dir is shared across sessions and projects, and a
// command can carry a credential. Only its shape relative to this call is described.
function describeCommandMismatch(file, written, command) {
  const lead = `The allow-once file ${file} is present but names a different command`
  if (typeof written !== 'string') return `${lead} (its "command" is not a string).`
  let shape
  if (written.endsWith(command)) shape = 'it carries an extra prefix this call does not (for example a `cd … &&`)'
  else if (command.endsWith(written)) shape = 'this call carries an extra prefix it does not (for example a `cd … &&`)'
  else {
    let index = 0
    while (index < written.length && index < command.length && written[index] === command[index]) index += 1
    shape = `the two first differ at character ${index + 1}`
  }
  return `${lead}: ${shape}; ${written.length} characters there, ${command.length} in this call. The match is byte-exact.`
}

function describeEntryMiss(file, entry, command, toolUseId) {
  if (!entry || typeof entry !== 'object') return `The allow-once file ${file} does not hold a JSON object, so it was ignored.`
  if (entry.command !== command) return describeCommandMismatch(file, entry.command, command)
  if (typeof entry.reason === 'string' && entry.reason.trim() === REASON_PLACEHOLDER) {
    return `The allow-once file ${file} names this command but its "reason" is still the placeholder ${JSON.stringify(REASON_PLACEHOLDER)}; replace it with why.`
  }
  if (!usableReason(entry.reason)) return `The allow-once file ${file} names this command but its "reason" is empty.`
  if (typeof toolUseId !== 'string' || !toolUseId) return 'This call carries no tool_use_id, so no allowance can be recorded against it.'
  if (entry.consumedBy && entry.consumedBy !== toolUseId) {
    const when = entry.consumedAt ? ` at ${JSON.stringify(entry.consumedAt)}` : ''
    return `The allow-once entry for this command was already spent by tool call ${JSON.stringify(entry.consumedBy)}${when} and is not reusable; write a fresh one.`
  }
  return `The allow-once entry for this command is valid but this call did not claim it (another call may have been claiming it at the same moment); retry if it is still present.`
}

// A refusal must be satisfiable in the step it refuses: when an allowance file is present but did not
// authorize this call, say WHY. Read-only, and evaluated BEFORE consuming (which removes a spent entry), so
// its words only describe what it read, never what consume will do. It is TOTAL: any throw here would reach
// the hook's fail-open wrapper and turn a refusal into an allow, so every failure yields a neutral sentence.
// Returns '' when no allowance file exists — the refusal's own instruction is then the whole answer.
export function describeMainGuardAllowOnceMiss(command, toolUseId) {
  try {
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
    return describeEntryMiss(file, entry, command, toolUseId)
  } catch {
    return 'The allow-once file is present but could not be described; write it again as instructed above.'
  }
}

export function consumeMainGuardAllowOnce(command, toolUseId) {
  const file = path.join(mainGuardStateDir(), 'allow-once.json')
  try {
    const entry = JSON.parse(readAllowanceText(file))
    if (!entry || entry.command !== command) return null
    if (!usableReason(entry.reason)) return null
    if (typeof toolUseId !== 'string' || !toolUseId) return null
    if (entry.consumedBy) {
      if (entry.consumedBy === toolUseId) return usableReason(entry.reason)
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
      if (!current || current.command !== command || !usableReason(current.reason)) return null
      if (current.consumedBy) {
        if (current.consumedBy === toolUseId) return usableReason(current.reason)
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
    return usableReason(entry.reason)
  } catch {
    return null
  }
}
