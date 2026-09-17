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

export function consumeMainGuardAllowOnce(command) {
  const file = path.join(mainGuardStateDir(), 'allow-once.json')
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!entry || entry.command !== command) return null
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) return null
    fs.unlinkSync(file)
    return entry.reason.trim()
  } catch {
    return null
  }
}
