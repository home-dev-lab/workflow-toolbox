// The opencode-verifier agent must run the CLI as the BARE WORD `opencode` (never `"$BIN"`) on the
// normal path: a permission allow rule is a literal prefix match on the command text, so
// `Bash(timeout 570 opencode run:*)` can cover `timeout 570 opencode run …` and can never cover a
// variable. Red on the 0.170.0 text (two `"$BIN" run` occurrences, zero bare-word run lines).
// Card 1858941475585262881.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..')
const FILES = ['plugin/agents/opencode-verifier.md', 'plugin/launch-agents/agents/opencode-verifier.md']

describe('opencode-verifier runs the CLI as the bare word opencode', () => {
  for (const rel of FILES) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    it(`${rel}: RED: never embeds a heredoc in the agent definition`, () => {
      expect(text).not.toContain("<<'EOF'")
    })
    it(`${rel}: invokes the stable verifier entrypoint`, () => {
      expect(text).toMatch(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/wt-opencode-verify\.mjs"/)
    })
    it(`${rel}: does not embed an opencode CLI run`, () => {
      expect(text).not.toMatch(/opencode run/)
    })
    it(`${rel}: the path-scan fallback is named as not coverable by an allow rule`, () => {
      expect(text).toMatch(/NOT coverable by an allow rule/)
    })
  }
})
