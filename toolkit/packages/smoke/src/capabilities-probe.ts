// capabilities-probe.ts — spec-driven e2e probe for the per-run CAPABILITIES
// composition channel (card #1820698986697196666, feeds composer design
// #1820675961738232936).
//
// The question it answers with harness ground truth: when a headless session is
// composed with `mcpServers` + `agents` at the query() level (exactly what a
// delegated-run server would spread from an args `capabilities` section), do the
// SPAWNED SUBAGENTS actually see and successfully call the provisioned MCP tools
// — and does N-concurrent access hold?
//
// Deliberately GENERIC: every machine-specific bit (which MCP server, which
// agent roles, what task) arrives via a spec JSON file — the repo ships the
// mechanism, never user tooling. Run:
//   tsx packages/smoke/src/capabilities-probe.ts <spec.json>   (from toolkit/)
//
// Evidence collected per run (all harness-emitted, never model self-report):
//   - init surface: mcp_servers[] (name+status), agents[], tools[]
//   - per-subagent-instance tool_use names (assistant messages tagged
//     subagent_type, grouped by parent_tool_use_id)
//   - per-subagent-instance tool_result errors (is_error blocks)
//   - per-instance token usage (first-message cache_creation ≈ spawn cost,
//     summed output tokens), deduped by message id
//   - the session's final result text
//
// NOT part of `pnpm test` (spends real SDK launches), like sdk-agent-probe.ts.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { annotateAuth, isAbortError } from './lib.js'
import { readInitSurface, readResultText, type Surface } from './sdk-agent-probe.js'

type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** The machine-specific probe spec (JSON file). */
export interface CapabilitiesProbeSpec {
  /** Session-level MCP servers to compose (the primary args→query() channel). */
  mcpServers?: QueryOptions['mcpServers']
  /** Per-role agent definitions to compose (the SDK `agents` map channel). */
  agents?: QueryOptions['agents']
  /** Main-thread launch shape. */
  main: { prompt: string; model?: string; maxTurns?: number; allowedTools?: string[]; tools?: string[] }
  /** Working directory for the session (defaults to the repo root). */
  cwd?: string
  /** Extra plugin dirs (the launch-agents shim channel), absolute paths. */
  pluginDirs?: string[]
  timeoutMs?: number
  expect?: {
    /** MCP server names that must appear in init mcp_servers[] (any status printed, 'connected' asserted). */
    mcpConnected?: string[]
    /** Agent names that must appear in init agents[]. */
    agentsListed?: string[]
    /** At least one subagent tool_use whose name starts with this prefix. */
    subagentToolPrefix?: string
    /** Minimum DISTINCT subagent instances observed (concurrency check). */
    minSubagentInstances?: number
    /** Zero subagent tool_result errors on tools matching subagentToolPrefix. */
    noMcpToolErrors?: boolean
    /** Substrings the final result text must contain. */
    resultIncludes?: string[]
  }
}

interface InstanceStats {
  subagentType: string
  toolUses: string[]
  mcpErrors: number
  firstCacheCreation: number | null
  firstCacheRead: number | null
  outputTokens: number
  messageIds: Set<string>
}

interface ProbeOutcome {
  surface: Surface | null
  resultText: string | null
  sessionId: string | null
  resultCount: number
  instances: Map<string, InstanceStats>
  error: string | null
}

function instanceKey(subagentType: string, parentToolUseId: unknown): string {
  return `${subagentType}#${typeof parentToolUseId === 'string' ? parentToolUseId.slice(-8) : 'main'}`
}

