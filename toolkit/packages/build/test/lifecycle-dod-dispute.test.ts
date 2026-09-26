import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { cardDefinitionOfDone } from '../../../../plugin/bin/lib/card-definition-of-done.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createDodEscalation, planReadingOfTerm } from '../../../../plugin/bin/lib/lifecycle-dod-dispute.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { writeRegularFile } from '../../../../plugin/bin/lib/lifecycle-launch.mjs'

const card = '## Definition of done\n- Return exactly this body:\n  ```json\n  {"ok": true}\n  ```\n'
type Dispute = { resolution: { source: string, reading: string } | null }

function fixture(overrides: Record<string, unknown> = {}) {
  const state = { pendingStop: null as string | null, phase: 'plan', dodDisputes: [] as Dispute[], priorCriticRounds: [1, 2].map((round) => ({ round, findingDetails: [{ anchor: 'DoD 1', blocks: true, text: 'body missing' }] })) }
  const writes: string[] = []
  const options = { readDecisions: () => [], waitMs: 10, pollMs: 1, newRequestId: () => 'r', ...overrides }
  let clock = 0
  const escalation = createDodEscalation({ state, dodBullets: cardDefinitionOfDone(card, { raw: true }), requestPath: 'request.md', planReading: () => null, writeRequest: (_path: string, text: string) => { writes.push(text) }, now: () => clock += 20 }, options)
  return { escalation, state, writes }
}

describe('DoD dispute publication', () => {
  it('replaces a dangling symlink rather than writing through it', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-request-link-'))
    const outside = join(root, 'outside')
    const request = join(root, 'request')
    symlinkSync(outside, request)
    writeRegularFile(request, 'request text')
    expect(readFileSync(request, 'utf8')).toBe('request text')
    expect(() => readFileSync(outside, 'utf8')).toThrow()
  })
  it('replaces a lane-created directory at the request path', () => {
    const request = join(mkdtempSync(join(tmpdir(), 'wt-request-dir-')), 'request')
    mkdirSync(request)
    writeRegularFile(request, 'published')
    expect(readFileSync(request, 'utf8')).toBe('published')
  })
  it('binds a fenced JSON criterion byte-for-byte on timeout', async () => {
    const { escalation, state } = fixture()
    escalation.escalate()
    await escalation.awaitDecisions()
    expect(state.dodDisputes[0]!.resolution).toMatchObject({ source: 'fallback', reading: 'Return exactly this body:\n  ```json\n  {"ok": true}\n  ```' })
  })
  it('ignores a decision timestamped after the deadline and logs it as late', async () => {
    const logs: string[] = []
    const { escalation, state } = fixture({ readDecisions: () => [{ requestId: 'r', criterion: 1, reading: 'wrong', decidedAt: new Date(31).toISOString() }], log: (line: string) => logs.push(line) })
    escalation.escalate() // clock 20, deadline 30
    await escalation.awaitDecisions() // clock 40
    expect(state.dodDisputes[0]!.resolution).toMatchObject({ source: 'fallback' })
    expect(logs.join('\n')).toContain('late: DoD 1')
  })
  it('continues the timeout when both the store reader and fallback recorder fail', async () => {
    const logs: string[] = []
    const { escalation, state } = fixture({ readDecisions: () => { throw new Error('ENOENT') }, onBound: () => { throw new Error('ENOENT') }, log: (line: string) => logs.push(line) })
    escalation.escalate()
    await escalation.awaitDecisions()
    expect(logs.join('\n')).toContain('decision store read error: ENOENT')
    expect(state.dodDisputes[0]!.resolution).toMatchObject({ source: 'fallback' })
  })
  it('records a stop as stopped rather than parent silent', async () => {
    const { escalation, state, writes } = fixture()
    escalation.escalate()
    state.pendingStop = 'timeout'
    await escalation.awaitDecisions()
    expect(state.dodDisputes[0]!.resolution).toMatchObject({ source: 'stopped' })
    expect(writes.at(-1)).toContain('Status: stopped; binding')
  })

  it('refuses substring labels while accepting whole-word prefixes', () => {
    const acceptanceReading = () => null
    expect(planReadingOfTerm({ plan: '## Card terms: reading chosen\n- none: skip', term: 'announce none of these', criterion: 1, acceptanceReading }).reading).toBeNull()
    expect(planReadingOfTerm({ plan: '## Card terms: reading chosen\n- announce: include', term: 'announce none of these', criterion: 1, acceptanceReading }).reading).toBe('include')
  })

  it('retries registration after a failed publication and never commits half a dispute', () => {
    let fail = true
    const { escalation, state, writes } = fixture({ onDecisionRequest: () => { if (fail) throw new Error('registration failed') } })
    expect(() => escalation.escalate()).toThrow('registration failed')
    expect(state.dodDisputes).toEqual([])
    expect(writes.at(-1)).not.toContain('## DoD 1')
    fail = false
    escalation.escalate()
    expect(state.dodDisputes).toHaveLength(1)
  })

  it('does not register a request until the request file has been published', () => {
    const state = { pendingStop: null, phase: 'plan', dodDisputes: [] as Dispute[], priorCriticRounds: [1, 2].map((round) => ({ round, findingDetails: [{ anchor: 'DoD 1', blocks: true, text: 'body missing' }] })) }
    let writes = 0; let registrations = 0
    const escalation = createDodEscalation({ state, dodBullets: ['literal'], requestPath: 'request.md', planReading: () => null, writeRequest: () => { if (++writes === 1) throw new Error('file unavailable') }, now: () => 20 }, { onDecisionRequest: () => { registrations += 1 }, newRequestId: () => 'r' })
    expect(() => escalation.escalate()).toThrow('file unavailable')
    expect(registrations).toBe(0)
    expect(state.dodDisputes).toEqual([])
    escalation.escalate()
    expect(registrations).toBe(1)
  })

  it('does not commit a resolution when publishing its status fails; retries successfully', async () => {
    let writes = 0
    const state = { pendingStop: null, phase: 'plan', dodDisputes: [] as Dispute[], priorCriticRounds: [1, 2].map((round) => ({ round, findingDetails: [{ anchor: 'DoD 1', blocks: true, text: 'body missing' }] })) }
    const escalation = createDodEscalation({ state, dodBullets: ['literal'], requestPath: 'request.md', planReading: () => null, writeRequest: () => { if (++writes === 2) throw new Error('publication failed') }, now: () => 20 }, { readDecisions: () => [], waitMs: 0, newRequestId: () => 'r' })
    escalation.escalate()
    await expect(escalation.awaitDecisions()).rejects.toThrow('publication failed')
    expect(state.dodDisputes[0]!.resolution).toBeNull()
    await escalation.awaitDecisions()
    expect(state.dodDisputes[0]!.resolution).toMatchObject({ source: 'fallback' })
  })
})
