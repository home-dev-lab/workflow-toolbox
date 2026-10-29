import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const skillDir = fileURLToPath(new URL('../../../plugin/skills/adopt/', import.meta.url))

it('keeps the moved account-level prerequisites linked and intact', () => {
  const body = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  expect(body).toContain('(references/environment-prerequisites.md)')
  const reference = readFileSync(join(skillDir, 'references/environment-prerequisites.md'), 'utf8')
  expect(reference).toContain('## Account-level environment prerequisites')
})
