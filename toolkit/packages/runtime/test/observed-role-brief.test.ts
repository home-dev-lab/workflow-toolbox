import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildObservedRoleSection,
  extractObservedSelectors,
  labelRole,
  matchedRoleId,
  matchesSelector,
  observedBriefFor,
} from '../src/observed-role-brief.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

describe('labelRole', () => {
  it('matches the observe server canonical role-label cases', () => {
    expect(labelRole('fanOutAndSynthesize:synthesize')).toEqual(['fanOutAndSynthesize', 'synthesize'])
    expect(labelRole('generateAndFilter:generate:3')).toEqual(['generateAndFilter', 'generate'])
    expect(labelRole('score:0')).toEqual(['score'])
    expect(labelRole('implementer')).toEqual(['implementer'])
  })

  it('strips only terminal salt suffixes', () => {
    expect(labelRole('score #3')).toEqual(['score'])
    expect(labelRole('score #stage-a.b')).toEqual(['score'])
    expect(labelRole('fix #42 done')).toEqual(['fix #42 done'])
  })
})

describe('matchesSelector', () => {
  it('matches roles-only selectors against role candidates', () => {
    expect(matchesSelector({ label: 'generateAndFilter:generate:3' }, { roles: ['generate'] })).toBe(true)
    expect(matchesSelector({ label: 'generateAndFilter:generate:3' }, { roles: ['review'] })).toBe(false)
  })

  it('matches phases-only selectors by exact title equality', () => {
    expect(matchesSelector({ phase: 'Rank' }, { phases: ['Rank'] })).toBe(true)
    expect(matchesSelector({ phase: 'rank' }, { phases: ['Rank'] })).toBe(false)
  })

  it('requires both role and phase clauses when both are present', () => {
    expect(matchesSelector({ label: 'score:0', phase: 'Rank' }, { roles: ['score'], phases: ['Rank'] })).toBe(true)
    expect(matchesSelector({ label: 'score:0', phase: 'Rank' }, { roles: ['score'], phases: ['Generate'] })).toBe(false)
    expect(matchesSelector({ label: 'score:0', phase: 'Rank' }, { roles: ['judge'], phases: ['Rank'] })).toBe(false)
  })

  it('treats empty arrays as absent clauses', () => {
    expect(matchesSelector({ label: 'score:0' }, { roles: [] })).toBe(true)
    expect(matchesSelector({ phase: 'Rank' }, { roles: [], phases: ['Rank'] })).toBe(true)
    expect(matchesSelector({}, { roles: [], phases: [] })).toBe(true)
  })

  it('fails a present role clause when label is undefined', () => {
    expect(matchesSelector({ phase: 'Rank' }, { roles: ['score'] })).toBe(false)
  })
})

describe('matchedRoleId', () => {
  it('returns the first watched role in selector order that appears in the label candidates', () => {
    expect(matchedRoleId({ label: 'pipeline:implementer:0' }, { roles: ['reviewer', 'implementer', 'pipeline'] })).toBe('implementer')
  })

  it('returns the first label candidate for a phase-only selector', () => {
    expect(matchedRoleId({ label: 'fanOutAndSynthesize:synthesize' }, { phases: ['Synthesize'] })).toBe('fanOutAndSynthesize')
  })

  it('returns undefined when there is no label or no matching role', () => {
    expect(matchedRoleId({}, { roles: ['implementer'] })).toBeUndefined()
    expect(matchedRoleId({ label: 'score:0' }, { roles: ['judge'] })).toBeUndefined()
  })
})

