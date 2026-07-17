// hint.test.ts — the wt-comm v0.2 additive extension: role 'observer' + type
// 'observer.hint' (provenance REQUIRED — design S1), the extended legality matrix
// (observer produces ONLY observer.* types; agent/pilot never produce observer.*),
// the deterministic hint mint, and the unchanged read-settlement lifecycle applied
// to hints. Design source: docs/internal/custom-observers-design.md §4.1 (v2).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMessage } from '../src/validate.js'
import { writeMessage, listMessages, claimSettlement, readSettlementFor } from '../src/fs.js'
import { mintHintId } from '../src/ids.js'
import { BASE_ID_PATTERN, HINT_MESSAGE_SCHEMA, WT_COMM_SCHEMAS, type HintMessage } from '../src/schemas.js'

const AT = '2026-07-17T10:00:00Z'

function baseHint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'h-run1-docs-butler-1',
    type: 'observer.hint',
    from: { role: 'observer', id: 'docs-butler' },
    to: { role: 'agent', id: 'implementer' },
    runId: 'run1',
    at: AT,
    payload: {
      kind: 'docs',
      confidence: 'medium',
      provenance: [
        { source: 'transcript', file: '/runs/agent-implementer.jsonl', fromOffset: 0, toOffset: 1024 },
        {
          source: 'capability',
          need: 'docs-lookup',
          provider: 'context7',
          ref: 'https://docs.example.com/client/v2#createclient',
          retrievedAt: AT,
        },
      ],
      hint: 'createClient(options) replaced the v1 positional signature you are calling.',
    },
    ...overrides,
  }
}

function hintWithPayload(patch: Record<string, unknown>, drop: string[] = []): Record<string, unknown> {
  const h = baseHint()
  const payload = { ...(h['payload'] as Record<string, unknown>), ...patch }
  for (const key of drop) delete payload[key]
  return { ...h, payload }
}

describe('parseMessage — observer.hint (shape)', () => {
  it('accepts a complete valid fixture carrying BOTH provenance variants', () => {
    const r = parseMessage(JSON.stringify(baseHint()))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const m = r.message as HintMessage
      expect(m.payload.kind).toBe('docs')
      expect(m.payload.provenance).toHaveLength(2)
    }
  })

  it('accepts a hint without the optional confidence field', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({}, ['confidence'])))
    expect(r.ok).toBe(true)
  })

  it('registers observer.hint in the WT_COMM_SCHEMAS map (generic-interpreter routing)', () => {
    expect(Object.keys(WT_COMM_SCHEMAS)).toContain('observer.hint')
  })

  it('rejects confidence outside the low/medium/high enum', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({ confidence: 'certain' })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it.each(['kind', 'provenance', 'hint'])('rejects missing required payload field %s', (field) => {
    const r = parseMessage(JSON.stringify(hintWithPayload({}, [field])))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('rejects a hint under the 20-char floor', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({ hint: 'too short' })))
    expect(r.ok).toBe(false)
  })

  it('rejects a hint over the 2000-char cap', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({ hint: 'x'.repeat(2001) })))
    expect(r.ok).toBe(false)
  })

  it('inReplyTo present on a hint -> reject (forbidden outside decision.response)', () => {
    const r = parseMessage(JSON.stringify(baseHint({ inReplyTo: 'q-run1-step' })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('drops unknown payload keys from the typed result (reader posture)', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({ futureField: 'ignore-me' })))
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.message as HintMessage).payload).not.toHaveProperty('futureField')
  })
})

