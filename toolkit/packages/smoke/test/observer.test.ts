// observer.test.ts — unit tests for the pure message readers + attachment
// verdict logic behind the observer-agent-pairing canary (src/observer.ts).
// Fake SDK-shaped messages stand in for a real query() stream (mirroring
// sdk-agent-probe.test.ts / sdk-driver.test.ts): the live probe itself
// (src/observer-canaries.ts) stays integration-verified by `pnpm canary:observer`.

import { describe, expect, it } from 'vitest'
import {
  classifyAttachment,
  emptyTally,
  flagCheckResult,
  flagEnabled,
  foldObserverSignal,
  legVerdictToCheckResult,
  MIN_OBSERVED_TOOL_CALLS,
  notMeasuredResult,
  observerReportAssertion,
  readObserverSignals,
  sendMessageRefusalAssertion,
  type RunTally,
} from '../src/observer.js'

const OBSERVED = 'observed-type'
const OBSERVER = 'observer-type'

const toolUseMsg = (over: Record<string, unknown> = {}): unknown => ({
  type: 'assistant',
  subagent_type: over['subagent_type'] ?? undefined,
  origin: over['origin'],
  message: {
    content: [{ type: 'tool_use', id: over['id'] ?? 'tu_1', name: over['name'] ?? 'Read', input: {} }],
  },
})

const toolResultMsg = (over: Record<string, unknown> = {}): unknown => ({
  type: 'user',
  subagent_type: over['subagent_type'] ?? undefined,
  origin: over['origin'],
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: over['toolUseId'] ?? 'tu_1',
        is_error: over['isError'] ?? false,
        content: over['content'] ?? 'ok',
      },
    ],
  },
})

describe('readObserverSignals', () => {
  it('extracts a tool_use with subagent_type and origin', () => {
    const [s] = readObserverSignals(toolUseMsg({ subagent_type: OBSERVER, name: 'ObserverReport', origin: { kind: 'observer' } }))
    expect(s).toBeDefined()
    expect(s?.subagentType).toBe(OBSERVER)
    expect(s?.originKind).toBe('observer')
    expect(s?.toolUse).toEqual({ id: 'tu_1', name: 'ObserverReport' })
    expect(s?.toolResult).toBeNull()
  })

  it('extracts a tool_result with subagent_type and error flag', () => {
    const [s] = readObserverSignals(toolResultMsg({ subagent_type: OBSERVER, isError: true, content: 'No such tool available' }))
    expect(s).toBeDefined()
    expect(s?.toolResult).toEqual({ toolUseId: 'tu_1', isError: true, text: 'No such tool available' })
  })

  it('normalizes an array-of-blocks tool_result content', () => {
    const [s] = readObserverSignals(toolResultMsg({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }))
    expect(s?.toolResult?.text).toBe('hello world')
  })

  it('reads a bare origin-tagged message with no tool_use/tool_result block', () => {
    const [s] = readObserverSignals({ type: 'user', subagent_type: OBSERVER, origin: { kind: 'observer-activity' }, message: { content: [] } })
    expect(s).toBeDefined()
    expect(s?.originKind).toBe('observer-activity')
    expect(s?.toolUse).toBeNull()
    expect(s?.toolResult).toBeNull()
  })

  it('returns [] for a message with neither a subagent tag nor an origin kind', () => {
    expect(readObserverSignals({ type: 'assistant', message: { content: [] } })).toEqual([])
  })

  it('returns [] for a non-assistant/user message and for malformed input', () => {
    expect(readObserverSignals({ type: 'system', subtype: 'init' })).toEqual([])
    expect(readObserverSignals(null)).toEqual([])
    expect(readObserverSignals('nope')).toEqual([])
  })

  it('extracts EVERY tool_use block in a batched message, not just the first', () => {
    const batched = {
      type: 'assistant',
      subagent_type: OBSERVED,
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu_2', name: 'Glob', input: {} },
          { type: 'tool_use', id: 'tu_3', name: 'Read', input: {} },
        ],
      },
    }
    const signals = readObserverSignals(batched)
    expect(signals).toHaveLength(3)
    expect(signals.map((x) => x.toolUse?.name)).toEqual(['Read', 'Glob', 'Read'])
  })
})

