import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findUnlinkedReferences, listReferenceFiles } from '../skill-content-preservation.mjs'

const skillsRoot = fileURLToPath(new URL('../../../plugin/skills/', import.meta.url))
const skills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('shipped skill inventory', () => {
  it('discovers at least one shipped skill', () => {
    expect(skills.length).toBeGreaterThan(0)
  })
})

describe.each(skills)('%s on-demand skill contract', (name) => {
  const dir = join(skillsRoot, name)
  const body = readFileSync(join(dir, 'SKILL.md'), 'utf8')

  it('fits within 15000 UTF-16 code units', () => {
    expect(body.length, `${name}/SKILL.md exceeds 15000 characters`).toBeLessThanOrEqual(15000)
  })

  it('names every file in its references directory', () => {
    expect(findUnlinkedReferences(body, listReferenceFiles(dir))).toEqual([])
  })
})