describe('parseMessage — observer.hint provenance (S1: required, bounded, discriminated)', () => {
  it('EMPTY provenance array -> malformed (minItems 1 — a hint without provenance does not validate)', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({ provenance: [] })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('over 8 provenance items -> malformed (bounded array)', () => {
    const item = { source: 'transcript', file: '/f.jsonl', fromOffset: 0, toOffset: 1 }
    const r = parseMessage(JSON.stringify(hintWithPayload({ provenance: Array.from({ length: 9 }, () => ({ ...item })) })))
    expect(r.ok).toBe(false)
  })

  it('unknown provenance source -> malformed', () => {
    const r = parseMessage(
      JSON.stringify(hintWithPayload({ provenance: [{ source: 'hearsay', file: '/f.jsonl', fromOffset: 0, toOffset: 1 }] })),
    )
    expect(r.ok).toBe(false)
  })

  it('transcript variant missing file -> malformed (variant fields are not mixable)', () => {
    const r = parseMessage(JSON.stringify(hintWithPayload({ provenance: [{ source: 'transcript', fromOffset: 0, toOffset: 1 }] })))
    expect(r.ok).toBe(false)
  })

  it('capability variant missing retrievedAt -> malformed', () => {
    const r = parseMessage(
      JSON.stringify(
        hintWithPayload({ provenance: [{ source: 'capability', need: 'docs-lookup', provider: 'context7', ref: 'doc-1' }] }),
      ),
    )
    expect(r.ok).toBe(false)
  })

  it('capability retrievedAt must be strict UTC Zulu', () => {
    const r = parseMessage(
      JSON.stringify(
        hintWithPayload({
          provenance: [
            { source: 'capability', need: 'docs-lookup', provider: 'context7', ref: 'doc-1', retrievedAt: '2026-07-17T10:00:00+02:00' },
          ],
        }),
      ),
    )
    expect(r.ok).toBe(false)
  })

  it('transcript window toOffset === fromOffset -> malformed (an empty window is not provenance)', () => {
    const r = parseMessage(
      JSON.stringify(hintWithPayload({ provenance: [{ source: 'transcript', file: '/f.jsonl', fromOffset: 10, toOffset: 10 }] })),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('transcript window toOffset < fromOffset -> malformed', () => {
    const r = parseMessage(
      JSON.stringify(hintWithPayload({ provenance: [{ source: 'transcript', file: '/f.jsonl', fromOffset: 10, toOffset: 3 }] })),
    )
    expect(r.ok).toBe(false)
  })

  it('negative fromOffset -> malformed', () => {
    const r = parseMessage(
      JSON.stringify(hintWithPayload({ provenance: [{ source: 'transcript', file: '/f.jsonl', fromOffset: -1, toOffset: 3 }] })),
    )
    expect(r.ok).toBe(false)
  })
})

describe('legality matrix — observer.* is observer-only, observer is observer.*-only', () => {
  it('observer may write observer.hint', () => {
    expect(parseMessage(JSON.stringify(baseHint())).ok).toBe(true)
  })

  it.each(['agent', 'pilot'])('%s may NOT write observer.hint -> provenance', (role) => {
    const r = parseMessage(JSON.stringify(baseHint({ from: { role, id: `${role}-1` } })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('provenance')
  })

  it('observer may NOT write escalation.question -> provenance', () => {
    const q = {
      schemaVersion: 1,
      id: 'q-run1-step',
      type: 'escalation.question',
      from: { role: 'observer', id: 'docs-butler' },
      to: { role: 'pilot' },
      runId: 'run1',
      at: AT,
      payload: {
        kind: 'no-test-seam',
        options: [
          { id: 'opt-a', label: 'Option A here' },
          { id: 'opt-b', label: 'Option B here' },
        ],
        defaultOptionId: 'opt-a',
        question: 'Which approach should I take for this ambiguous case, exactly?',
      },
    }
    const r = parseMessage(JSON.stringify(q))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('provenance')
  })

  it('observer may NOT write status.digest -> provenance', () => {
    const d = {
      schemaVersion: 1,
      id: 'd-run1-1',
      type: 'status.digest',
      from: { role: 'observer', id: 'docs-butler' },
      to: { role: 'pilot' },
      runId: 'run1',
      at: AT,
      payload: { seq: 1, state: 'working', summary: 'Working through the increment fine.' },
    }
    const r = parseMessage(JSON.stringify(d))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('provenance')
  })

  it('observer may NOT write decision.response (observers never decide) -> provenance or worse', () => {
    const d = {
      schemaVersion: 1,
      id: 'q-run1-step--decision',
      type: 'decision.response',
      from: { role: 'observer', id: 'docs-butler' },
      to: { role: 'agent', id: 'agent-1' },
      runId: 'run1',
      at: AT,
      inReplyTo: 'q-run1-step',
      payload: { decision: 'opt-a' },
    }
    const r = parseMessage(JSON.stringify(d))
    expect(r.ok).toBe(false)
  })

  it('a type unknown to THIS build (e.g. a future observer.summary) -> unknown-type, never accepted', () => {
    // The version-coupling behavior the README documents: a reader OLDER than a type
    // cannot act on it — it names the failure 'unknown-type' (review lock F3) and
    // listMessages skips it silently; producers and consumers of a new type must both
    // be on a package version that knows it.
    const r = parseMessage(JSON.stringify(baseHint({ type: 'observer.summary' })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unknown-type')
  })
})

describe('mintHintId — deterministic, grammar-valid, <=90 chars (single derivation site)', () => {
  it('is deterministic and embeds observer name and seq', () => {
    const a = mintHintId('wf_run-1', 'docs-butler', 3)
    const b = mintHintId('wf_run-1', 'docs-butler', 3)
    expect(a).toBe(b)
    expect(a.startsWith('h-')).toBe(true)
    expect(a).toContain('docs-butler')
    expect(a.endsWith('-3')).toBe(true)
  })

  it('two observers on the same run and seq mint DISTINCT ids', () => {
    expect(mintHintId('wf_run-1', 'docs-butler', 1)).not.toBe(mintHintId('wf_run-1', 'lint-butler', 1))
  })

  it('matches the base id grammar', () => {
    expect(BASE_ID_PATTERN.test(mintHintId('wf_run-1', 'docs-butler', 1))).toBe(true)
  })

  it('stays <=90 chars and grammar-valid under adversarial inputs', () => {
    const long = mintHintId('WF/'.repeat(80), 'a'.repeat(200), Number.MAX_SAFE_INTEGER)
    expect(long.length).toBeLessThanOrEqual(90)
    expect(BASE_ID_PATTERN.test(long)).toBe(true)
    const degenerate = mintHintId('///', '///', Number.NaN)
    expect(BASE_ID_PATTERN.test(degenerate)).toBe(true)
    expect(degenerate.endsWith('-0')).toBe(true)
  })
})

describe('hint lifecycle on disk (write, list, read-settle)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wt-comm-hint-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writtenHint(): HintMessage {
    const r = parseMessage(JSON.stringify(baseHint()))
    if (!r.ok) throw new Error('fixture must parse')
    return r.message as HintMessage
  }

  it('writeMessage writes a valid hint and refuses a provenance-less one', () => {
    const result = writeMessage(dir, writtenHint())
    expect(result.outcome).toBe('written')
    const bad = hintWithPayload({}, ['provenance']) as unknown as HintMessage
    expect(() => writeMessage(dir, { ...bad, id: 'h-run1-docs-butler-2' } as HintMessage)).toThrow()
  })

  it('listMessages filters by type observer.hint and by the observed recipient', () => {
    writeMessage(dir, writtenHint())
    const hits = listMessages(dir, { type: 'observer.hint', to: { role: 'agent', id: 'implementer' } })
    expect(hits).toHaveLength(1)
    const misses = listMessages(dir, { type: 'observer.hint', to: { role: 'agent', id: 'someone-else' } })
    expect(misses).toHaveLength(0)
  })

  it('a foreign unknown-type file in the dir never hides the hint (tolerant listing)', () => {
    writeMessage(dir, writtenHint())
    writeFileSync(join(dir, 'msg-h-run1-docs-butler-9.json'), JSON.stringify(baseHint({ id: 'h-run1-docs-butler-9', type: 'observer.summary' })), 'utf8')
    const hits = listMessages(dir, { type: 'observer.hint' })
    expect(hits).toHaveLength(1)
  })

  it("the recipient settles a hint with mode 'read'; decision/default-timeout stay question-only", () => {
    const hint = writtenHint()
    writeMessage(dir, hint)

    expect(claimSettlement(dir, hint, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'decision', outcome: 'opt-a' }).outcome).toBe(
      'invalid-claim',
    )
    expect(
      claimSettlement(dir, hint, { by: { role: 'agent', id: 'implementer' }, at: AT, mode: 'default-timeout', outcome: 'opt-a' }).outcome,
    ).toBe('invalid-claim')
    // Wrong role for 'read' (the hint's recipient is role 'agent').
    expect(claimSettlement(dir, hint, { by: { role: 'pilot', id: 'p1' }, at: AT, mode: 'read' }).outcome).toBe('invalid-claim')

    const read = claimSettlement(dir, hint, { by: { role: 'agent', id: 'implementer' }, at: AT, mode: 'read' })
    expect(read.outcome).toBe('settled')
    const back = readSettlementFor(dir, hint)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.settlement.mode).toBe('read')
  })
})

describe('schema const surface (StructuredOutput usability)', () => {
  it('HINT_MESSAGE_SCHEMA orders payload properties short-first, long prose last', () => {
    expect(Object.keys(HINT_MESSAGE_SCHEMA.properties.payload.properties)).toEqual(['kind', 'confidence', 'provenance', 'hint'])
  })
})