describe('foldObserverSignal', () => {
  it('counts observed-agent tool_use separately from observer traffic', () => {
    let t = emptyTally()
    t = foldObserverSignal(t, readObserverSignals(toolUseMsg({ subagent_type: OBSERVED, name: 'Read' }))[0]!, OBSERVED, OBSERVER)
    t = foldObserverSignal(t, readObserverSignals(toolUseMsg({ subagent_type: OBSERVED, name: 'Glob', id: 'tu_2' }))[0]!, OBSERVED, OBSERVER)
    expect(t.observedToolUseCount).toBe(2)
    expect(t.observerToolUses).toEqual([])
  })

  it('counts an observer-activity digest tagged to the observer type', () => {
    let t = emptyTally()
    const s = readObserverSignals({ type: 'user', subagent_type: OBSERVER, origin: { kind: 'observer-activity' }, message: { content: [] } })[0]!
    t = foldObserverSignal(t, s, OBSERVED, OBSERVER)
    expect(t.observerActivityDigests).toBe(1)
  })

  it('is immutable — does not mutate the input tally', () => {
    const t0 = emptyTally()
    const s = readObserverSignals(toolUseMsg({ subagent_type: OBSERVED, name: 'Read' }))[0]!
    const t1 = foldObserverSignal(t0, s, OBSERVED, OBSERVER)
    expect(t0.observedToolUseCount).toBe(0)
    expect(t1.observedToolUseCount).toBe(1)
  })

  it('sets observerEnvelopeSeen on any observer-kind origin, regardless of subagent tag', () => {
    let t = emptyTally()
    const s = readObserverSignals({ type: 'user', origin: { kind: 'observer', from: OBSERVER, senderTaskId: 't1' }, message: { content: [] } })[0]!
    t = foldObserverSignal(t, s, OBSERVED, OBSERVER)
    expect(t.observerEnvelopeSeen).toBe(true)
  })
})

