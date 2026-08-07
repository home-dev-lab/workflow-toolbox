import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const AGENT_TEMPLATES_DIR = join(REPO_ROOT, 'plugin/agent-templates')
const HOME_ANCHORED_PATH = /~\/\.claude\/|~\/projects\/|\/(?:home|Users)\/[^/\s`'"<>]+\//

describe('agent templates', () => {
  it('never reference a maintainer-home path', () => {
    for (const file of readdirSync(AGENT_TEMPLATES_DIR)) {
      const template = readFileSync(join(AGENT_TEMPLATES_DIR, file), 'utf8')
      expect(template, `${file} references a path outside the plugin`).not.toMatch(HOME_ANCHORED_PATH)
    }
  })
})
