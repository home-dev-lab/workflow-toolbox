import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plugin runtime module
import { analyseTranscript, analyseSession, createModelTracker, modelWarnings, classifyProviderRefusal } from '../../../../plugin/bin/lib/model-fallback-core.mjs'
// @ts-expect-error host module
import { expandHome } from '../../../../plugin/bin/lib/host/model-fallback-files.mjs'

const root = fileURLToPath(new URL('fixtures/model-fallback/', import.meta.url))
const cli = fileURLToPath(new URL('../../../../plugin/bin/wt-model-fallback-check.mjs', import.meta.url))
const hook = fileURLToPath(new URL('../../../../plugin/bin/wt-model-fallback-hook.mjs', import.meta.url))
const parent = join(root, 'parent.jsonl')
const agent = join(root, 'agent-test.jsonl')

describe('model fallback observations', () => {
  const from = 'claude-opus-5-5'; const to = 'claude-opus-4-8'
  const assistant = (id: string, model = to, fallback = true, timestamp = '2026-09-27T20:00:02Z') => ({ type: 'assistant', timestamp, message: { id, model, content: fallback ? [{ type: 'fallback', from: { model: from }, to: { model: to } }] : [] } })
  const structured = () => ({ type: 'system', subtype: 'model_refusal_fallback', originalModel: from, fallbackModel: to, apiRefusalCategory: 'cyber', timestamp: '2026-09-27T20:00:01Z' })
  const notice = (time: string, parentUuid?: string) => ({ type: 'system', subtype: 'informational', content: 'Safeguards stopped this response', timestamp: time, parentUuid })
  const temporary = (run: (dir: string) => void) => { const dir = mkdtempSync(join(tmpdir(), 'wt-fallback-')); try { run(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }

  it('F1 reads chunk-split CRLF and skips JSON parsing unrelated lines in target-only mode', () => temporary((dir) => {
    const file = join(dir, 'parent.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'assistant', message: { id: 'noise', model: from } })}\r\n${JSON.stringify(structured())}\r\n`)
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const result = analyseTranscript(file, { targetsOnly: true, chunkSize: 7 })
      expect(result.fallbacks).toHaveLength(1)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  }))

  it('F6 merges both record orders and replay, but not pairs separated by return to from', () => {
    const progress = Array.from({ length: 8 }, () => ({ type: 'progress' }))
    for (const [records, count] of [
      [[assistant('r1'), assistant('back', from, false), structured()], 2],
      [[structured(), assistant('r2')], 1],
      [[assistant('r1'), ...progress, structured()], 1],
      [[assistant('r1'), assistant('r1'), structured()], 1],
    ] as const) {
      const tracker = createModelTracker('opus'); records.forEach(tracker.observe)
      expect(tracker.result().fallbacks, JSON.stringify(records)).toHaveLength(count)
    }
    const sameRun = createModelTracker('opus')
    ;[assistant('first', from, false), structured(), assistant('still-from', from, false), assistant('later')].forEach(sameRun.observe)
    expect(sameRun.result().fallbacks).toHaveLength(2)
  })

  it('F7 consumes a fallback record for only its own transition', () => {
    const tracker = createModelTracker('opus')
    ;[assistant('a', from, false), structured(), assistant('b'), assistant('c', from, false), assistant('d', to, false)].forEach(tracker.observe)
    expect(modelWarnings(tracker.result()).filter((line: string) => line.includes('model changed') && !line.includes('fallback model changed') && line.includes(`${from} -> ${to}`))).toHaveLength(1)
  })

  it('F8 separates notice-only stops and merges only a recent refusal, including replay', () => {
    const tracker = createModelTracker()
    ;[notice('one'), { type: 'assistant', message: { id: 'between', model: from } }, notice('two')].forEach(tracker.observe)
    expect(tracker.result().refusals).toHaveLength(2)
    const replay = createModelTracker()
    ;[{ ...assistant('refusal', from, false), uuid: 'ref', message: { id: 'refusal', model: from, stop_reason: 'refusal' } }, { ...assistant('refusal', from, false), uuid: 'ref', message: { id: 'refusal', model: from, stop_reason: 'refusal' } }, { type: 'user' }, notice('three')].forEach(replay.observe)
    expect(replay.result().refusals).toHaveLength(1)
    const interrupted = createModelTracker()
    ;[{ ...assistant('refusal', from, false), uuid: 'ref', message: { id: 'refusal', model: from, stop_reason: 'refusal' } }, assistant('normal', from, false), notice('four', 'ref')].forEach(interrupted.observe)
    expect(interrupted.result().refusals).toHaveLength(2)
  })

  it('F8 keeps exactly one classifier stop in each evidence parent', () => {
    const evidence = join(root, '../../../../../../.lane/evidence/transcripts')
    for (const name of readdirSync(evidence)) {
      const directory = join(evidence, name, readdirSync(join(evidence, name))[0]!)
      const file = readdirSync(directory).find((entry) => entry.endsWith('.jsonl'))!
      expect(analyseTranscript(join(directory, file)).refusals, name).toHaveLength(1)
      if (name.startsWith('i-default')) expect(analyseTranscript(join(directory, file)).fallbacks, name).toHaveLength(1)
    }
  })

  it('F9 scopes parent targets to agent start time and never shares a sibling fallback', () => temporary((dir) => {
    const parentFile = join(dir, 'session.jsonl'); const agents = join(dir, 'session', 'subagents'); mkdirSync(agents, { recursive: true })
    writeFileSync(parentFile, `${JSON.stringify({ ...structured(), timestamp: '2026-09-27T20:00:10Z' })}\n`)
    writeFileSync(join(agents, 'agent-early.jsonl'), `${JSON.stringify(assistant('early', to, false, '2026-09-27T20:00:01Z'))}\n`)
    writeFileSync(join(agents, 'agent-late.jsonl'), `${JSON.stringify(assistant('late', to, false, '2026-09-27T20:00:11Z'))}\n`)
    for (const name of ['early', 'late']) writeFileSync(join(agents, `agent-${name}.meta.json`), '{"model":"opus"}')
    const session = analyseSession(parentFile)
    const warnings = session.agents.map((entry: { name: string; result: unknown }) => [entry.name, modelWarnings(entry.result, { fallbacks: session.parent.fallbacks })])
    expect(warnings.find(([name]: [string]) => name === 'agent-early')?.[1]).toEqual([])
    expect(warnings.find(([name]: [string]) => name === 'agent-late')?.[1]).toHaveLength(1)
  }))

  it('F9 never shares sibling fallbacks with other agents or the parent', () => temporary((dir) => {
    const parentFile = join(dir, 'session.jsonl'); const agents = join(dir, 'session', 'subagents'); mkdirSync(agents, { recursive: true })
    writeFileSync(parentFile, `${JSON.stringify(assistant('parent', to, false))}\n`)
    writeFileSync(join(agents, 'agent-first.jsonl'), `${JSON.stringify(structured())}\n`)
    writeFileSync(join(agents, 'agent-second.jsonl'), `${JSON.stringify(assistant('second', to, false))}\n`)
    writeFileSync(join(agents, 'agent-second.meta.json'), '{"model":"opus"}')
    const session = analyseSession(parentFile)
    expect(session.fallbacks).toEqual([])
    expect(modelWarnings(session.agents.find((entry: { name: string }) => entry.name === 'agent-second')!.result, { fallbacks: session.fallbacks })).toEqual([])
    expect(modelWarnings(session.parent, { fallbacks: session.fallbacks })).toEqual([])
  }))

  it('F10 ignores interleaved child assistant messages', () => {
    const tracker = createModelTracker('opus')
    ;[assistant('caller', from, false), { ...assistant('child', 'claude-haiku-4-5', false), parent_tool_use_id: 'tool' }, assistant('caller2', from, false)].forEach(tracker.observe)
    expect(modelWarnings(tracker.result())).toEqual([])
  })

  it('F4/F5 normalizes alias suffix and inherit and describes an unverified fallback cause', () => {
    const tracker = createModelTracker('opus[1m]'); tracker.observe(assistant('served', from, false))
    expect(modelWarnings(tracker.result())).toEqual([])
    const inherited = createModelTracker('inherit'); inherited.observe(assistant('served', to, false))
    expect(modelWarnings(inherited.result(), { fallbacks: [{ from, to, time: '2026-09-27T20:00:01Z' }] }).join(' ')).toContain('no model requested; served')
    expect(modelWarnings(inherited.result(), { fallbacks: [{ from, to, time: '2026-09-27T20:00:01Z' }] }).join(' ')).not.toContain('requested inherit')
    const absent = createModelTracker(); absent.observe(assistant('absent', to, false))
    expect(modelWarnings(absent.result(), { fallbacks: [{ from, to, time: '2026-09-27T20:00:01Z' }] }).join(' ')).toContain('verify it was not pinned deliberately')
  })

  it('F12 expands Windows-style home prefix', () => {
    expect(expandHome('~\\example')).not.toBe('~\\example')
  })

  it('F14 verifies clean parent hook reads and normalized PostToolUse receipt', () => temporary((dir) => {
    const cleanParent = join(dir, 'clean.jsonl'); writeFileSync(cleanParent, `${JSON.stringify(assistant('clean', from, false))}\n`)
    const stopped = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_transcript_path: agent, transcript_path: cleanParent }), encoding: 'utf8' })
    expect(stopped.stdout).toBe('')
    const post = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent', transcript_path: cleanParent, tool_input: { model: 'opus[1m]' }, tool_response: { resolvedModel: `${from}[1m]` } }), encoding: 'utf8' })
    expect(post.stdout).toBe('')
  }))

  it('F4 normalizes PostToolUse served suffix before fallback target comparison', () => {
    const post = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent', transcript_path: parent, tool_input: { model: 'opus[1m]' }, tool_response: { resolvedModel: `${to}[1m]` } }), encoding: 'utf8' })
    expect(post.stdout).toContain('session fallback target')
  })
  it('merges the classifier stop and both fallback representations', () => {
    const result = analyseTranscript(parent, { requested: 'opus' })
    expect(result.refusals).toHaveLength(1)
    expect(result.fallbacks).toHaveLength(1)
    expect(result.fallbacks[0]).toMatchObject({ from: 'claude-opus-5-5', to: 'claude-opus-4-8', category: 'cyber' })
    expect(result.runs.map((run: { model: string }) => run.model)).toEqual(['claude-opus-5-5', 'claude-opus-4-8'])
  })

  it('warns on inherited session fallback targets despite a matching alias, but not a different-family fallback', () => {
    const result = analyseTranscript(agent, { requested: 'opus' })
    expect(modelWarnings(result, { name: 'agent', fallbacks: analyseTranscript(parent).fallbacks }).join('\n')).toContain('session fallback target')
    expect(modelWarnings(result, { name: 'agent', fallbacks: [{ from: 'claude-fable-1', to: 'claude-opus-4-8' }] })).toEqual([])
    const opus = createModelTracker('opus')
    opus.observe({ type: 'assistant', timestamp: '2026-09-27T20:00:00Z', message: { id: 'one', model: 'claude-opus-5-5' } })
    expect(modelWarnings(opus.result(), { name: 'agent', fallbacks: [{ from: 'claude-fable-1', to: 'claude-opus-5-5' }] })).toEqual([])
  })

  it('notices a classifier stop even without an assistant model', () => {
    const result = analyseTranscript(join(root, 'notice.jsonl'))
    expect(result.unknown).toBe(false)
    expect(modelWarnings(result, { name: 'session' }).join('\n')).toContain('classifier notice')
  })

  it('ignores synthetic and non-message models and deduplicates message ids', () => {
    const tracker = createModelTracker('opus')
    for (const record of [
      { type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5' } },
      { type: 'assistant', message: { id: 's', model: '<synthetic>' } },
      { type: 'attachment', model: 'claude-opus-4-8' },
      { type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5' } },
      { type: 'assistant', message: { id: 'b', model: 'claude-opus-5-5' } },
    ]) tracker.observe(record)
    expect(tracker.result().runs).toMatchObject([{ model: 'claude-opus-5-5', calls: 2 }])
    expect(modelWarnings(tracker.result(), { name: 'session' })).toEqual([])
  })

  it('compares the first assistant model with the SDK init receipt without counting init as a call', () => {
    const tracker = createModelTracker('opus')
    tracker.observe({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    tracker.observe({ type: 'assistant', message: { model: 'claude-opus-4-8', id: 'first' }, timestamp: '2026-09-27T20:00:00Z' })
    expect(tracker.result().runs).toMatchObject([{ model: 'claude-opus-4-8', calls: 1 }])
    expect(modelWarnings(tracker.result(), { name: 'sdk' }).join('\n')).toContain('model changed claude-opus-5-5 -> claude-opus-4-8')
  })

  it('honours remaps, version suffixes and provider prefixes', () => {
    const result = analyseTranscript(parent, { requested: 'opus' })
    const clean = createModelTracker('opus', { ANTHROPIC_DEFAULT_OPUS_MODEL: 'proxy/claude-opus-4-8[1m]' })
    clean.observe({ type: 'assistant', message: { model: 'proxy/claude-opus-4-8', id: 'clean' } })
    expect(modelWarnings(clean.result(), { name: 'agent', fallbacks: result.fallbacks })).toEqual([])
  })

  it('classifies only anchored Codex cyber errors', () => {
    const evidence = readFileSync(join(root, 'codex-refusal.txt'), 'utf8')
    expect(classifyProviderRefusal(evidence)).toEqual({ provider: 'openai', category: 'cyber' })
    expect(classifyProviderRefusal('ordinary error: flagged for possible cybersecurity risk')).toBeNull()
  })

  it('CLI distinguishes warnings, unknown and clean; hook is fail-open and informs both callers', () => {
    expect(spawnSync(process.execPath, [cli, '--transcript', parent], { encoding: 'utf8' }).status).toBe(1)
    const unknown = spawnSync(process.execPath, [cli, '--transcript', join(root, 'missing.jsonl')], { encoding: 'utf8' })
    expect(unknown.status).toBe(3)
    expect(unknown.stdout).toContain('unknown=1')
    const clean = spawnSync(process.execPath, [cli, '--transcript', agent, '--requested', 'opus'], { encoding: 'utf8' })
    expect(clean.status).toBe(0)
    const stopped = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'agent', agent_transcript_path: agent, transcript_path: parent }), encoding: 'utf8' })
    expect(stopped.status).toBe(0)
    expect(JSON.parse(stopped.stdout).systemMessage).toContain('session fallback target')
    const post = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Agent', transcript_path: parent, tool_input: { model: 'opus' }, tool_response: { resolvedModel: 'claude-opus-4-8' } }), encoding: 'utf8' })
    expect(JSON.parse(post.stdout).hookSpecificOutput.additionalContext).toContain('session fallback target')
    expect(spawnSync(process.execPath, [hook], { input: '{', encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '' })
  })
})