describe('classifyAttachment', () => {
  it('reports ATTACHED when an activity digest was seen', () => {
    const t: RunTally = { ...emptyTally(), observerActivityDigests: 2 }
    const v = classifyAttachment(t, 'leg', { hard: true, pathHasWorkingBaseline: false })
    expect(v.state).toBe('ATTACHED')
    expect(v.hard).toBeUndefined()
  })

  it('reports ATTACHED when the observer made a tool_use even with zero digests', () => {
    const t: RunTally = { ...emptyTally(), observerToolUses: [{ id: 'x', name: 'ObserverReport' }] }
    expect(classifyAttachment(t, 'leg', { hard: false, pathHasWorkingBaseline: false }).state).toBe('ATTACHED')
  })

  it('reports NOT_MEASURED when the observed agent made too few tool calls', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS - 1 }
    const v = classifyAttachment(t, 'leg', { hard: true, pathHasWorkingBaseline: false })
    expect(v.state).toBe('NOT_MEASURED')
  })

  // 2026-08-03 correction: a clean negative on a launch path with NO independent
  // confirmation it can ever attach (this probe's headless SDK query() + nested
  // Agent-tool spawn) is NOT_MEASURED, not NOT_ATTACHED — see classifyAttachment's
  // own doc for why (this session's pilot-watchdog transcripts proved the
  // INTERACTIVE spawn path works; nothing proved this DIFFERENT path ever did).
  it('reports NOT_MEASURED (not NOT_ATTACHED), with the "no known baseline" reason, when the path has no working baseline', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    const v = classifyAttachment(t, 'leg', { hard: true, pathHasWorkingBaseline: false })
    expect(v.state).toBe('NOT_MEASURED')
    expect(v.hard).toBeUndefined()
    expect(v.reason).toMatch(/no independent confirmation it can attach an observer at all/)
    expect(v.reason).toMatch(/cannot currently distinguish "this path never attaches" from "attachment broke"/)
  })

  it('reports NOT_ATTACHED, carrying `hard`, when enough turns happened, nothing observer-shaped appeared, AND the path has a confirmed working baseline', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    const v = classifyAttachment(t, 'leg', { hard: true, pathHasWorkingBaseline: true })
    expect(v.state).toBe('NOT_ATTACHED')
    expect(v.hard).toBe(true)
  })

  it('does not carry `hard` when the caller passes hard=false, even with a working baseline', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    expect(classifyAttachment(t, 'leg', { hard: false, pathHasWorkingBaseline: true }).hard).toBe(false)
  })

  it('uses NOT_MEASURED for a clean negative when no persisted marker exists', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    const v = classifyAttachment(t, 'observer-positive-control', {
      hard: true,
      baselineIo: {
        resolveMarkerPath: () => '/tmp/observer-baseline.json',
        readMarkerFile: () => {
          throw new Error('missing')
        },
        writeMarkerFile: () => {
          throw new Error('should not write')
        },
      },
    })
    expect(v.state).toBe('NOT_MEASURED')
  })

  it('uses NOT_ATTACHED for a clean negative when a persisted marker exists', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    const v = classifyAttachment(t, 'observer-positive-control', {
      hard: true,
      baselineIo: {
        resolveMarkerPath: () => '/tmp/observer-baseline.json',
        readMarkerFile: () =>
          JSON.stringify({
            'observer-positive-control': { firstSeenAt: '2026-08-03T00:00:00.000Z', lastSeenAt: '2026-08-03T00:00:00.000Z' },
          }),
        writeMarkerFile: () => {
          throw new Error('should not write')
        },
      },
    })
    expect(v.state).toBe('NOT_ATTACHED')
  })

  it('writes a persisted marker when the leg is ATTACHED', () => {
    const writes: Array<{ path: string; content: string }> = []
    const t: RunTally = { ...emptyTally(), observerActivityDigests: 1 }
    const v = classifyAttachment(t, 'observer-positive-control', {
      hard: true,
      baselineIo: {
        resolveMarkerPath: () => '/tmp/observer-baseline.json',
        readMarkerFile: () => {
          throw new Error('missing')
        },
        writeMarkerFile: (path, content) => writes.push({ path, content }),
      },
    })
    expect(v.state).toBe('ATTACHED')
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe('/tmp/observer-baseline.json')
    expect(JSON.parse(writes[0]!.content)).toMatchObject({
      'observer-positive-control': {
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      },
    })
  })

  it('does not write a persisted marker when the leg is NOT_MEASURED', () => {
    const writes: Array<{ path: string; content: string }> = []
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    const v = classifyAttachment(t, 'observer-positive-control', {
      hard: true,
      baselineIo: {
        resolveMarkerPath: () => '/tmp/observer-baseline.json',
        readMarkerFile: () => {
          throw new Error('missing')
        },
        writeMarkerFile: (path, content) => writes.push({ path, content }),
      },
    })
    expect(v.state).toBe('NOT_MEASURED')
    expect(writes).toEqual([])
  })

  it('degrades a corrupt persisted marker to NOT_MEASURED without throwing', () => {
    const t: RunTally = { ...emptyTally(), observedToolUseCount: MIN_OBSERVED_TOOL_CALLS }
    expect(() =>
      classifyAttachment(t, 'observer-positive-control', {
        hard: true,
        baselineIo: {
          resolveMarkerPath: () => '/tmp/observer-baseline.json',
          readMarkerFile: () => '{not json',
          writeMarkerFile: () => {
            throw new Error('should not write')
          },
        },
      }),
    ).not.toThrow()
    expect(
      classifyAttachment(t, 'observer-positive-control', {
        hard: true,
        baselineIo: {
          resolveMarkerPath: () => '/tmp/observer-baseline.json',
          readMarkerFile: () => '{not json',
          writeMarkerFile: () => {
            throw new Error('should not write')
          },
        },
      }).state,
    ).toBe('NOT_MEASURED')
  })
})

describe('observerReportAssertion', () => {
  it('is NOT_MEASURED when ObserverReport was never called', () => {
    expect(observerReportAssertion(emptyTally()).state).toBe('NOT_MEASURED')
  })

  it('is ATTACHED when ObserverReport succeeded', () => {
    const t: RunTally = {
      ...emptyTally(),
      observerToolUses: [{ id: 'r1', name: 'ObserverReport' }],
      observerToolResults: [{ toolUseId: 'r1', isError: false, text: 'ok' }],
    }
    expect(observerReportAssertion(t).state).toBe('ATTACHED')
  })

  it('is NOT_MEASURED when ObserverReport was called but no matching tool_result arrived', () => {
    const t: RunTally = { ...emptyTally(), observerToolUses: [{ id: 'r1', name: 'ObserverReport' }] }
    const v = observerReportAssertion(t)
    expect(v.state).toBe('NOT_MEASURED')
    expect(v.reason).toMatch(/no matching tool_result was observed/)
  })

  it('is NOT_ATTACHED when ObserverReport returned an error', () => {
    const t: RunTally = {
      ...emptyTally(),
      observerToolUses: [{ id: 'r1', name: 'ObserverReport' }],
      observerToolResults: [{ toolUseId: 'r1', isError: true, text: 'boom' }],
    }
    expect(observerReportAssertion(t).state).toBe('NOT_ATTACHED')
  })
})

