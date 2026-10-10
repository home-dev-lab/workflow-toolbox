import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The work journal's recording hooks are retired: nothing records to it any more, and its CLI only
// reads, verifies, restores and exports an existing journal. Claude Code loads plugin hooks from both
// the manifest `hooks` key and `hooks/hooks.json`, so both sources are checked, in every event.
const PLUGIN_ROOT = fileURLToPath(new URL('../../../../plugin', import.meta.url))
const SOURCES = [join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), join(PLUGIN_ROOT, 'hooks/hooks.json')]

type HookGroup = { hooks?: Array<{ command?: string }> }

function registrations(file: string): Array<{ event: string; command: string }> {
  if (!existsSync(file)) return []
  const hooks = (JSON.parse(readFileSync(file, 'utf8')) as { hooks?: unknown }).hooks
  if (!hooks || typeof hooks !== 'object') return []
  return Object.entries(hooks as Record<string, HookGroup[]>).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => (group.hooks ?? []).map((hook) => ({ event, command: hook.command ?? '' }))))
}

describe('retired work journal', () => {
  it('reads at least one registered hook, so an empty read cannot pass', () => {
    expect(SOURCES.flatMap(registrations).length).toBeGreaterThan(0)
  })

  it('registers no wt-work-journal-hook in any event of any plugin hook source', () => {
    const journal = SOURCES.flatMap(registrations).filter((entry) => entry.command.includes('wt-work-journal-hook'))
    expect(journal).toEqual([])
  })

  it('ships no recording hook script any more', () => {
    expect(existsSync(join(PLUGIN_ROOT, 'bin/wt-work-journal-hook.mjs'))).toBe(false)
  })
})
