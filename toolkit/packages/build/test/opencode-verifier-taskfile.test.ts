// opencode-verifier-taskfile.test.ts — TEST-LOCK for card #1823504956762621933 (defect #1).
//
// Defect: the opencode-verifier bridge wrote its task file to /tmp/oc-verify-$$.md. On a
// large diff the opencode `--agent plan` gate auto-rejects the paginated RE-READ of that
// file as `external_directory` (the gate governs read/glob/grep AND bash commands that
// reference an external path) → the verdict is silently never produced (pass UNVERIFIED).
//
// Fix: write the task file INSIDE the agent cwd (opencode's working directory) as
// $PWD/.oc-verify-$$.md and clean it up (trap) in the same single Bash invocation, so every
// read of the attached file stays internal and can be paged through in full.
//
// This locks the DEFINITION content on BOTH in-repo copies (the byte-identity gate in
// launch-agents-identity.test.ts keeps them in sync, but this asserts the invariant directly
// on each so the defect can never re-appear on either path).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const DEF_COPIES = [
  join(REPO_ROOT, 'plugin/agents/opencode-verifier.md'),
  join(REPO_ROOT, 'plugin/launch-agents/agents/opencode-verifier.md'),
]

describe('opencode-verifier bridge — task file lives under the agent cwd, not /tmp', () => {
  for (const path of DEF_COPIES) {
    const rel = path.slice(REPO_ROOT.length)
    describe(rel, () => {
      const def = readFileSync(path, 'utf8')

      it('never routes the task file through /tmp/oc-verify (the external_directory defect)', () => {
        // The exact defect string, in the step-3 heredoc target and the step-5 -f argument.
        expect(def).not.toContain('/tmp/oc-verify')
      })

      it('resolves the task file inside the working directory ($PWD/.oc-verify-$$.md)', () => {
        expect(def).toContain('TASKFILE="$PWD/.oc-verify-$$.md"')
      })

      it('passes the cwd-internal task file to opencode via -f "$TASKFILE"', () => {
        expect(def).toContain('-f "$TASKFILE"')
      })

      it('cleans the task file up in-invocation so nothing is left in the repo', () => {
        expect(def).toContain(`trap 'rm -f "$TASKFILE"' EXIT`)
      })

      it('documents WHY (the external_directory gate) so the cwd rule is not lost', () => {
        expect(def).toContain('external_directory')
      })
    })
  }
})