describe('sendMessageRefusalAssertion', () => {
  it('is NOT_MEASURED when SendMessage was never attempted', () => {
    expect(sendMessageRefusalAssertion(emptyTally()).state).toBe('NOT_MEASURED')
  })

  it('is ATTACHED (expected, correct) when refused with "No such tool available"', () => {
    const t: RunTally = {
      ...emptyTally(),
      observerToolUses: [{ id: 's1', name: 'SendMessage' }],
      observerToolResults: [{ toolUseId: 's1', isError: true, text: 'No such tool available' }],
    }
    const v = sendMessageRefusalAssertion(t)
    expect(v.state).toBe('ATTACHED')
    expect(v.hard).toBeUndefined()
  })

  it('is ATTACHED but flags unexpected wording when errored without the expected phrase', () => {
    const t: RunTally = {
      ...emptyTally(),
      observerToolUses: [{ id: 's1', name: 'SendMessage' }],
      observerToolResults: [{ toolUseId: 's1', isError: true, text: 'permission denied' }],
    }
    expect(sendMessageRefusalAssertion(t).reason).toMatch(/not with the expected wording/)
  })

  it('is NOT_ATTACHED and hard when SendMessage unexpectedly succeeds — the regression case', () => {
    const t: RunTally = {
      ...emptyTally(),
      observerToolUses: [{ id: 's1', name: 'SendMessage' }],
      observerToolResults: [{ toolUseId: 's1', isError: false, text: 'sent' }],
    }
    const v = sendMessageRefusalAssertion(t)
    expect(v.state).toBe('NOT_ATTACHED')
    expect(v.hard).toBe(true)
  })

  it('is NOT_MEASURED when SendMessage was attempted but no matching tool_result arrived', () => {
    const t: RunTally = {
      ...emptyTally(),
      observerToolUses: [{ id: 's1', name: 'SendMessage' }],
    }
    const v = sendMessageRefusalAssertion(t)
    expect(v.state).toBe('NOT_MEASURED')
    expect(v.reason).toMatch(/no matching tool_result was observed/)
  })
})

describe('legVerdictToCheckResult / notMeasuredResult', () => {
  it('maps ATTACHED/NOT_MEASURED to ok:true and NOT_ATTACHED to ok:false, keeping the state visible in detail', () => {
    expect(legVerdictToCheckResult({ name: 'a', state: 'ATTACHED', reason: 'x' })).toEqual({ name: 'a', ok: true, detail: '[ATTACHED] x' })
    expect(legVerdictToCheckResult({ name: 'b', state: 'NOT_MEASURED', reason: 'y' })).toEqual({ name: 'b', ok: true, detail: '[NOT_MEASURED] y' })
    expect(legVerdictToCheckResult({ name: 'c', state: 'NOT_ATTACHED', reason: 'z' })).toEqual({ name: 'c', ok: false, detail: '[NOT_ATTACHED] z' })
  })

  it('notMeasuredResult is always ok:true', () => {
    expect(notMeasuredResult('n', 'reason')).toEqual({ name: 'n', ok: true, detail: '[NOT_MEASURED] reason' })
  })
})

describe('flagEnabled / flagCheckResult', () => {
  it('is disabled when the var is absent, empty, or "0"', () => {
    expect(flagEnabled({})).toBe(false)
    expect(flagEnabled({ CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: '' })).toBe(false)
    expect(flagEnabled({ CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: '0' })).toBe(false)
  })

  it('is enabled for "1" or any other non-empty, non-"0" value', () => {
    expect(flagEnabled({ CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: '1' })).toBe(true)
    expect(flagEnabled({ CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: 'true' })).toBe(true)
  })

  it('flagCheckResult is always ok:true regardless of the flag state', () => {
    expect(flagCheckResult({}).ok).toBe(true)
    expect(flagCheckResult({ CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS: '1' }).ok).toBe(true)
  })
})