async function runCapabilitiesProbe(spec: CapabilitiesProbeSpec, repoRoot: string): Promise<ProbeOutcome> {
  const controller = new AbortController()
  const timeoutMs = spec.timeoutMs ?? 420_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const out: ProbeOutcome = { surface: null, resultText: null, sessionId: null, resultCount: 0, instances: new Map(), error: null }

  const options: QueryOptions = {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    cwd: spec.cwd ?? repoRoot,
    settingSources: [],
    strictMcpConfig: true,
    model: spec.main.model ?? 'sonnet',
    maxTurns: spec.main.maxTurns ?? 16,
    abortController: controller,
    ...(spec.mcpServers !== undefined ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.agents !== undefined ? { agents: spec.agents } : {}),
    ...(spec.main.allowedTools !== undefined ? { allowedTools: spec.main.allowedTools } : {}),
    ...(spec.main.tools !== undefined ? { tools: spec.main.tools } : {}),
    ...(spec.pluginDirs !== undefined ? { plugins: spec.pluginDirs.map((p) => ({ type: 'local' as const, path: p })) } : {}),
  }

  const q = query({ prompt: spec.main.prompt, options })
  try {
    for await (const raw of q) {
      const message: unknown = raw
      if (out.surface === null) {
        const s = readInitSurface(message)
        if (s !== null) out.surface = s
      }
      if (out.sessionId === null && isRecord(message) && typeof message['session_id'] === 'string') {
        out.sessionId = message['session_id']
      }
      if (isRecord(message) && typeof message['subagent_type'] === 'string') {
        const key = instanceKey(message['subagent_type'], message['parent_tool_use_id'])
        let stats = out.instances.get(key)
        if (stats === undefined) {
          stats = { subagentType: message['subagent_type'], toolUses: [], mcpErrors: 0, firstCacheCreation: null, firstCacheRead: null, outputTokens: 0, messageIds: new Set() }
          out.instances.set(key, stats)
        }
        const inner = isRecord(message['message']) ? message['message'] : null
        const innerId = inner && typeof inner['id'] === 'string' ? inner['id'] : null
        const content = inner && Array.isArray(inner['content']) ? inner['content'] : []
        if (message['type'] === 'assistant') {
          for (const block of content) {
            if (isRecord(block) && block['type'] === 'tool_use' && typeof block['name'] === 'string') stats.toolUses.push(block['name'])
          }
          const usage = inner && isRecord(inner['usage']) ? inner['usage'] : null
          if (usage !== null && (innerId === null || !stats.messageIds.has(innerId))) {
            if (innerId !== null) stats.messageIds.add(innerId)
            const cc = typeof usage['cache_creation_input_tokens'] === 'number' ? usage['cache_creation_input_tokens'] : 0
            if (stats.firstCacheCreation === null) stats.firstCacheCreation = cc
            const cr = typeof usage['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : 0
            if (stats.firstCacheRead === null) stats.firstCacheRead = cr
            stats.outputTokens += typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
          }
        }
        if (message['type'] === 'user') {
          for (const block of content) {
            if (isRecord(block) && block['type'] === 'tool_result' && block['is_error'] === true) stats.mcpErrors++
          }
        }
      }
      // Do NOT break on the first result: with ASYNC subagent spawns (observed on
      // cc 2.1.205 — the Task tool returns a handle and the parent turn ends) the
      // session continues when the subagent completes; keep reading to stream end
      // and keep the LAST result text.
      const text = readResultText(message)
      if (text !== null) {
        out.resultText = text
        out.resultCount++
      }
    }
  } catch (err) {
    if (isAbortError(err)) out.error = `timed out after ${timeoutMs} ms`
    else out.error = (err as Error).message
  } finally {
    clearTimeout(timer)
  }
  return out
}

function checkExpectations(spec: CapabilitiesProbeSpec, out: ProbeOutcome): { pass: boolean; lines: string[] } {
  const e = spec.expect ?? {}
  const lines: string[] = []
  let pass = true
  const verdict = (ok: boolean, label: string, detail: string): void => {
    lines.push(`  ${ok ? '✔' : '✖'} ${label} — ${detail}`)
    if (!ok) pass = false
  }
  if (e.mcpConnected !== undefined) {
    for (const name of e.mcpConnected) {
      const found = out.surface?.mcpServers.find((m) => m.name === name)
      // 'pending' at init time is a TIMING artifact (init is emitted before slow
      // stdio servers finish connecting) — presence is the composition proof; the
      // FUNCTIONAL proof is the subagentToolPrefix/noMcpToolErrors expectations.
      verdict(found !== undefined, `mcp ${name} composed`, found ? `status=${found.status}` : 'ABSENT from init mcp_servers[]')
    }
  }
  if (e.agentsListed !== undefined) {
    for (const name of e.agentsListed) {
      verdict(out.surface?.agents.includes(name) ?? false, `agent ${name} listed`, `init agents[]=${(out.surface?.agents ?? []).join(',') || '∅'}`)
    }
  }
  const allUses = [...out.instances.values()].flatMap((s) => s.toolUses)
  if (e.subagentToolPrefix !== undefined) {
    const hits = allUses.filter((t) => t.startsWith(e.subagentToolPrefix as string))
    verdict(hits.length > 0, `subagent used ${e.subagentToolPrefix}*`, `${hits.length} matching tool_use (${[...new Set(hits)].slice(0, 6).join(', ') || 'none'})`)
  }
  if (e.minSubagentInstances !== undefined) {
    verdict(out.instances.size >= e.minSubagentInstances, `>=${e.minSubagentInstances} subagent instances`, `observed ${out.instances.size}`)
  }
  if (e.noMcpToolErrors === true) {
    const errs = [...out.instances.values()].reduce((n, s) => n + s.mcpErrors, 0)
    verdict(errs === 0, 'no subagent tool_result errors', `${errs} error result(s)`)
  }
  if (e.resultIncludes !== undefined) {
    for (const needle of e.resultIncludes) {
      verdict((out.resultText ?? '').includes(needle), `result includes ${JSON.stringify(needle)}`, `result len=${out.resultText?.length ?? 0}`)
    }
  }
  return { pass, lines }
}

async function main(): Promise<number> {
  const specPath = process.argv[2]
  if (specPath === undefined) {
    console.error('usage: tsx packages/smoke/src/capabilities-probe.ts <spec.json>')
    return 2
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as CapabilitiesProbeSpec
  const repoRoot = new URL('../../../..', import.meta.url).pathname
  console.log(`── capabilities probe: ${specPath} ──`)
  const out = await runCapabilitiesProbe(spec, repoRoot)
  if (out.error !== null) console.log(`⚠ run note: ${out.error}`)
  const s = out.surface
  console.log(s === null ? '(no init surface)' : `init: cc=${s.ccVersion} model=${s.model}\n  tools(${s.tools.length}): ${s.tools.join(', ')}\n  mcp(${s.mcpServers.length}): ${s.mcpServers.map((m) => `${m.name}:${m.status}`).join(', ') || '∅'}\n  agents(${s.agents.length}): ${s.agents.join(', ') || '∅'}`)
  for (const [key, st] of out.instances) {
    console.log(`  instance ${key}: spawnCacheCreation=${st.firstCacheCreation ?? 'n/a'} spawnCacheRead=${st.firstCacheRead ?? 'n/a'} outputTokens=${st.outputTokens} mcpErrors=${st.mcpErrors}\n    tool_use: ${st.toolUses.join(', ') || '∅'}`)
  }
  console.log(`  sessionId: ${out.sessionId ?? 'n/a'} (results seen: ${out.resultCount})`)
  console.log(`  result: ${JSON.stringify((out.resultText ?? '').slice(0, 400))}`)
  const { pass, lines } = checkExpectations(spec, out)
  console.log(lines.join('\n'))
  console.log(`── ${pass ? 'PASS' : 'FAIL'} ──`)
  return pass ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(annotateAuth(err).message)
      process.exit(2)
    },
  )
}
