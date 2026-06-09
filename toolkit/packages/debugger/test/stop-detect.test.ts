import { describe, it, expect } from 'vitest'
import { parseStopPayload, planStopActions, type WorkflowTask } from '../src/stop-detect.js'

const stopInput = (bg: unknown, extra: Record<string, unknown> = {}): unknown => ({
  session_id: 's1',
  cwd: '/p',
  hook_event_name: 'Stop',
  stop_hook_active: false,
  background_tasks: bg,
  ...extra,
})

describe('parseStopPayload', () => {
  it('extracts workflow-type tasks and the core fields', () => {
    const p = parseStopPayload(
      stopInput([
        { id: 'a', type: 'workflow', status: 'running', name: 'wf-a' },
        { id: 't', type: 'teammate', status: 'running', name: 'nope' },
      ]),
    )
    expect(p.sessionId).toBe('s1')
    expect(p.cwd).toBe('/p')
    expect(p.stopHookActive).toBe(false)
    expect(p.workflows).toEqual([{ id: 'a', status: 'running', name: 'wf-a' }])
  })

  it('tolerates absent / null / non-array background_tasks → []', () => {
    expect(parseStopPayload(stopInput(undefined)).workflows).toEqual([])
    expect(parseStopPayload(stopInput(null)).workflows).toEqual([])
    expect(parseStopPayload(stopInput('x')).workflows).toEqual([])
    expect(parseStopPayload({}).workflows).toEqual([])
    expect(parseStopPayload(null).workflows).toEqual([])
  })

  it('drops workflow entries without a string id', () => {
    const p = parseStopPayload(stopInput([{ type: 'workflow', status: 'running' }, { id: 5, type: 'workflow' }]))
    expect(p.workflows).toEqual([])
  })

  it('reads stop_hook_active only as strict boolean true; missing session_id → null', () => {
    expect(parseStopPayload(stopInput([], { stop_hook_active: true })).stopHookActive).toBe(true)
    expect(parseStopPayload(stopInput([], { stop_hook_active: 'true' })).stopHookActive).toBe(false)
    expect(parseStopPayload({ background_tasks: [] }).sessionId).toBe(null)
  })
})

describe('planStopActions', () => {
  const t = (id: string, status: string): WorkflowTask => ({ id, status, name: id })

  it('keeps running tasks pending and resolves a disappeared one', () => {
    const r = planStopActions(['a', 'b'], [t('a', 'running')])
    expect(r.running).toEqual(['a'])
    expect(r.toResolve).toEqual(['b'])
  })

  it('resolves a terminal-status task first seen in-band (launched+finished in one turn)', () => {
    const r = planStopActions([], [t('c', 'completed')])
    expect(r.running).toEqual([])
    expect(r.toResolve).toEqual(['c'])
  })

  it('treats an unknown status as still-running (not resolved prematurely)', () => {
    const r = planStopActions([], [t('d', 'weird')])
    expect(r.running).toEqual(['d'])
    expect(r.toResolve).toEqual([])
  })

  it('dedups ids across prevPending and terminal tasks', () => {
    const r = planStopActions(['a'], [t('a', 'failed'), t('a', 'failed')])
    expect(r.toResolve).toEqual(['a'])
    expect(r.running).toEqual([])
  })
})
