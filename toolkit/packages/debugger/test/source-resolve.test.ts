import { describe, it, expect, vi } from 'vitest'
import {
  resolveSource,
  matchHealthSource,
  matchSourcesListEntry,
  classifySourceSearch,
  localSourceKeys,
  withRetry,
  SourceResolutionError,
  SOURCE_PROBE_ATTEMPTS,
  type HealthSourceEntry,
  type SourcesListEntry,
} from '../src/source-resolve.js'

// source-resolve.ts — pure decision core extracted for the false-"missing" incident
// (card #1819922556652619607): `wt-observe await`/`launch` reported a run as unresolvable
// while it was live, because the old resolveSourcePrefix made a ONE-SHOT, unretried
// /api/sources fetch and read ANY failure as "confirmed single-source". These tests lock
// the fix's four contracts (per the card's DoD): (a) a probe failure retries and never
// silently latches "unprefixed"; (b) exhausted retries are a LOUD, distinct failure, never
// masqueraded as "missing"; (c) a runId found under a non-default source resolves via
// search; (d) a genuinely missing run is unaffected by any of this.

const noSleep = async (): Promise<void> => {}

describe('resolveSource — the common cases never touch the fallback fetch', () => {
  it('single-source server (health.sources absent) resolves unprefixed without calling fetchSourcesList', async () => {
    const fetchSourcesList = vi.fn(async () => null)
    const result = await resolveSource(undefined, undefined, fetchSourcesList, noSleep)
    expect(result).toEqual({ prefix: '', key: null, label: '' })
    expect(fetchSourcesList).not.toHaveBeenCalled()
  })

  it('single-source server (health.sources = []) resolves unprefixed without calling fetchSourcesList', async () => {
    const fetchSourcesList = vi.fn(async () => null)
    const result = await resolveSource([], undefined, fetchSourcesList, noSleep)
    expect(result).toEqual({ prefix: '', key: null, label: '' })
    expect(fetchSourcesList).not.toHaveBeenCalled()
  })

  it('no --source given, hub mode: resolves to the FIRST source straight off health, no fallback fetch (the incident scenario)', async () => {
    const healthSources: HealthSourceEntry[] = [
      { key: 'abc123', configDir: '/home/doublefx/.claude' },
      { key: 'def456', configDir: '/home/doublefx/.claude-work' },
    ]
    const fetchSourcesList = vi.fn(async () => null)
    const result = await resolveSource(healthSources, undefined, fetchSourcesList, noSleep)
    expect(result).toEqual({ prefix: '/s/abc123', key: 'abc123', label: '.claude' })
    expect(fetchSourcesList).not.toHaveBeenCalled()
  })

  it('--source matches by KEY straight off health, no fallback fetch', async () => {
    const healthSources: HealthSourceEntry[] = [
      { key: 'abc123', configDir: '/home/doublefx/.claude' },
      { key: 'def456', configDir: '/home/doublefx/.claude-work' },
    ]
    const fetchSourcesList = vi.fn(async () => null)
    const result = await resolveSource(healthSources, 'def456', fetchSourcesList, noSleep)
    expect(result).toEqual({ prefix: '/s/def456', key: 'def456', label: '.claude-work' })
    expect(fetchSourcesList).not.toHaveBeenCalled()
  })

  it('--source matches by configDir (exact or path-suffix) straight off health, no fallback fetch', async () => {
    const healthSources: HealthSourceEntry[] = [{ key: 'abc123', configDir: '/home/doublefx/.claude' }]
    const fetchSourcesList = vi.fn(async () => null)
    const bySuffix = await resolveSource(healthSources, '.claude', fetchSourcesList, noSleep)
    expect(bySuffix).toEqual({ prefix: '/s/abc123', key: 'abc123', label: '.claude' })
    const byExact = await resolveSource(healthSources, '/home/doublefx/.claude', fetchSourcesList, noSleep)
    expect(byExact).toEqual({ prefix: '/s/abc123', key: 'abc123', label: '.claude' })
    expect(fetchSourcesList).not.toHaveBeenCalled()
  })

  it('a remote entry (no configDir) matches by key and labels itself by key (no basename to fall back on)', async () => {
    const healthSources: HealthSourceEntry[] = [{ key: 'remote-x', remote: true }]
    const result = await resolveSource(healthSources, 'remote-x', vi.fn(async () => null), noSleep)
    expect(result).toEqual({ prefix: '/s/remote-x', key: 'remote-x', label: 'remote-x' })
  })
})

describe('resolveSource — TEST-LOCK (a): probe failure RETRIES and never silently goes unprefixed', () => {
  it('the fallback fetch (needed for a label-only match) fails once then succeeds — resolves correctly, never unprefixed', async () => {
    const healthSources: HealthSourceEntry[] = [{ key: 'abc123', configDir: '/home/doublefx/.claude' }]
    const list: SourcesListEntry[] = [{ key: 'abc123', configDir: '/home/doublefx/.claude', label: 'my-label' }]
    let calls = 0
    const fetchSourcesList = vi.fn(async () => {
      calls += 1
      return calls === 1 ? null : list // first attempt "fails" (transient), second succeeds
    })
    const sleep = vi.fn(async () => {})
    const result = await resolveSource(healthSources, 'my-label', fetchSourcesList, sleep)
    expect(result).toEqual({ prefix: '/s/abc123', key: 'abc123', label: 'my-label' })
    expect(fetchSourcesList).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1) // one backoff between the failed and successful attempt
  })
})

