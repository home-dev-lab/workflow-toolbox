import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  dirs.push(path.join(configDir, 'agents'))
  dirs.push(path.join(import.meta.dirname, '..', '..', 'agents'))
  dirs.push(path.join(import.meta.dirname, '..', '..', 'agent-templates'))
  return dirs
}

function findDefinition(type, cwd) {
  const bare = String(type || '').split(':').pop()
  if (!bare) return null
  for (const dir of definitionDirs(cwd)) {
    const file = path.join(dir, `${bare}.md`)
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    } catch {
      /* unreadable dir or file */
    }
  }
  return null
}

function frontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  return match ? match[1] : null
}

function parseToolList(value) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === '*') return null
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

function declaredTools(source) {
  const fm = frontmatter(source)
  if (!fm) return null
  const line = /^tools:\s*(.+)$/m.exec(fm)
  return line ? parseToolList(line[1]) : null
}

function disallowedTools(source) {
  const fm = frontmatter(source)
  if (!fm) return []
  const line = /^disallowedTools:\s*(.+)$/m.exec(fm)
  return line ? (parseToolList(line[1]) ?? []) : []
}

export function agentHasNoMessagingTool(agentType, cwd = '') {
  const source = findDefinition(agentType, cwd)
  if (source !== null) {
    const tools = declaredTools(source)
    if (Array.isArray(tools) && !tools.includes('SendMessage')) return true
    if (disallowedTools(source).includes('SendMessage')) return true
  }
  return String(agentType || '').split(':').pop() === 'opencode-envelope'
}

export function workflowRunDirForTranscript(transcriptPath, readdir = (d) => fs.readdirSync(d, { withFileTypes: true })) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null

  const transcriptDir = path.dirname(transcriptPath)
  const transcriptBase = path.basename(transcriptPath)
  if (
    (transcriptBase === 'journal.jsonl' || /^agent-[^.]+\.jsonl$/.test(transcriptBase)) &&
    path.basename(transcriptDir) !== 'subagents' &&
    path.basename(path.dirname(transcriptDir)) === 'workflows' &&
    path.basename(path.dirname(path.dirname(transcriptDir))) === 'subagents'
  ) {
    return transcriptDir
  }

  const sessionDir = transcriptPath.replace(/\.jsonl$/, '')
  const workflowsDir = path.join(sessionDir, 'subagents', 'workflows')
  let entries
  try {
    entries = readdir(workflowsDir)
  } catch {
    return null
  }
  const runs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  if (runs.length !== 1) return null
  return path.join(workflowsDir, runs[0])
}

export function finalTextIsDeliveredByHarness(payload) {
  return workflowRunDirForTranscript(payload?.transcript_path) !== null
}
