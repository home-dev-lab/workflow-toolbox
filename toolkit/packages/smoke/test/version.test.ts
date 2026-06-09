// version.test.ts — unit tests for the pure version-signal + marker logic of the
// upgrade canary. No I/O, no SDK, no agent runs: these run inside `pnpm test`.

import { describe, expect, it } from 'vitest'
import {
  type CanaryMarker,
  compareSignals,
  compareVersions,
  decideRun,
  diffSnapshot,
  formatMarker,
  parseClaudeVersion,
  parseMarker,
  type TargetsSnapshot,
} from '../src/version.js'

const marker = (over: Partial<CanaryMarker> = {}): CanaryMarker => ({
  claudeVersion: '2.1.167',
  sdkVersion: '0.3.168',
  lastRunISO: '2026-06-07T20:00:00.000Z',
  lastVerdict: 'pass',
  ...over,
})

describe('parseClaudeVersion', () => {
  it('extracts the semver from real `claude --version` output', () => {
    expect(parseClaudeVersion('2.1.167 (Claude Code)')).toBe('2.1.167')
  })

  it('handles a bare version and trailing newline', () => {
    expect(parseClaudeVersion('2.1.167\n')).toBe('2.1.167')
  })

  it('returns null when no semver is present', () => {
    expect(parseClaudeVersion('Claude Code')).toBeNull()
    expect(parseClaudeVersion('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.1.167', '2.1.168')).toBe(-1)
    expect(compareVersions('2.1.168', '2.1.167')).toBe(1)
    expect(compareVersions('2.2.0', '2.1.999')).toBe(1)
    expect(compareVersions('3.0.0', '2.9.9')).toBe(1)
  })

  it('returns 0 for equal versions', () => {
    expect(compareVersions('2.1.167', '2.1.167')).toBe(0)
  })

  it('compares numerically, not lexically (10 > 9)', () => {
    expect(compareVersions('2.1.10', '2.1.9')).toBe(1)
    expect(compareVersions('2.10.0', '2.9.0')).toBe(1)
  })
})

describe('parseMarker', () => {
  it('round-trips a formatted marker', () => {
    const m = marker()
    expect(parseMarker(formatMarker(m))).toEqual(m)
  })

  it('returns null on invalid JSON', () => {
    expect(parseMarker('not json')).toBeNull()
  })

  it('returns null when lastVerdict is missing or invalid', () => {
    expect(parseMarker(JSON.stringify({ claudeVersion: '2.1.167', lastRunISO: 'x' }))).toBeNull()
    expect(parseMarker(JSON.stringify({ lastVerdict: 'maybe', lastRunISO: 'x' }))).toBeNull()
  })

  it('returns null when lastRunISO is missing', () => {
    expect(parseMarker(JSON.stringify({ lastVerdict: 'pass' }))).toBeNull()
  })

  it('tolerates absent version fields (null), not absent verdict', () => {
    const parsed = parseMarker(JSON.stringify({ lastVerdict: 'fail', lastRunISO: 't' }))
    expect(parsed).toEqual({ claudeVersion: null, sdkVersion: null, lastRunISO: 't', lastVerdict: 'fail' })
  })

  it('parses a v1 marker (no targets) unchanged — backward compatible', () => {
    const v1 = parseMarker(JSON.stringify(marker()))
    expect(v1?.targets).toBeUndefined()
    expect(v1?.claudeVersion).toBe('2.1.167')
  })

  it('round-trips a v2 marker with a targets snapshot', () => {
    const m = marker({
      targets: {
        system: { ccVersion: '2.1.167', checks: [{ name: 'tier2', ok: true }] },
        bundled: { ccVersion: '2.1.168', checks: [{ name: 'edge: cap', ok: true, canonicalReason: 'exceeds 524288 bytes' }] },
      },
    })
    expect(parseMarker(formatMarker(m))).toEqual(m)
  })

  it('drops malformed check entries from targets', () => {
    const parsed = parseMarker(
      JSON.stringify({
        lastVerdict: 'pass',
        lastRunISO: 't',
        targets: { system: { ccVersion: '2.1.167', checks: [{ name: 'a', ok: true }, { name: 'b' }, 'junk'] } },
      }),
    )
    expect(parsed?.targets?.['system']?.checks).toEqual([{ name: 'a', ok: true }])
  })
})

