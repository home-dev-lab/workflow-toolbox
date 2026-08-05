// hook-registration-guards.test.ts — two mechanical checks against the real registration
// surfaces (card #1835085484573853516), plus a red-proof for each against synthetic fixtures.
//
// WHY. 2026-08-05: the belief "the arc watcher is armed by nothing" produced a false
// correction and 640 lines of shipped code that would have registered a SECOND arc watcher
// alongside the one already declared in plugin/monitors/monitors.json — caught only at
// integration. The same day, the observer-pairing guard hook shipped registered under
// PreToolUse while its own code required PostToolUse (card #1835081664686982981) — a
// declaration/code divergence nothing detected. Both are mechanical facts about finite,
// readable registration surfaces; neither needs judgment to catch.
//
// HONEST SCOPE (stated once here, not re-derived per test): the duplicate check catches
// IDENTICAL-SCRIPT duplication across registration surfaces, never two different scripts doing
// the same job under different names — that class stays a judgment call. The event-consistency
// check only judges a hook whose own code names a SINGLE required event unambiguously; a hook
// that legitimately handles more than one event (e.g. wt-check-commit-signatures-hook.mjs,
// registered under both PreToolUse and PostToolUse with per-event branches) is skipped, not
// asserted against — asserting on it would refuse correct, shipped work.
//
// This repo's own gate below runs only against the two registration surfaces that live IN this
// repo (plugin/monitors/monitors.json, plugin/.claude-plugin/plugin.json) — CLAUDE_CONFIG_DIR
// settings.json/settings.local.json are per-machine/per-project and not part of this repo's own
// CI-reproducible tree; the underlying `duplicateScriptRegistrations` function is generic and a
// project adopting this checker can point it at those paths too (see the module doc).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { declaredHookPaths } from '../../../../plugin/bin/lib/hook-manifest.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { duplicateScriptRegistrations, extractScriptPaths, requiredEventOf } from '../../../../plugin/bin/lib/registration-collision-check.mjs'

type HookPathEntry = { event: string; rel: string }

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const MANIFEST = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
const MONITORS = join(PLUGIN_ROOT, 'monitors', 'monitors.json')

// --------------------------------------------------------------------------
// 1. Duplicate script registration across surfaces
// --------------------------------------------------------------------------
describe('duplicateScriptRegistrations — unit, red-proof against synthetic fixtures', () => {
  it('RED: flags a script invoked by two DIFFERENT surfaces (the arc-watch near-miss shape)', () => {
    const dups = duplicateScriptRegistrations({
      monitors: ['/bin/wt-arc-watch.mjs'],
      pluginHooks: ['/bin/wt-arc-watch.mjs', '/bin/wt-outbound-guard-hook.mjs'],
    })
    expect(dups).toEqual([{ script: '/bin/wt-arc-watch.mjs', surfaces: ['monitors', 'pluginHooks'] }])
  })

  it('GREEN (fixed): removing the duplicate registration clears the finding', () => {
    const dups = duplicateScriptRegistrations({
      monitors: ['/bin/wt-arc-watch.mjs'],
      pluginHooks: ['/bin/wt-outbound-guard-hook.mjs'],
    })
    expect(dups).toEqual([])
  })

  it('does NOT flag the same script registered twice WITHIN one surface (deliberate multi-event convention)', () => {
    // e.g. wt-verifier-cli-guard-hook.mjs is registered under both PreToolUse and PostToolUse
    // inside plugin.json itself, to do different work per event — one surface, not a duplicate.
    const dups = duplicateScriptRegistrations({
      pluginHooks: ['/bin/wt-verifier-cli-guard-hook.mjs', '/bin/wt-verifier-cli-guard-hook.mjs'],
    })
    expect(dups).toEqual([])
  })

  it('does NOT flag two DIFFERENT files that merely share a basename (full-path keying, not basename)', () => {
    // A basename-only key would wrongly collide plugin/bin/foo.mjs with plugin/bin/lib/foo.mjs —
    // two genuinely different files. Cross-family review flagged this basename-collision risk;
    // this locks the fix (full relative path is the identity key, never the bare filename).
    const dups = duplicateScriptRegistrations({
      monitors: ['/bin/foo.mjs'],
      pluginHooks: ['/bin/lib/foo.mjs'],
    })
    expect(dups).toEqual([])
  })

  it('honest scope: two DIFFERENT scripts doing the same job are invisible to this check', () => {
    const dups = duplicateScriptRegistrations({
      monitors: ['/bin/wt-lane-saturation-watch.mjs'],
      pluginHooks: ['/bin/wt-lane-saturation-hook.mjs'],
    })
    expect(dups).toEqual([]) // different paths — not mechanically catchable here
  })
})

describe('extractScriptPaths — pulls FULL script paths (not basenames) out of a command/string', () => {
  it('extracts a ${CLAUDE_PLUGIN_ROOT}-rooted .mjs reference as its full relative path', () => {
    expect(extractScriptPaths('node "${CLAUDE_PLUGIN_ROOT}/bin/wt-arc-watch.mjs" --poll 60')).toEqual([
      '/bin/wt-arc-watch.mjs',
    ])
  })

  it('extracts every reference in a command with more than one, keeping directories distinct', () => {
    expect(
      extractScriptPaths('node "${CLAUDE_PLUGIN_ROOT}/bin/a.mjs" --lib "${CLAUDE_PLUGIN_ROOT}/bin/lib/a.mjs"'),
    ).toEqual(['/bin/a.mjs', '/bin/lib/a.mjs']) // same basename, different path — must NOT collapse
  })
})

