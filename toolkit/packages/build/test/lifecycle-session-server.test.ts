import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'

// A phase session is a fresh SDK query: it gets its own MCP server instance over the one lifecycle state.
const DISCOVERY_RECORD = 'test discovery\n\n## External-source ledger\n- Claim: fixture claim\n  Source: fixture source\n  Fetched content: fixture evidence\n  Verdict: confirmed\n\nGrounding route: proceed\n'
const PLAN = '## ADR\nDecision: x\nRejected: y\n## Tasks\n- T1 task. DoD: green\n## Gates\n- test\n## Card terms: reading chosen\n- none: every term has one reading\n'
type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
type Server = { instance: { _registeredTools: Record<string, { handler: Handler }> }, sessionServer: (session: number) => Server, state: () => { phase: string }, ledger: () => Record<string, unknown>, timeline: () => Record<string, unknown>, acceptedTransitions: () => Array<{ from: string, next: string, result: string }> }

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function lifecycle() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-session-server-'))); roots.push(root)
  const archiveRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wt-session-archive-'))); roots.push(archiveRoot)
  writeFileSync(join(archiveRoot, '.gitignore'), '.claude/reports/\n'); spawnSync('git', ['init', '-q'], { cwd: archiveRoot })
  mkdirSync(join(root, '.lane')); writeFileSync(join(root, '.gitignore'), '.lane/\n.claude/reports/\n'); spawnSync('git', ['init', '-q'], { cwd: root })
  const server = createLifecycleServer({ worktree: root, archiveRoot, route: 'FULL', reasons: ['test'], models: { lane: 'test', review: 'test' }, cardId: '1', sessionTag: 'test', rules: [] }) as unknown as Server
  const tools = (s: Server) => s.instance._registeredTools
  const text = async (result: Promise<{ content: Array<{ text: string }> }>) => (await result).content[0]!.text
  return { server, tools, text }
}

describe('lifecycle phase sessions', () => {
  it('gives each session its own MCP instance over the same lifecycle state', async () => {
    const { server, tools, text } = lifecycle()
    const second = server.sessionServer(2)
    expect(second.instance).not.toBe(server.instance)
    expect(await text(tools(server).transition!.handler({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'd' }))).toMatch(/^accepted phase=plan/)
    expect(await text(tools(second).write_artifact!.handler({ kind: 'plan', content: PLAN }))).toBe('wrote plan')
    expect(await text(tools(second).transition!.handler({ phase: 'plan', tool_use_id: 'p' }))).toMatch(/^accepted phase=critic/)
    expect(server.state().phase).toBe('critic')
  })

  it('never takes a later session\'s self-numbered transition id for an earlier session\'s', async () => {
    const { server, tools, text } = lifecycle()
    await tools(server).transition!.handler({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'step-1' })
    const second = server.sessionServer(2)
    await tools(second).write_artifact!.handler({ kind: 'plan', content: PLAN })
    expect(await text(tools(second).transition!.handler({ phase: 'plan', tool_use_id: 'step-1' }))).toMatch(/^accepted phase=critic/)
    // Within one session a repeated id with the same shape is still the same transition, replayed.
    expect(await text(tools(second).transition!.handler({ phase: 'plan', tool_use_id: 'step-1' }))).toMatch(/^accepted phase=critic/)
    expect(server.state().phase).toBe('critic')
  })

  it('keeps refusing an empty transition id in a later session', async () => {
    const { server, tools, text } = lifecycle()
    const second = server.sessionServer(2)
    expect(await text(tools(second).transition!.handler({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: '' }))).toMatch(/tool_use_id/)
    expect(server.state().phase).toBe('discovery')
  })

  it('builds every session\'s tools from one definition', () => {
    const { server } = lifecycle()
    const shape = (s: Server) => Object.fromEntries(Object.entries(s.instance._registeredTools as Record<string, { description?: string, inputSchema?: unknown }>).map(([name, entry]) => [name, JSON.stringify({ description: entry.description, schema: entry.inputSchema })]))
    expect(shape(server.sessionServer(3))).toEqual(shape(server))
    expect(Object.keys(shape(server))).toEqual(['transition', 'write_artifact', 'route_finding', 'run'])
  })

  it('exposes the accepted transitions, the ledger and the timeline as copies', async () => {
    const { server, tools } = lifecycle()
    await tools(server).transition!.handler({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'd' })
    const accepted = server.acceptedTransitions()
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ from: 'discovery', next: 'plan' })
    expect(accepted[0]!.result).toMatch(/^accepted phase=plan/)
    const ledger = server.ledger() as { planRound: number, priorCriticRounds: unknown[], dodDisputes: unknown[] }
    expect(ledger).toMatchObject({ planRound: 0, priorCriticRounds: [], dodDisputes: [] })
    ledger.priorCriticRounds.push('mutated')
    expect((server.ledger() as { priorCriticRounds: unknown[] }).priorCriticRounds).toEqual([])
    const timeline = server.timeline() as { route: string, phases: Array<{ phase: string }> }
    expect(timeline.route).toBe('FULL')
    expect(timeline.phases.map((phase) => phase.phase)).toEqual(['discovery', 'plan'])
  })
})
