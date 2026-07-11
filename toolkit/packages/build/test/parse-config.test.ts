import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/define-workflow.js'

// ---------------------------------------------------------------------------
// parseConfig — launch-time tuning-config normalizer (Class B/C convention).
// ---------------------------------------------------------------------------
describe('parseConfig', () => {
  it('returns {} for undefined or null', () => {
    expect(parseConfig(undefined)).toEqual({})
    expect(parseConfig(null)).toEqual({})
  })

  it('throws on a non-object scalar', () => {
    expect(() => parseConfig('nope')).toThrow(/expected an object/)
    expect(() => parseConfig(42)).toThrow(/expected an object/)
  })

  it('parses a full perAgent slice', () => {
    const cfg = parseConfig({
      perAgent: { model: 'sonnet', effort: 'high', agentType: 'reviewer', isolation: 'worktree', stallMs: 60000 },
    })
    expect(cfg.perAgent).toEqual({
      model: 'sonnet', effort: 'high', agentType: 'reviewer', isolation: 'worktree', stallMs: 60000,
    })
  })

  it('rejects an unknown perAgent key (typo-catching on the fixed shape)', () => {
    expect(() => parseConfig({ perAgent: { modle: 'sonnet' } })).toThrow(/unknown perAgent key "modle"/)
  })

  it('rejects an invalid effort value', () => {
    expect(() => parseConfig({ perAgent: { effort: 'turbo' } })).toThrow(/must be one of low, medium, high, xhigh, max/)
    expect(() => parseConfig({ effort: { judge: 'extreme' } })).toThrow(/effort\.judge must be one of/)
  })

  it('rejects a non-worktree isolation and a non-positive stallMs', () => {
    expect(() => parseConfig({ perAgent: { isolation: 'sandbox' } })).toThrow(/isolation must be 'worktree'/)
    expect(() => parseConfig({ perAgent: { stallMs: 0 } })).toThrow(/stallMs must be a positive finite number/)
  })

  it('parses the role maps (models / effort / agentTypes / sizing)', () => {
    const cfg = parseConfig({
      models: { attempt: 'sonnet', judge: 'opus' },
      effort: { judge: 'max' },
      agentTypes: { verifier: 'magic-claude:ts-reviewer' },
      sizing: { votes: 5, judgeCount: 3, budgetFloor: 50000 },
    })
    expect(cfg.models).toEqual({ attempt: 'sonnet', judge: 'opus' })
    expect(cfg.effort).toEqual({ judge: 'max' })
    expect(cfg.agentTypes).toEqual({ verifier: 'magic-claude:ts-reviewer' })
    expect(cfg.sizing).toEqual({ votes: 5, judgeCount: 3, budgetFloor: 50000 })
  })

  it('rejects an empty model string and a non-numeric sizing value', () => {
    expect(() => parseConfig({ models: { judge: '' } })).toThrow(/models\.judge must be a non-empty string/)
    expect(() => parseConfig({ sizing: { votes: 'three' } })).toThrow(/sizing\.votes must be a finite number/)
    expect(() => parseConfig({ sizing: { votes: Infinity } })).toThrow(/sizing\.votes must be a finite number/)
  })

  it('ignores unrecognized top-level keys (composable with bespoke args)', () => {
    const cfg = parseConfig({ target: 'main..HEAD', models: { judge: 'opus' } })
    expect(cfg).toEqual({ models: { judge: 'opus' } })
  })

  it('throws when a slice is present but not an object', () => {
    expect(() => parseConfig({ models: 'opus' })).toThrow(/models must be an object/)
    expect(() => parseConfig({ perAgent: ['x'] })).toThrow(/perAgent must be an object/)
  })

  // ---------------------------------------------------------------------------
  // 'auto' sentinel — the effort ROLE MAP only (EffortRoleValue = EffortAlias |
  // 'auto'). It means "use this role's own stage-class default", resolved by
  // the composition via resolveEffort/resolveVerifierEffort — parseConfig only
  // validates the token through, it has no notion of a role's default value.
  // perAgent.effort (Class A, a blanket default with no per-role resolution
  // step downstream) stays the strict 5-tier EffortAlias — 'auto' there would
  // reach the sandbox as a literal it does not understand.
  // ---------------------------------------------------------------------------
  it("passes 'auto' through the effort role map untouched (per-role default sentinel)", () => {
    const cfg = parseConfig({ effort: { judge: 'auto', attempt: 'high' } })
    expect(cfg.effort).toEqual({ judge: 'auto', attempt: 'high' })
  })

  it("still rejects 'auto' for perAgent.effort (no per-role resolution step there)", () => {
    expect(() => parseConfig({ perAgent: { effort: 'auto' } })).toThrow(
      /perAgent\.effort must be one of low, medium, high, xhigh, max/,
    )
  })

  it("rejects a garbage effort role-map value even with 'auto' in the allowlist", () => {
    expect(() => parseConfig({ effort: { judge: 'extreme' } })).toThrow(
      /effort\.judge must be one of low, medium, high, xhigh, max, auto/,
    )
  })
})