describe('duplicateScriptRegistrations — REAL gate on this repo\'s own registration surfaces', () => {
  it('no script is invoked by BOTH plugin/monitors/monitors.json and plugin/.claude-plugin/plugin.json', () => {
    const monitors = JSON.parse(readFileSync(MONITORS, 'utf8')) as Array<{ command?: string }>
    const monitorScripts = monitors.flatMap((m) => extractScriptPaths(m.command))
    const declared = declaredHookPaths(MANIFEST) as HookPathEntry[]
    const hookScripts = declared.map(({ rel }) => rel)

    const dups = duplicateScriptRegistrations({ monitors: monitorScripts, pluginHooks: hookScripts })
    expect(dups, `cross-surface duplicate script registrations: ${JSON.stringify(dups)}`).toEqual([])
    // Sanity: both surfaces actually contributed something (not silently empty).
    expect(monitorScripts.length).toBeGreaterThan(0)
    expect(hookScripts.length).toBeGreaterThan(0)
  })
})

// --------------------------------------------------------------------------
// 2. Declared event vs code-required event
// --------------------------------------------------------------------------
describe('requiredEventOf — unit, red-proof against synthetic fixtures', () => {
  it('RED: extracts the single required event from an observer-pairing-shaped gate', () => {
    const src = `function main() {\n  const input = readInput()\n  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Agent') return\n}`
    expect(requiredEventOf(src)).toBe('PostToolUse')
  })

  it('extracts the required event from an && -guarded gate', () => {
    const src = `if (input.hook_event_name && input.hook_event_name !== 'SessionStart') return`
    expect(requiredEventOf(src)).toBe('SessionStart')
  })

  it('returns null (ambiguous, skip) when the file names more than one required event', () => {
    const src = `if (input.hook_event_name !== 'PreToolUse') return []\nif (input.hook_event_name !== 'PostToolUse') doOther()`
    expect(requiredEventOf(src)).toBeNull()
  })

  it('returns null (cannot determine, skip) when the file has no such gate at all', () => {
    expect(requiredEventOf('function main() { doStuff() }')).toBeNull()
  })

  it('ignores a gate mentioned only in a // line comment (does not mistake prose for code)', () => {
    // Cross-family review flagged that a naive regex would read a comment as a real gate. A
    // hook whose code has NO real gate but happens to comment about one must still return null.
    const src = `function main() {\n  // if (input.hook_event_name !== 'PreToolUse') return\n  doWork()\n}`
    expect(requiredEventOf(src)).toBeNull()
  })

  it('reads the real gate correctly even when a misleading comment sits on an earlier line', () => {
    const src = `// note: unlike wt-foo, this one used to require PreToolUse\nif (input.hook_event_name !== 'PostToolUse') return`
    expect(requiredEventOf(src)).toBe('PostToolUse')
  })
})

describe('hook event consistency — REAL gate over every shipped hook (card #1835081664686982981\'s class)', () => {
  it('every DECLARED event matches the REQUIRED event for every hook registered under exactly one event', () => {
    const declared = declaredHookPaths(MANIFEST) as HookPathEntry[]
    const eventsByScript = new Map<string, Set<string>>()
    for (const { event, rel } of declared) {
      if (!rel.endsWith('.mjs')) continue
      if (!eventsByScript.has(rel)) eventsByScript.set(rel, new Set())
      eventsByScript.get(rel)!.add(event)
    }

    const mismatches: Array<{ rel: string; declaredEvent: string; requiredEvent: string }> = []
    const skipped: string[] = []
    for (const [rel, events] of eventsByScript) {
      if (events.size !== 1) {
        // Registered under more than one event within plugin.json itself: a deliberate
        // multi-event hook (e.g. commit-signatures, verifier-cli-guard). Not this check's job.
        skipped.push(rel)
        continue
      }
      const declaredEvent = [...events][0]!
      const abs = join(PLUGIN_ROOT, rel.replace(/^\//, ''))
      expect(existsSync(abs), `declared hook path does not exist: ${abs}`).toBe(true)
      const source = readFileSync(abs, 'utf8')
      const requiredEvent = requiredEventOf(source)
      if (requiredEvent === null) {
        // The hook's own code states no single required event (relies on tool matcher alone,
        // or genuinely handles several) — cannot judge, so don't guess.
        skipped.push(rel)
        continue
      }
      if (requiredEvent !== declaredEvent) mismatches.push({ rel, declaredEvent, requiredEvent })
    }

    expect(mismatches, `plugin.json declares an event that the hook's own code refuses: ${JSON.stringify(mismatches)}`).toEqual([])
    // Sanity: the check actually examined a real, non-trivial set of hooks (not silently a no-op),
    // and at least one of them was actually judged rather than skipped.
    expect(eventsByScript.size).toBeGreaterThan(5)
    expect(eventsByScript.size - skipped.length).toBeGreaterThan(0)
  })
})
