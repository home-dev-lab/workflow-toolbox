// hook-registration-coverage.test.ts — the OTHER arrow of hook registration drift
// (card #1836844219583432122): every `plugin/bin/*-hook.mjs` script is either declared in
// plugin.json or named in an exclusions map with a reason. The existing
// plugin-hook-registration-drift.test.ts / wt-hook-registration-drift-hook.mjs guard the
// opposite direction (a DECLARED path resolving to a real file) — this file does not duplicate
// that, it closes the arrow it leaves open: a real file nothing declares.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { declaredHookPaths } from '../../../../plugin/bin/lib/hook-manifest.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { auditHookRegistration, shippedHookBasenames } from '../../../../plugin/bin/lib/hook-registration-coverage-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { HOOK_REGISTRATION_EXCLUSIONS } from '../../../../plugin/bin/lib/hook-registration-exclusions.mjs'

type HookPathEntry = { event: string; rel: string }
type Exclusion = { script: string; reason: string }

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const MANIFEST = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
const BIN_DIR = join(PLUGIN_ROOT, 'bin')

// --------------------------------------------------------------------------
// 1. Unit — pure functions, synthetic fixtures (red-proof lives beside these; see the mutation
//    proof recorded in the closing report, done against a COPY outside the repo per the brief).
// --------------------------------------------------------------------------
describe('shippedHookBasenames — derives the shipped set from directory entries, never a list', () => {
  it('keeps only *-hook.mjs entries, sorted', () => {
    expect(
      shippedHookBasenames(['wt-b-hook.mjs', 'wt-a-hook.mjs', 'wt-cli.mjs', 'lib', 'README.md']),
    ).toEqual(['wt-a-hook.mjs', 'wt-b-hook.mjs'])
  })

  it('does not match a bare CLI companion missing the -hook suffix', () => {
    // e.g. wt-lane-consent-check.mjs (CLI) vs wt-lane-consent-check-hook.mjs (the hook itself)
    expect(shippedHookBasenames(['wt-lane-consent-check.mjs', 'wt-lane-consent-check-hook.mjs'])).toEqual([
      'wt-lane-consent-check-hook.mjs',
    ])
  })
})

describe('auditHookRegistration — unit, synthetic fixtures', () => {
  it('flags a shipped hook that is neither declared nor excluded — THE DEFECT shape', () => {
    const result = auditHookRegistration({
      shipped: ['wt-alpha-hook.mjs', 'wt-beta-hook.mjs'],
      declaredRelPaths: [{ event: 'Stop', rel: '/bin/wt-alpha-hook.mjs' }],
      exclusions: [],
    })
    expect(result.undeclared).toEqual(['wt-beta-hook.mjs'])
  })

  it('does not flag a shipped hook that is declared', () => {
    const result = auditHookRegistration({
      shipped: ['wt-alpha-hook.mjs'],
      declaredRelPaths: [{ event: 'Stop', rel: '/bin/wt-alpha-hook.mjs' }],
      exclusions: [],
    })
    expect(result.undeclared).toEqual([])
  })

  it('does not flag a shipped hook that is deliberately excluded', () => {
    const result = auditHookRegistration({
      shipped: ['wt-alpha-hook.mjs'],
      declaredRelPaths: [],
      exclusions: [{ script: 'wt-alpha-hook.mjs', reason: 'deprecation shim' }],
    })
    expect(result.undeclared).toEqual([])
  })

  it('flags a STALE exclusion — the excluded script no longer ships', () => {
    const result = auditHookRegistration({
      shipped: ['wt-alpha-hook.mjs'],
      declaredRelPaths: [{ event: 'Stop', rel: '/bin/wt-alpha-hook.mjs' }],
      exclusions: [{ script: 'wt-gamma-hook.mjs', reason: 'used to exist' }],
    })
    expect(result.staleExclusions).toEqual(['wt-gamma-hook.mjs'])
  })

  it('flags a REDUNDANT exclusion — the excluded script is also declared', () => {
    const result = auditHookRegistration({
      shipped: ['wt-alpha-hook.mjs'],
      declaredRelPaths: [{ event: 'Stop', rel: '/bin/wt-alpha-hook.mjs' }],
      exclusions: [{ script: 'wt-alpha-hook.mjs', reason: 'stale reasoning, no longer true' }],
    })
    expect(result.redundantExclusions).toEqual(['wt-alpha-hook.mjs'])
  })
})

// --------------------------------------------------------------------------
// 2. REAL gate over this repo's own plugin/bin/ and plugin.json.
// --------------------------------------------------------------------------
describe('hook registration coverage — REAL gate (card #1836844219583432122)', () => {
  it('every shipped plugin/bin/*-hook.mjs script is declared in plugin.json or named in the exclusions map', () => {
    const shipped = shippedHookBasenames(readdirSync(BIN_DIR))
    const declared = declaredHookPaths(MANIFEST) as HookPathEntry[]
    const exclusions = HOOK_REGISTRATION_EXCLUSIONS as Exclusion[]

    const result = auditHookRegistration({ shipped, declaredRelPaths: declared, exclusions })

    expect(result.undeclared, `shipped hook(s) absent from plugin.json AND the exclusions map: ${JSON.stringify(result.undeclared)}`).toEqual([])
    expect(result.staleExclusions, `exclusion entries naming a script that no longer ships: ${JSON.stringify(result.staleExclusions)}`).toEqual([])
    expect(result.redundantExclusions, `exclusion entries naming a script that IS declared: ${JSON.stringify(result.redundantExclusions)}`).toEqual([])

    // Sanity: this actually examined a real, non-trivial shipped set (not silently a no-op).
    expect(shipped.length).toBeGreaterThan(30)
  })

  it('BOTH DIRECTIONS: the correctly-registered hooks pass this gate clean, not merely the exclusions', () => {
    // A gate that only proves it catches an unregistered hook cannot be told apart from one
    // that flags EVERYTHING — assert the large majority of shipped hooks are declared, not
    // excluded, so a gate wired backwards (declared==excluded, or an always-true check) fails
    // this assertion.
    const shipped = shippedHookBasenames(readdirSync(BIN_DIR))
    const declared = declaredHookPaths(MANIFEST) as HookPathEntry[]
    const declaredBasenames = new Set(declared.map(({ rel }) => rel.split('/').pop()))
    const excludedNames = new Set((HOOK_REGISTRATION_EXCLUSIONS as Exclusion[]).map((e) => e.script))

    const cleanlyRegistered = (shipped as string[]).filter(
      (name: string) => declaredBasenames.has(name) && !excludedNames.has(name),
    )
    expect(cleanlyRegistered.length).toBeGreaterThan(30)
    // Every excluded name really is excluded (not merely absent from the declared set for some
    // other reason, e.g. a typo in the exclusions map that happens to also miss the manifest).
    for (const name of excludedNames) expect(declaredBasenames.has(name)).toBe(false)
  })

  it('the exclusions map states a non-empty reason for every entry (no placeholder exclusions)', () => {
    for (const entry of HOOK_REGISTRATION_EXCLUSIONS as Exclusion[]) {
      expect(entry.reason.trim().length, `empty reason for ${entry.script}`).toBeGreaterThan(10)
    }
  })
})
