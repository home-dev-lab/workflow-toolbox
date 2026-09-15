import { existsSync, realpathSync, statSync } from 'node:fs'
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

// The index is one line per fiche or hub: reading it without the fiches it points to gives a
// session titles, not knowledge. Read is therefore allowed on the index itself and on any regular
// Markdown file under the index's own directory (fiches, hubs, archive/), resolved through real
// paths so a symlink cannot lead outside it. Stated limit: an explicit index placed in a broad
// directory opens that directory's Markdown files too.
export function knowledgeBaseReadAllowed(indexPath, requested) {
  if (!indexPath || typeof requested !== 'string') return false
  try {
    const target = realpathSync(path.resolve(requested))
    const index = realpathSync(indexPath)
    if (target === index) return true
    const root = path.dirname(index)
    const relative = path.relative(root, target)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && target.endsWith('.md') && statSync(target).isFile()
  } catch {
    return false
  }
}
