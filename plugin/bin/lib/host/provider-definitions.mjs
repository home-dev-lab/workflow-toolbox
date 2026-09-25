import { readFileSync } from 'node:fs'

export function installedOpenCodeProviderDefinitions(env = process.env) {
  const roots = [env.XDG_CACHE_HOME, env.HOME && `${env.HOME}/.cache`, env.LOCALAPPDATA].filter(Boolean)
  for (const root of roots) {
    try {
      const definitions = JSON.parse(readFileSync(`${root}/opencode/models.json`, 'utf8'))
      if (definitions && typeof definitions === 'object') return definitions
    } catch {}
  }
  return null
}
