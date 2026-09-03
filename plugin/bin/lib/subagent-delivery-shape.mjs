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

export function workflowRunDirForTranscript(transcriptPath, readdir = (d) => fs.readdirSync(d, { withFileTypes: true }), agentId = null) {
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
  if (runs.length === 1) return path.join(workflowsDir, runs[0])
  // Several runs — the ordinary state of a long session. Membership is decided by the agent's
  // own transcript file inside a run directory, never by picking "the" run: with N runs there
  // is no single one, and "exactly one" silently fails every session past its first launch
  // (measured 2026-09-03: the provenance checkers of a verification run were nudged, sent their
  // verdict to the main session, and the pattern fail-closed the claim).
  if (typeof agentId !== 'string' || agentId.length === 0) return null
  const wanted = `agent-${agentId}.jsonl`
  for (const run of runs) {
    let inner
    try {
      inner = readdir(path.join(workflowsDir, run))
    } catch {
      continue
    }
    if (inner.some((e) => e.name === wanted)) return path.join(workflowsDir, run)
  }
  return null
}

// The harness labels a subagent spawned by the Workflow tool `workflow-subagent` (seen as the
// hook payload's agent_type, possibly suffixed `@<session>`). Its final text is the run's result
// channel, so it never needs a SendMessage.
export function isHarnessWorkflowSubagentType(agentType) {
  if (typeof agentType !== 'string') return false
  const bare = agentType.split('@')[0]
  return bare === 'workflow-subagent'
}

export function finalTextIsDeliveredByHarness(payload) {
  if (isHarnessWorkflowSubagentType(payload?.agent_type)) return true
  const agentId = typeof payload?.agent_id === 'string' ? payload.agent_id : null
  return workflowRunDirForTranscript(payload?.transcript_path, undefined, agentId) !== null
}
