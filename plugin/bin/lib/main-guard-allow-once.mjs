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

export function consumeMainGuardAllowOnce(command, toolUseId) {
  const file = path.join(mainGuardStateDir(), 'allow-once.json')
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
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
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
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
