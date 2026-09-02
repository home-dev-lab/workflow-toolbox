// rules-rationale-split.test.ts — verbatim-preservation gate over the shipped-rules cut.
//
// The 13 shipped rules under plugin/rules/wt-*.md were split so dated field cases and
// hook-enforced sections move VERBATIM to plugin/docs/rules-rationale/<rule>.md, leaving one
// pointer line per cut section in the rule. This gate proves that split lost nothing: every
// non-blank line of each rule's PRE-CUT content (frozen at BASELINE_SHA, the commit these
// rules last held their full text) appears in exactly one of {current rule, current doc} —
// never missing, never duplicated — and that no cut fell mid-paragraph (a wrapped sentence
// split across the two files).
//
// Ported, same algorithm, from the one-off `~/.claude/docs/prefix-ab/verify-split.py` used for
// the private-rule pass of 2026-09-02.
//
// The baseline is a COMMITTED FIXTURE FILE per rule (fixtures/rules-rationale-baseline/<rule>.md),
// a frozen byte-for-byte copy of the rule's pre-cut content — never a git ref. `git show <sha>`
// was the first design and it is WRONG for CI: this repo's cross-OS workflow checks out with the
// default `fetch-depth: 1` (only `signatures.yml` uses a full clone), so a shallow clone has no
// history at all and `git show` on any ancestor commit fails immediately on every OS runner, not
// just after `main` moves past the fork point. A committed fixture has no such dependency — it
// reads exactly like any other test asset, on a shallow clone or a full one.
//
// This is a PERMANENT lock: new content added to a rule after the cut is unconstrained (absent
// from the frozen baseline, so never flagged); but no line that existed in the baseline may ever
// be dropped from BOTH the rule and its rationale doc again — it must keep living in one of the
// two.
//
// Remedy on failure: a MISSING line was dropped by an edit to the rule or the doc — restore it
// verbatim to whichever file lost it. A BOTH line is now duplicated between rule and doc —
// remove it from one. A MID-PARAGRAPH split means a wrapped paragraph got cut across the two
// files — move the whole paragraph to one side.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/rules-rationale-baseline', import.meta.url))

const RULE_NAMES = [
  'wt-delegation-ladder',
  'wt-answer-first-reporting',
  'wt-memory-hygiene',
  'wt-proportionate-verification',
  'wt-verify-by-ground-truth',
  'wt-checkpoint-and-compaction',
  'wt-task-tracking',
  'wt-durable-fix-at-the-right-level',
  'wt-concurrent-sessions-worktree',
  'wt-proactive-decision-making',
  'wt-step-back-architectural',
  'wt-workflows-as-reasoning',
  'wt-propose-dont-affirm',
]

interface SplitResult {
  missing: string[]
  both: string[]
  splits: Array<[string, string]>
}

/** Count non-blank lines, preserving one Counter per distinct line. */
function nonBlankCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

function verifySplit(origText: string, ruleText: string, docText: string): SplitResult {
  const orig = origText.split('\n')
  const O = nonBlankCounts(origText)
  const R = nonBlankCounts(ruleText)
  const T = nonBlankCounts(docText)

  const missing: string[] = []
  for (const [line, n] of O) {
    const have = (R.get(line) ?? 0) + (T.get(line) ?? 0)
    if (have < n) missing.push(line)
  }

  const both: string[] = []
  for (const [line, n] of O) {
    if (n === 1 && (R.get(line) ?? 0) > 0 && (T.get(line) ?? 0) > 0 && !line.trimStart().startsWith('#')) {
      both.push(line)
    }
  }

  const inRule = new Set(R.keys())
  const inDoc = new Set(T.keys())
  const splits: Array<[string, string]> = []
  for (let i = 0; i < orig.length - 1; i++) {
    const a = orig[i] ?? ''
    const b = orig[i + 1] ?? ''
    if (!a.trim() || !b.trim()) continue
    const bTrim = b.trimStart()
    if (bTrim.startsWith('-') || bTrim.startsWith('*') || bTrim.startsWith('|') || bTrim.startsWith('#') || bTrim.startsWith('>') || bTrim.startsWith('```')) continue
    if (a.trimStart().startsWith('<!--') || bTrim.startsWith('<!--')) continue
    const sa = inRule.has(a) ? 'rule' : inDoc.has(a) ? 'doc' : null
    const sb = inRule.has(b) ? 'rule' : inDoc.has(b) ? 'doc' : null
    if (sa && sb && sa !== sb) {
      const aTrimEnd = a.trimEnd()
      const endsSentence = ['.', '!', '?', ':', '|', '`', ')', '*', '»'].some((ch) => aTrimEnd.endsWith(ch))
      if (!endsSentence) splits.push([a, b])
    }
  }

  return { missing, both, splits }
}

describe('rules-rationale-split (shipped-rules cut, 2026-09-02)', () => {
  for (const name of RULE_NAMES) {
    it(`${name}: every baseline line survives in exactly one of {rule, doc}, no mid-paragraph split`, () => {
      const origText = readFileSync(join(FIXTURES_DIR, `${name}.md`), 'utf8')
      const ruleText = readFileSync(join(REPO_ROOT, 'plugin/rules', `${name}.md`), 'utf8')
      const docText = readFileSync(join(REPO_ROOT, 'plugin/docs/rules-rationale', `${name}.md`), 'utf8')

      const { missing, both, splits } = verifySplit(origText, ruleText, docText)

      expect(missing, `missing lines (dropped from both rule and doc): ${missing.slice(0, 5).join(' | ')}`).toHaveLength(0)
      expect(both, `duplicated lines (present in both rule and doc): ${both.slice(0, 5).join(' | ')}`).toHaveLength(0)
      expect(
        splits,
        `mid-paragraph splits: ${splits.slice(0, 3).map(([a, b]) => `"${a.slice(0, 40)}" || "${b.slice(0, 40)}"`).join(' ; ')}`,
      ).toHaveLength(0)
    })
  }
})
