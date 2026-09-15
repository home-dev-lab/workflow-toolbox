import fs from 'node:fs'
import path from 'node:path'

export function canonicalPluginPath(value) {
  let canonical
  try { canonical = fs.realpathSync(String(value)) } catch { canonical = path.resolve(String(value)) }
  const root = path.parse(canonical).root
  while (canonical.length > root.length && canonical.endsWith(path.sep)) canonical = canonical.slice(0, -path.sep.length)
  return canonical
}

export function absentPluginPaths(configured, receipt) {
  const received = new Set(receipt.filter((plugin) => typeof plugin?.path === 'string').map((plugin) => canonicalPluginPath(plugin.path)))
  return configured.filter((pluginPath) => !received.has(canonicalPluginPath(pluginPath)))
}
