import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function resolveKnowledgeBaseIndex({ promptValue = null, env = process.env, projectRoot, exists = existsSync }) {
  const explicit = typeof promptValue === 'string' && promptValue.trim() ? promptValue.trim() : null
  const environment = typeof env.WT_KNOWLEDGE_BASE_INDEX === 'string' && env.WT_KNOWLEDGE_BASE_INDEX.trim()
    ? env.WT_KNOWLEDGE_BASE_INDEX.trim()
    : null
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
  const slug = path.resolve(projectRoot).replace(/[^A-Za-z0-9-]/g, '-')
  const source = explicit ? 'prompt' : environment ? 'environment' : 'derived'
  const value = explicit ?? environment ?? path.join(configDir, 'projects', slug, 'memory', 'MEMORY.md')
  const checkedPath = path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value)
  return { path: exists(checkedPath) ? checkedPath : null, checkedPath, source }
}

export function knowledgeBasePromptLine(resolution) {
  return resolution.path
    ? `KNOWLEDGE_BASE_INDEX: ${resolution.path}`
    : `KNOWLEDGE_BASE_INDEX: none (no index exists at ${resolution.checkedPath})`
}