describe('diffSnapshot', () => {
  const base: TargetsSnapshot = {
    system: { ccVersion: '2.1.167', checks: [{ name: 'tier2', ok: true }, { name: 'edge: cap', ok: true, canonicalReason: 'exceeds 524288 bytes' }] },
  }

  it('reports nothing when nothing moved', () => {
    expect(diffSnapshot(base, base)).toEqual({ versionDeltas: [], flips: [], reasonDrift: [] })
  })

  it('reports a ccVersion move', () => {
    const cur: TargetsSnapshot = { system: { ...base['system']!, ccVersion: '2.1.168' } }
    expect(diffSnapshot(base, cur).versionDeltas).toEqual(['system: 2.1.167 → 2.1.168'])
  })

  it('reports a pass→FAIL flip', () => {
    const cur: TargetsSnapshot = { system: { ccVersion: '2.1.167', checks: [{ name: 'tier2', ok: false }, { name: 'edge: cap', ok: true, canonicalReason: 'exceeds 524288 bytes' }] } }
    expect(diffSnapshot(base, cur).flips).toEqual(['system / tier2: pass → FAIL'])
  })

  it('reports canonical rejection-wording drift', () => {
    const cur: TargetsSnapshot = { system: { ccVersion: '2.1.167', checks: [{ name: 'tier2', ok: true }, { name: 'edge: cap', ok: true, canonicalReason: 'too large: over 524288 bytes' }] } }
    expect(diffSnapshot(base, cur).reasonDrift).toHaveLength(1)
  })

  it('flags a brand-new target as new (not a crash)', () => {
    const cur: TargetsSnapshot = { ...base, bundled: { ccVersion: '2.1.168', checks: [] } }
    expect(diffSnapshot(base, cur).versionDeltas).toContain('bundled: (new) → 2.1.168')
  })

  it('treats no prior snapshot as all-new', () => {
    expect(diffSnapshot(undefined, base).versionDeltas).toEqual(['system: (new) → 2.1.167'])
  })
})

describe('compareSignals', () => {
  it('treats a missing marker as changed (per-clone first run)', () => {
    const r = compareSignals(null, { claudeVersion: '2.1.167', sdkVersion: '0.3.168' })
    expect(r.changed).toBe(true)
    expect(r.deltas[0]).toMatch(/no previous canary marker/)
  })

  it('is unchanged when both signals match', () => {
    const r = compareSignals(marker(), { claudeVersion: '2.1.167', sdkVersion: '0.3.168' })
    expect(r).toEqual({ changed: false, deltas: [] })
  })

  it('detects a claude version change', () => {
    const r = compareSignals(marker(), { claudeVersion: '2.1.168', sdkVersion: '0.3.168' })
    expect(r.changed).toBe(true)
    expect(r.deltas).toEqual(['claude 2.1.167 → 2.1.168'])
  })

  it('detects an sdk version change', () => {
    const r = compareSignals(marker(), { claudeVersion: '2.1.167', sdkVersion: '0.3.169' })
    expect(r.changed).toBe(true)
    expect(r.deltas).toEqual(['sdk 0.3.168 → 0.3.169'])
  })

  it('reports both deltas when both move', () => {
    const r = compareSignals(marker(), { claudeVersion: '2.2.0', sdkVersion: '0.4.0' })
    expect(r.deltas).toHaveLength(2)
  })
})

describe('decideRun', () => {
  const unchanged = { changed: false, deltas: [] }
  const changed = { changed: true, deltas: ['claude 2.1.167 → 2.1.168'] }

  it('runs when forced, even if unchanged and last passed', () => {
    expect(decideRun(unchanged, marker(), true)).toEqual({ run: true, reason: 'forced (--force)' })
  })

  it('runs when a signal changed', () => {
    const d = decideRun(changed, marker(), false)
    expect(d.run).toBe(true)
    expect(d.reason).toContain('2.1.168')
  })

  it('runs when unchanged but the last verdict was a fail', () => {
    const d = decideRun(unchanged, marker({ lastVerdict: 'fail' }), false)
    expect(d.run).toBe(true)
    expect(d.reason).toMatch(/FAIL/)
  })

  it('skips ONLY when unchanged and the last verdict was a pass', () => {
    const d = decideRun(unchanged, marker({ lastVerdict: 'pass' }), false)
    expect(d.run).toBe(false)
    expect(d.reason).toMatch(/unchanged/)
  })

  it('runs when there is no marker at all', () => {
    expect(decideRun({ changed: true, deltas: ['no previous canary marker on this machine'] }, null, false).run).toBe(true)
  })
})
