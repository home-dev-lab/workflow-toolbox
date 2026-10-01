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

const defaultReaddir = (d) => fs.readdirSync(d, { withFileTypes: true })

// The transcript itself lives inside `subagents/workflows/<run>/`: the run directory is its parent.
export function workflowRunDirFromTranscriptPath(transcriptPath) {
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
  return null
}

function sessionWorkflowRuns(transcriptPath, readdir) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null
  const workflowsDir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', 'workflows')
  let entries
  try {
    entries = readdir(workflowsDir)
  } catch {
    return null
  }
  return { workflowsDir, runs: entries.filter((e) => e.isDirectory()).map((e) => e.name) }
}

function runDirHoldingAgent(workflowsDir, runs, agentId, readdir) {
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

// The agent's OWN transcript `agent-<agent_id>.jsonl` sits in one of the session's run
// directories. Membership is proved by that file, never by the session having exactly one run.
export function workflowRunDirHoldingAgent(transcriptPath, agentId, readdir = defaultReaddir) {
  const found = sessionWorkflowRuns(transcriptPath, readdir)
  return found ? runDirHoldingAgent(found.workflowsDir, found.runs, agentId, readdir) : null
}

export function workflowRunDirForTranscript(transcriptPath, readdir = defaultReaddir, agentId = null) {
  const direct = workflowRunDirFromTranscriptPath(transcriptPath)
  if (direct !== null) return direct
  const found = sessionWorkflowRuns(transcriptPath, readdir)
  if (!found) return null
  const { workflowsDir, runs } = found
  if (runs.length === 1) return path.join(workflowsDir, runs[0])
  // Several runs — the ordinary state of a long session. Membership is decided by the agent's
  // own transcript file inside a run directory, never by picking "the" run: with N runs there
  // is no single one, and "exactly one" silently fails every session past its first launch
  // (measured 2026-09-03: the provenance checkers of a verification run were nudged, sent their
  // verdict to the main session, and the pattern fail-closed the claim).
  return runDirHoldingAgent(workflowsDir, runs, agentId, readdir)
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

// A Workflow-tool subagent, proved by evidence that cannot describe an Agent-tool sub-agent: the
// harness label, a transcript inside a run directory, or the agent's own transcript file in one.
// Deliberately WITHOUT the "the session has exactly one run" shortcut of workflowRunDirForTranscript,
// which would also claim an Agent-tool sub-agent spawned in that session.
export function isWorkflowSubagentPayload(payload, readdir = defaultReaddir) {
  if (isHarnessWorkflowSubagentType(payload?.agent_type)) return true
  if (workflowRunDirFromTranscriptPath(payload?.transcript_path) !== null) return true
  const agentId = typeof payload?.agent_id === 'string' ? payload.agent_id : null
  return workflowRunDirHoldingAgent(payload?.transcript_path, agentId, readdir) !== null
}
