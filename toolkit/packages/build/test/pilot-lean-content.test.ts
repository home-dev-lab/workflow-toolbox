import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PILOT = readFileSync(join(REPO_ROOT, 'plugin/agent-templates/pilot.md'), 'utf8')

// Source-text lock on purpose: the template is the normative deliverable.
describe('lean pilot template', () => {
  it('runs without the CLAUDE.md and rules prefix and reads the project instructions itself', () => {
    expect(PILOT).toMatch(/^omitClaudeMd: true$/m)
    expect(PILOT).toMatch(/Read the project's own instruction file[\s\S]{0,200}`CLAUDE\.md`[\s\S]{0,40}`AGENTS\.md`/)
  })
})
