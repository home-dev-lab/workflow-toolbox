import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const plugin = join(root, 'plugins', 'wt-rules-on-demand')
function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (entry.isFile()) yield path
  }
}
describe('shipped rules-on-demand', () => {
  it('runs dependency-free Node tests', () => {
    const run = spawnSync(process.execPath, ['--test'], { cwd: plugin, encoding: 'utf8' })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
  })
  it('contains no private data or machine path', () => {
    const forbidden = ['.claude-work', 'planka', 'atrium', 'embedded-rules']
    const hits: string[] = []
    for (const file of files(plugin)) {
      const content = readFileSync(file, 'utf8')
      if (content.includes(homedir()) || /(?<!\d)\d{19}(?!\d)/.test(content) || forbidden.some((word) => content.toLowerCase().includes(word))) hits.push(relative(root, file))
    }
    expect(hits).toEqual([])
  })
})
