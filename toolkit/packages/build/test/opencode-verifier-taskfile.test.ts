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

      it('makes the 429 retry a self-contained re-do that re-writes its own task file (the trap deletes the first one on exit)', () => {
        // Guards the retry regression a trap-cleaned cwd file would otherwise cause: the
        // step-6 retry must re-write the task content in its own invocation, not point at
        // the already-deleted first file. The phrase appears in both step 3 and step 6.
        const occurrences = def.split('re-write the SAME task content').length - 1
        expect(occurrences).toBeGreaterThanOrEqual(2)
      })

      // TEST-LOCK — DIRECT-READS opt-in mode (card #1825742346935862950) and the
      // cross-family-review coherence fixes (codex gpt-5.6-terra): F1 the inline
      // fallback result is NOT "final", F2 a post-fallback 429 retry stays INLINE,
      // F3 the external_directory refusal predicate is ILLUSTRATIVE (non-exhaustive).
      it('carries the DIRECT-READS opt-in signal and its paths-first task-file heading', () => {
        expect(def).toContain('OPENCODE_DIRECT_READS: yes')
        expect(def).toContain('### files to read (read them yourself)')
      })

      it('routes a direct-reads permission refusal to a ONE-shot inline fallback that keeps the mode INLINE for any later 429 retry (review F2)', () => {
        expect(def).toContain('INLINE mode for the remainder of this call')
      })

      it('does NOT declare the inline fallback result exempt from the 429 rule (review F1 — no "result is final" contradiction)', () => {
        expect(def).not.toContain('after which its result is final')
      })

      it('specifies the external_directory refusal predicate as ILLUSTRATIVE, not an exact/ordered match (review F3)', () => {
        expect(def).toMatch(/ILLUSTRATIVE, NOT a required exact match/)
      })

      // TEST-LOCK — revised 3-tier design (card #1825742346935862950): native reads are
      // PREFERRED (cd into the target makes it opencode's workspace, no config needed);
      // OPENCODE_WORKDIR is the primary redirect, AUTO sub-$PWD the default, DIRECT_READS
      // the config-dependent secondary. Closes the 16/07 worktree-blind failure class.
      it('carries the OPENCODE_WORKDIR primary redirect and the AUTO sub-$PWD default', () => {
        expect(def).toContain('OPENCODE_WORKDIR')
        expect(def).toContain('safe, no-signal default')
      })

      it('runs the OPENCODE_WORKDIR cd chained-first as the safe `cd -- "$WORKDIR" &&`, with TASKFILE resolved AFTER it', () => {
        // Safe form (review v2 M3): single-quoted assignment + `cd -- "$WORKDIR" &&`
        // (`--` guards a leading-dash path, quotes guard spaces, `&&` aborts on failure).
        // TASKFILE ($PWD/.oc-verify-$$.md) resolves AFTER the cd so it lands in the workdir.
        expect(def).toContain('cd -- "$WORKDIR" &&')
        expect(def).toContain('resolve `TASKFILE` AFTER it')
      })

      it('fixes ONE effective working directory that OPENCODE_WORKDIR supersedes, and classifies by resolving to absolute first (review v2 M1/M2)', () => {
        expect(def).toContain('SINGLE effective working directory')
        expect(def).toContain('SUPERSEDES your inherited')
        expect(def).toContain('resolve the path to an ABSOLUTE path first')
      })
    })
  }
})
