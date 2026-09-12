import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = fileURLToPath(new URL('.', import.meta.url))
const packsDir = resolve(testDir, '../../../../plugin/packs')
const requiredHeadings = [
  '## What this pack ships',
  '## Language server',
  '## Probe',
  '## Cross-platform verdict',
  '## Optional assets',
]

function assertRequiredHeadings(file: string, label: string) {
  const source = readFileSync(file, 'utf8')
  let previous = -1
  for (const heading of requiredHeadings) {
    const match = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(source)
    const index = match ? match.index : -1
    expect(index, `${label} is missing required heading ${heading}`).toBeGreaterThanOrEqual(0)
    expect(index, `${label} has required heading out of order: ${heading}`).toBeGreaterThan(previous)
    previous = index
  }
}

describe('pack README required sections', () => {
  it('requires every manifest-bearing pack README to carry the ordered headings', () => {
    const packs = readdirSync(packsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(packsDir, entry.name, 'pack.json')))
      .map((entry) => entry.name)
      .sort()

    expect(packs, 'plugin/packs must contain at least one manifest-bearing pack').not.toEqual([])
    for (const pack of packs) assertRequiredHeadings(join(packsDir, pack, 'README.md'), `pack ${pack}`)
  })

  it('requires the reusable README template to carry the ordered headings', () => {
    assertRequiredHeadings(join(packsDir, 'README-TEMPLATE.md'), 'plugin/packs/README-TEMPLATE.md')
  })
})
