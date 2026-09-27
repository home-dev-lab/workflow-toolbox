import fs from 'node:fs'
import path from 'node:path'
import { resolveAgentDefinition } from './agent-definitions.mjs'
import { readFrontmatterFile } from './frontmatter.mjs'
import { toolList } from './agent-type-tools.mjs'

export function agentHasNoMessagingTool(agentType, cwd = '') {
  const leaf = String(agentType).split(':').pop()
  if (!leaf || leaf === '..' || leaf === '.' || leaf.includes('\0') || /[/\\]/.test(leaf)) return false
  const definition = resolveAgentDefinition(agentType, { cwd })
  // The outbound guard stops agents without a messaging channel. Uncertainty must
  // take that same conservative branch so a missing definition cannot bypass delivery.
  if (definition?.unresolved) return true
  // Templates are a consumer-specific legacy extra root, after Claude's agent scopes.
  const template = !definition && readFrontmatterFile(path.join(import.meta.dirname, '..', '..', 'agent-templates', `${leaf}.md`))
  const data = definition?.data ?? (template?.ok ? template.data : null)
  if (data) {
    const tools = toolList(data.tools)
    const denied = toolList(data.disallowedTools)
    if (tools === undefined || denied === undefined || data.tools && typeof data.tools === 'object' && !Array.isArray(data.tools) || data.disallowedTools && typeof data.disallowedTools === 'object' && !Array.isArray(data.disallowedTools)) return true
    if (Array.isArray(tools) && !tools.includes('SendMessage')) return true
    if (denied?.includes('SendMessage')) return true
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
