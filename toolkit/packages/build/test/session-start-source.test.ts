// session-start-source.test.ts — the one predicate the plugin's SessionStart hooks use to stay silent
// after a compaction (plugin/bin/lib/session-start-source.mjs).
import { describe, expect, it } from 'vitest'
import { isCompactSource } from '../../../../plugin/bin/lib/session-start-source.mjs'

describe('isCompactSource', () => {
  it('is true only for a SessionStart payload whose source is compact; an absent event name counts as SessionStart', () => {
    expect(isCompactSource({ hook_event_name: 'SessionStart', source: 'compact' })).toBe(true)
    expect(isCompactSource({ source: 'compact' })).toBe(true)
  })

  it('is false for every other source, another event, and a payload that is not an object', () => {
    for (const source of ['startup', 'resume', 'clear', 'fork', undefined, 'COMPACT']) {
      expect(isCompactSource({ hook_event_name: 'SessionStart', source })).toBe(false)
    }
    expect(isCompactSource({ hook_event_name: 'UserPromptSubmit', source: 'compact' })).toBe(false)
    for (const input of [null, undefined, false, 0, 'compact', []]) expect(isCompactSource(input)).toBe(false)
  })
})
