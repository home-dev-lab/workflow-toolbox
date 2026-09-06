import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function definitionDirs(cwd) {
  const dirs = []
  if (cwd) {
    let current = path.resolve(cwd)
    for (;;) {
      dirs.push(path.join(current, '.claude', 'agents'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  dirs.push(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'agents'))
  // The plugin's own agents (`workflow-toolbox:leaf-readonly` and friends): the running plugin root
  // when the harness exports it, else this file's own plugin tree — a dev checkout resolves itself.
  if (process.env.CLAUDE_PLUGIN_ROOT) dirs.push(path.join(process.env.CLAUDE_PLUGIN_ROOT, 'agents'))
  dirs.push(path.join(HERE, '..', '..', 'agents'))
  return dirs
}

function findDefinition(type, cwd) {
  const bare = type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : type
  for (const dir of definitionDirs(cwd)) {
    try {
      const file = path.join(dir, `${bare}.md`)
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    } catch {
      // An unreadable candidate must not turn a guard into a spawn failure.
    }
  }
  return null
}

function declaredTools(source) {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const line = frontmatter?.[1].match(/^tools:\s*(.+)$/m)
  if (!line) return null
  const value = line[1].trim()
  if (!value) return null
  return value.replace(/^\[|\]$/g, '').split(',').map((tool) => tool.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

/** Resolve only a definition whose frontmatter the harness itself honors. `tools: null` inherits. */
export function resolveAgentTypeTools(type, cwd) {
  const source = findDefinition(type, cwd)
  return source === null ? { resolved: false, tools: null } : { resolved: true, tools: declaredTools(source) }
}