describe('resolveSource — TEST-LOCK (b): exhausted retries are a LOUD, distinct failure', () => {
  it('the fallback fetch fails every attempt — throws SourceResolutionError, never returns an unprefixed guess', async () => {
    const healthSources: HealthSourceEntry[] = [{ key: 'abc123', configDir: '/home/doublefx/.claude' }]
    const fetchSourcesList = vi.fn(async () => null)
    const sleep = vi.fn(async () => {})
    await expect(resolveSource(healthSources, 'unmatched-label', fetchSourcesList, sleep)).rejects.toBeInstanceOf(SourceResolutionError)
    expect(fetchSourcesList).toHaveBeenCalledTimes(SOURCE_PROBE_ATTEMPTS)
    expect(sleep).toHaveBeenCalledTimes(SOURCE_PROBE_ATTEMPTS - 1)
  })

  it('the fallback fetch succeeds but the label matches nothing — throws SourceResolutionError naming what IS available', async () => {
    const healthSources: HealthSourceEntry[] = [{ key: 'abc123', configDir: '/home/doublefx/.claude' }]
    const list: SourcesListEntry[] = [{ key: 'abc123', configDir: '/home/doublefx/.claude', label: 'real-label' }]
    const fetchSourcesList = vi.fn(async () => list)
    await expect(resolveSource(healthSources, 'nonexistent', fetchSourcesList, noSleep)).rejects.toThrow(/nonexistent/)
    await expect(resolveSource(healthSources, 'nonexistent', fetchSourcesList, noSleep)).rejects.toThrow(/real-label/)
  })
})

describe('withRetry — the generic bounded-retry primitive', () => {
  it('succeeds on the first attempt without ever sleeping', async () => {
    const attempt = vi.fn(async () => 'value')
    const sleep = vi.fn(async () => {})
    const outcome = await withRetry(attempt, { attempts: 3, delayMs: () => 100, sleep })
    expect(outcome).toEqual({ kind: 'ok', value: 'value' })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('a null attempt retries with the configured delay, then succeeds', async () => {
    let calls = 0
    const attempt = vi.fn(async () => (++calls === 1 ? null : 'value'))
    const delays: number[] = []
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms)
    })
    const outcome = await withRetry(attempt, { attempts: 3, delayMs: (i) => (i === 0 ? 300 : 900), sleep })
    expect(outcome).toEqual({ kind: 'ok', value: 'value' })
    expect(delays).toEqual([300])
  })

  it('exhausts every attempt and reports so, never fabricating a value', async () => {
    const attempt = vi.fn(async () => null)
    const sleep = vi.fn(async () => {})
    const outcome = await withRetry(attempt, { attempts: 3, delayMs: () => 1, sleep })
    expect(outcome).toEqual({ kind: 'exhausted' })
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2) // never sleeps after the LAST attempt
  })
})

describe('classifySourceSearch — TEST-LOCK (c): a runId found under exactly one source resolves', () => {
  it('a single hit is unique', () => {
    expect(classifySourceSearch(['source-b'])).toEqual({ kind: 'unique', key: 'source-b' })
  })

  it('no hits is none — the run genuinely is not visible anywhere yet', () => {
    expect(classifySourceSearch([])).toEqual({ kind: 'none' })
  })

  it('the SAME source hitting on both live and recall dedupes to unique, not ambiguous', () => {
    expect(classifySourceSearch(['source-a', 'source-a'])).toEqual({ kind: 'unique', key: 'source-a' })
  })

  it('two DIFFERENT sources both reporting the runId is ambiguous (defensive — should not occur given global uniqueness)', () => {
    const result = classifySourceSearch(['source-a', 'source-b'])
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') expect(result.keys).toEqual(['source-a', 'source-b'])
  })
})

describe('localSourceKeys — scoped to LOCAL sources only, remotes excluded', () => {
  it('returns [] for a single-source (no hub sources) payload', () => {
    expect(localSourceKeys(undefined)).toEqual([])
    expect(localSourceKeys([])).toEqual([])
  })

  it('returns only the keys of entries carrying a configDir, remotes filtered out', () => {
    const sources: HealthSourceEntry[] = [
      { key: 'local-a', configDir: '/home/doublefx/.claude' },
      { key: 'remote-b', remote: true },
      { key: 'local-c', configDir: '/home/doublefx/.claude-work' },
    ]
    expect(localSourceKeys(sources)).toEqual(['local-a', 'local-c'])
  })
})

describe('matchHealthSource / matchSourcesListEntry — matching primitives', () => {
  it('matchHealthSource never throws on a remote entry lacking configDir', () => {
    const sources: HealthSourceEntry[] = [{ key: 'remote-x', remote: true }]
    expect(matchHealthSource(sources, 'anything-else')).toBeUndefined()
    expect(matchHealthSource(sources, 'remote-x')).toEqual({ key: 'remote-x', remote: true })
  })

  it('matchSourcesListEntry matches by key, label, or configDir suffix', () => {
    const list: SourcesListEntry[] = [{ key: 'k1', configDir: '/a/b/.claude', label: 'my-label' }]
    expect(matchSourcesListEntry(list, 'k1')?.key).toBe('k1')
    expect(matchSourcesListEntry(list, 'my-label')?.key).toBe('k1')
    expect(matchSourcesListEntry(list, '.claude')?.key).toBe('k1')
    expect(matchSourcesListEntry(list, 'nope')).toBeUndefined()
  })
})
