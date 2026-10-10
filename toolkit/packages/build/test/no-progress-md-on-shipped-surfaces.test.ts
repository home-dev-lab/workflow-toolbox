import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { journalFixture } from './fixtures/work-journal.js'

const root = resolve(import.meta.dirname, '../../../..')
const fixtures: ReturnType<typeof journalFixture>[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })
describe('retired Markdown task file stays retired on shipped surfaces', () => {
  it('scans every tracked surface, allowing only history, tests and migration implementation', () => {
    const fixture = journalFixture(); fixtures.push(fixture)
    const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', env: fixture.env })
    expect(result.status).toBe(0)
    const removed = spawnSync('git', ['diff', '--diff-filter=D', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8', env: fixture.env })
    expect(removed.status).toBe(0)
    const deleted = new Set(removed.stdout.split('\0'))
    const files = result.stdout.split('\0').filter((file) => file && !deleted.has(file))
    expect(files.length).toBeGreaterThan(200)
    const hits = files.filter((file) => !file.includes('/test/') && file !== 'plugin/CHANGELOG.md'
      && !/^plugin\/bin\/(?:wt-work-journal(?:-hook)?\.mjs|lib\/(?:host\/)?work-journal[^/]*\.mjs)$/.test(file))
      .filter((file) => readFileSync(resolve(root, file), 'utf8').includes('progress.md'))
    expect(hits).toEqual([])
  })
})
