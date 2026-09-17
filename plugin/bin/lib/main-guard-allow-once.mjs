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
    replaceAllowance(file, {
      command: entry.command,
      reason: entry.reason,
      consumedBy: toolUseId,
      consumedAt: new Date().toISOString(),
    })
    return entry.reason.trim()
  } catch {
    return null
  }
}
