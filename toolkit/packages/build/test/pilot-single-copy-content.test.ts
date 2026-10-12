import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

const WATCHDOGS = ['pilot-watchdog', 'pilot-orchestrator-watchdog'] as const
const PAIRING_TEXTS = [
  'plugin/agent-templates/pilot-watchdog.md',
  'plugin/agent-templates/pilot-orchestrator-watchdog.md',
  'plugin/agent-templates/pilot-orchestrator.md',
  'plugin/skills/pilot-wave/SKILL.md',
  'plugin/skills/pilot-wave/references/compose-the-spawn-prompt.md',
  'plugin/skills/adopt/SKILL.md',
  'plugin/skills/adopt/references/what-gets-installed.md',
] as const

// Source-text locks on purpose: these definitions and skills are the normative deliverable.
describe('one adopted copy of each pilot agent, wherever it lives', () => {
  it('lets a lean watchdog read project-specific tells from a project file', () => {
    for (const name of WATCHDOGS) {
      const text = read(`plugin/agent-templates/${name}.md`)
      expect(text, name).toContain(`.claude/watchdog-tells/${name}.md`)
      expect(text, name).toMatch(/absent[\s\S]{0,80}table above is complete/)
    }
  })

  it('no longer claims the pairing needs a PROJECT copy', () => {
    for (const rel of PAIRING_TEXTS) {
      const text = read(rel)
      expect(text, rel).not.toMatch(/pairs only when both files are project `\.claude\/agents\/`/)
      expect(text, rel).not.toMatch(/The pairing works only when\s+`pilot\.md` \+ `pilot-watchdog\.md` live in the project's `\.claude\/agents\/`/)
    }
  })

  it('resolves an adopted pilot from the project or the user config dir', () => {
    for (const rel of ['plugin/skills/pilot-wave/SKILL.md', 'plugin/skills/pilot-wave/references/compose-the-spawn-prompt.md']) {
      expect(read(rel), rel).toMatch(/Resolution rule[\s\S]{0,400}config dir's `agents\/`/)
    }
  })
})
