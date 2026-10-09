import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'

const root = resolve(import.meta.dirname, '../../../..')
const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as paths from '../../../../plugin/bin/lib/work-journal-paths.mjs'
describe('journal storage is unnamed on lane-readable surfaces', () => {
  it('covers existing project instructions, lane skill and agent templates, and scans future surfaces by construction', () => {
    expect(typeof paths.STORE_LEAF).toBe('string')
    expect(typeof paths.ARCHIVE_LEAF).toBe('string')
    const fixture = journalFixture(); fixtures.push(fixture)
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', env: fixture.env })
    expect(result.status).toBe(0)
    const removed = spawnSync('git', ['diff', '--diff-filter=D', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8', env: fixture.env })
    expect(removed.status).toBe(0)
    const deleted = new Set(removed.stdout.split('\0'))
    const files = result.stdout.split('\0').filter((file) => file && !deleted.has(file))
    for (const surface of ['CLAUDE.md', 'plugin/skills/external-lane/SKILL.md', 'plugin/agent-templates/pilot.md', 'plugin/agent-templates/pilot-orchestrator.md']) expect(files).toContain(surface)
    const hits = files.filter((file) => !file.includes('/test/') && file !== 'plugin/bin/lib/work-journal-paths.mjs')
      .filter((file) => [paths.STORE_LEAF, paths.ARCHIVE_LEAF].some((leaf) => leaf && readFileSync(resolve(root, file), 'utf8').includes(leaf)))
    expect(hits).toEqual([])
  })
})
