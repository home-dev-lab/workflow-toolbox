import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..')
const FILES = ['plugin/agents/opencode-verifier.md', 'plugin/launch-agents/agents/opencode-verifier.md']

describe('opencode-verifier unavailable Bash fallback', () => {
  for (const rel of FILES) {
    it(`${rel}: returns only the degraded marker when its availability probe cannot run`, () => {
      const text = readFileSync(join(ROOT, rel), 'utf8')

      expect(text).toMatch(/If Bash is not an available callable tool, your complete final response is exactly this unformatted one line and nothing else/)
      expect(text).toMatch(/Do NOT simulate the probe, print a shell script or command block, describe what you would run/)
      expect(text).toMatch(/A tool listed in this definition but not delivered to your actual session is unavailable/)
      expect(text).toMatch(/If a Bash invocation for the step-1 availability probe errors/)
      expect(text).toMatch(/return exactly `OPENCODE_UNAVAILABLE: Bash probe unavailable` as your ENTIRE final answer and STOP/)
      expect(text).toMatch(/Do not explain the missing or failed tool, answer the task, or add any other text/)
      expect(text).toMatch(/OPENCODE_UNAVAILABLE: Bash probe unavailable\nSTOP immediately/)
      expect(text).toMatch(/response must not contain a backtick character/)
      expect(text).toMatch(/one unformatted line, with no Markdown, heading, bold text, backticks, blank line, explanation, or second sentence/)
      expect(text).toMatch(/FINAL REMINDER:.*emit only the plain-text line specified above/)
    })
  }
})