describe('extractObservedSelectors', () => {
  const inlineWtCommObserver = {
    definition: {
      watch: {
        roles: ['implementer', 7, 'reviewer'],
        phases: ['Build', null, 'Review'],
      },
      actions: ['summary', 'wt-comm'],
      emits: ['observer.hint'],
    },
  }

  it('returns an empty list for malformed top-level inputs', () => {
    expect(extractObservedSelectors(null)).toEqual([])
    expect(extractObservedSelectors('nope')).toEqual([])
    expect(extractObservedSelectors({ observers: 'nope' })).toEqual([])
  })

  it('skips definitionFile-only entries because runtime has no filesystem', () => {
    expect(extractObservedSelectors({ observers: [{ definitionFile: 'docs-butler.observer.json' }] })).toEqual([])
  })

  it('requires wt-comm actions and non-empty emits', () => {
    expect(extractObservedSelectors({ observers: [{ definition: { watch: { roles: ['implementer'] }, actions: ['wt-comm'], emits: [] } }] })).toEqual([])
    expect(extractObservedSelectors({ observers: [{ definition: { watch: { roles: ['implementer'] }, actions: ['summary'], emits: ['observer.hint'] } }] })).toEqual([])
  })

  it('filters junk watch entries while preserving string selector entries', () => {
    expect(extractObservedSelectors({ observers: [inlineWtCommObserver] })).toEqual([
      { roles: ['implementer', 'reviewer'], phases: ['Build', 'Review'] },
    ])
  })

  it('uses own keys only when finding observers and inline definitions', () => {
    const args = Object.create({ observers: [inlineWtCommObserver] }) as Record<PropertyKey, unknown>
    expect(extractObservedSelectors(args)).toEqual([])

    const entry = Object.create({ definition: inlineWtCommObserver.definition }) as Record<PropertyKey, unknown>
    expect(extractObservedSelectors({ observers: [entry] })).toEqual([])
  })

  it('drops degenerate selectors (neither roles nor phases) — the A6 "at least one selector" twin', () => {
    const wtComm = { actions: ['summary', 'wt-comm'], emits: ['observer.hint'] }
    expect(extractObservedSelectors({ observers: [{ definition: { ...wtComm, watch: {} } }] })).toEqual([])
    // A non-array selector value is dropped by stringEntries — the selector must then be
    // dropped too, not kept as a match-all.
    expect(extractObservedSelectors({ observers: [{ definition: { ...wtComm, watch: { roles: 'implementer' } } }] })).toEqual([])
  })
})

describe('buildObservedRoleSection', () => {
  it('returns the normative section byte-exactly', () => {
    expect(buildObservedRoleSection('implementer')).toBe(`---
OBSERVED ROLE BRIEF (auto-injected: an observer watches this run)
An attached observer may leave you typed \`observer.hint\` messages. Follow the
observed-role consumer brief of the wt-comm teaching pack: the file
\`teaching/wt-comm-observer-consumer.md\` inside the installed
\`@workflow-toolbox/comm\` package (read that file — it defines the conduct
rules, how to list unread hints, and the read-settlement marker; reference it,
never copy it). Your parameters:
- ROLE_ID: "implementer" (hints are addressed to this role name)
- WT_COMM_DIR and RUN_ID: read the JSON file named by the environment variable
  WT_COMM_PARAMS. One-liner:
  export WT_COMM_DIR=$(sed -n 's/.*"commDir" *: *"\\([^"]*\\)".*/\\1/p' "$WT_COMM_PARAMS") ROLE_ID="implementer"
  (the \`runId\` key in the same file is your RUN_ID.)
If WT_COMM_PARAMS is unset or the params file does not exist yet, the delivery
channel is inactive at this boundary: proceed unobserved and re-check at a
later natural boundary. Consult hints at NATURAL BOUNDARIES only; a missing or
unreadable channel never fails your task.`)
  })

  it('stays coherent with the shipped observer-consumer teaching pack', () => {
    const pack = readFileSync(
      join(REPO_ROOT, 'toolkit/packages/comm/teaching/wt-comm-observer-consumer.md'),
      'utf8',
    )
    for (const term of ['WT_COMM_DIR', 'ROLE_ID', 'RUN_ID']) {
      expect(pack).toContain(term)
    }
    const section = buildObservedRoleSection('implementer')
    expect(section).toContain('teaching/wt-comm-observer-consumer.md')
    expect(section).toContain('WT_COMM_PARAMS')
    expect(section).toContain('commDir')
    expect(section).toContain('runId')
    expect(section.toLowerCase()).toContain('natural boundaries')
  })
})

describe('observedBriefFor', () => {
  it('builds a section for the first matching selector with a resolved role id', () => {
    const brief = observedBriefFor([{ roles: ['reviewer'] }, { roles: ['implementer'] }])
    expect(brief({ label: 'implementer:0' })).toContain('ROLE_ID: "implementer"')
  })

  it('returns null for empty selectors or selectors without a role id', () => {
    expect(observedBriefFor([])({ label: 'implementer' })).toBeNull()
    expect(observedBriefFor([{ phases: ['Build'] }])({ phase: 'Build' })).toBeNull()
  })

  it('a selector that matches but resolves no role id does not starve a later selector that does (review lock)', () => {
    // {} is match-all but role-less; the later well-formed selector must still brief.
    const brief = observedBriefFor([{}, { roles: ['implementer'] }])
    expect(brief({ label: 'implementer' })).toContain('ROLE_ID: "implementer"')
  })
})
