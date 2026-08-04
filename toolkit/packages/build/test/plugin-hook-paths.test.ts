// plugin-hook-paths.test.ts — every hook entry point the plugin manifest REGISTERS must exist
// on disk, and a renamed entry point must leave a working shim behind.
//
// WHY. A session's hook registration is a SNAPSHOT taken at session start. Rename a hook file
// and every session already running keeps spawning the old path; node then dies in the module
// loader before a single line of hook code runs, so the hook cannot even emit the plugin's own
// FAILED OPEN trace. The only visible symptom is a console line per tool call that names no
// hook at all.
//
// Measured 2026-08-04: 725 such failures inside one long-running session after
// `feat(plugin)!: rename adopt-rules to adopt` renamed wt-adopt-rules-check-hook.mjs. It took
// roughly an hour to attribute, because every reproduction attempt invoked the file that
// EXISTS while the failing invocation named the one that does not.
//
// The first test is the INVARIANT — over every hook the manifest declares, not over a list of
// names someone remembered to add. A manifest entry added tomorrow is covered without editing
// this file; an enumerating lock would go green the day a new hook is registered wrong.
//
// ⚠ HONEST SCOPE. This lock catches a manifest that points at a missing file. It does NOT and
// CANNOT catch the failure that motivated it — the rename commit updated the manifest and the
// file together, so a static check over one revision stays green while running sessions break.
// What closes that gap is the shim, and the second test is what keeps the shim honest. Saying
// so here because a reader who assumed the first test covered the incident would delete the
// shim as redundant.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const MANIFEST = join(PLUGIN_ROOT, '.claude-plugin/plugin.json')

type HookEntry = { command?: string }
type HookGroup = { matcher?: string; hooks?: HookEntry[] }

function declaredHookPaths(): { event: string; rel: string }[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    hooks?: Record<string, HookGroup[]>
  }
  const out: { event: string; rel: string }[] = []
  for (const [event, groups] of Object.entries(manifest.hooks ?? {})) {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        const match = /\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"'\s]+)/.exec(entry.command ?? '')
        if (match?.[1]) out.push({ event, rel: match[1] })
      }
    }
  }
  return out
}

describe('plugin manifest — every registered hook entry point resolves', () => {
  it('declares at least one hook (guards against a manifest that silently stopped parsing)', () => {
    // Without this, an extraction bug yields an empty list and the invariant below passes
    // vacuously — the check would report health precisely when it had measured nothing.
    expect(declaredHookPaths().length).toBeGreaterThan(0)
  })

  it('every ${CLAUDE_PLUGIN_ROOT} path in the manifest exists on disk', () => {
    const missing = declaredHookPaths()
      .filter(({ rel }) => !existsSync(join(PLUGIN_ROOT, rel)))
      .map(({ event, rel }) => `${event}: ${rel}`)
    expect(missing).toEqual([])
  })
})

describe('deprecated hook names keep a working shim for already-running sessions', () => {
  const OLD = join(PLUGIN_ROOT, 'bin/wt-adopt-rules-check-hook.mjs')
  const NEW = join(PLUGIN_ROOT, 'bin/wt-adopt-check-hook.mjs')
  const payload = JSON.stringify({
    session_id: 'test',
    cwd: REPO_ROOT,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: '' },
  })

  it('the deprecated path still exists', () => {
    expect(existsSync(OLD)).toBe(true)
  })

  it('produces the SAME stdout as the current hook, and says it is deprecated on stderr', () => {
    const shim = spawnSync(process.execPath, [OLD], { input: payload, encoding: 'utf8' })
    const current = spawnSync(process.execPath, [NEW], { input: payload, encoding: 'utf8' })
    // stdout is the hook's actual contract — what the session consumes. Comparing it to the
    // current hook's, rather than to a hard-coded string, means the shim cannot drift as the
    // real hook evolves.
    expect(shim.stdout).toBe(current.stdout)
    expect(shim.status).toBe(current.status)
    expect(shim.stderr).toContain('DEPRECATED')
    expect(shim.stderr).toContain('wt-adopt-check-hook.mjs')
  })
})
