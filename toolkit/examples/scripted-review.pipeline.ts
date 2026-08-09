// scripted-review.pipeline.ts — card #1837411179: the first pipeline conversion of REAL review
// work (not the "Reply with exactly: OK" proof pipelines) onto the external opencode lane.
//
// Shape: [review: 2 concurrent scripted lens calls]  -->  [judge: 1 scripted call]. This is the
// linear "produce claims -> judge them" half of pr-review-reduced-dag.js's own DAG (see that
// workflow's `run()`: N review-lens agents feeding ONE shared verifier) — the part of a review
// that genuinely has no branching, no per-item redundant voting, and no dynamic lens selection.
// It is NOT pr-review.js itself: that workflow classifies the change first (choosing its lens
// set at runtime) and adversarially verifies each claim with N-of-M redundant votes per finding
// — a shape a fixed linear stage list cannot express (see this card's own report for why).
// pr-review-reduced-dag.js is the honest analog because its lens set is fixed by `category` at
// call time and its shared verifier is ONE call, exactly the shape a pipeline stage list is.
//
// Synthesis (pr-review-reduced-dag's own deterministic `summarize()`) is folded into the SAME
// judge call here rather than a third stage: the judge is asked to emit `verdict` and `summary`
// alongside its per-finding verdicts. A separate scripted or workflow stage could do this
// instead (see the card report's "seams" section) — folding it in keeps this pipeline at
// exactly two stages, matching produce-then-judge with no extra hop.
//
// The diff under review is a REAL, already-merged, already-reviewed commit (ecdeee95, this same
// repo) — small enough to read end to end, real enough to produce genuine findings: it changes
// a user-facing report string, is duplicated across two committed bundle copies plus its
// TypeScript source, and ships a test-lock. It is embedded as author-time LITERAL TEXT
// (`{text: DIFF}` PromptPart) — deliberately, not as a workaround: a fixed choice of "which
// commit to review" is knowable when this spec is authored, so there is no seam to route around
// here. The genuine seam this card also documents (a RUN-TIME-produced value needed by a
// NON-ADJACENT later stage) does not arise in a 2-stage pipeline; see the report for the
// grounded, code-read finding on why it would in a 3-plus-stage one.
//
// ⚠ SEAM FOUND WHILE BUILDING THIS FILE, recorded on the card: a definePipeline() entry is
// bundled and evaluated as a standalone IIFE (mirrors defineWorkflow's own build step) with no
// Node builtins available — `readFileSync('node:fs')` at module scope fails the build
// ("Dynamic require of 'node:fs' is not supported"), even though tsx runs this file directly
// under Node when authoring it. A pipeline entry can therefore only carry literal text it
// builds ITSELF from plain TS/JS, never a value read from a companion file at build time. The
// diff below is a JSON.stringify'd string literal for exactly that reason (it also contains
// backticks and `${` sequences — being a diff of template-literal source — that a hand-escaped
// TS template literal would have had to escape by hand).
//
// Build: pnpm wt:pipeline examples/scripted-review.pipeline.ts (writes pipelines/scripted-review.json)
// Launch: POST /api/pipeline { spec: <the built JSON> } against the observe-ui server.

import { definePipeline } from '@workflow-toolbox/build/define-pipeline'

const DIFF: string = "commit ecdeee95d1fadacc1705d904855842d80458ea4f\nAuthor: Frederic Thomas <webdoublefx@gmail.com>\nDate:   Sun Aug 9 10:45:11 2026 +0100\n\n    debugger: stop naming a wrong cause for an absent transcript\n    \n    The per-transcript absent line rendered \"not captured (may have been pruned\n    by the >30-day cleanup)\" unconditionally, for any missing transcript file.\n    \n    The AuditReport carries no run timestamp, so that line cannot distinguish a\n    genuinely pruned transcript from one that never existed. Measured on a\n    minutes-old run: a scripted-stage call errored (opencode SQLite lock) before\n    writing anything, and the report told the reader a specific, plausible,\n    wrong cause for the absence.\n    \n    Names no cause now. The empty-list message is left as is: it already offers\n    both possibilities without picking one.\n    \n    The new lock asserts the property over EVERY absent line rather than the one\n    line this fix touched, and was proven red against the reinstated defect.\n    Committed debugger bins rebuilt (report-format is bundled into wt-stop-hook).\n\ndiff --git a/plugin/bin/wt-stop-hook.mjs b/plugin/bin/wt-stop-hook.mjs\nindex 6762a445..9e502d62 100644\n--- a/plugin/bin/wt-stop-hook.mjs\n+++ b/plugin/bin/wt-stop-hook.mjs\n@@ -1001,7 +1001,7 @@ function formatAuditReportMarkdown(r, ctx = {}) {\n   } else {\n     for (const t of r.transcripts) {\n       lines.push(\n-        t.present ? `- \\u2713 ${t.relativePath}` : `- \\u2717 ${t.relativePath} \\u2014 not captured (may have been pruned by the >30-day cleanup)`\n+        t.present ? `- \\u2713 ${t.relativePath}` : `- \\u2717 ${t.relativePath} \\u2014 not captured (no transcript file; cause not recorded)`\n       );\n     }\n   }\ndiff --git a/toolkit/bin/wt-stop-hook.mjs b/toolkit/bin/wt-stop-hook.mjs\nindex 6762a445..9e502d62 100644\n--- a/toolkit/bin/wt-stop-hook.mjs\n+++ b/toolkit/bin/wt-stop-hook.mjs\n@@ -1001,7 +1001,7 @@ function formatAuditReportMarkdown(r, ctx = {}) {\n   } else {\n     for (const t of r.transcripts) {\n       lines.push(\n-        t.present ? `- \\u2713 ${t.relativePath}` : `- \\u2717 ${t.relativePath} \\u2014 not captured (may have been pruned by the >30-day cleanup)`\n+        t.present ? `- \\u2713 ${t.relativePath}` : `- \\u2717 ${t.relativePath} \\u2014 not captured (no transcript file; cause not recorded)`\n       );\n     }\n   }\ndiff --git a/toolkit/packages/debugger/src/report-format.ts b/toolkit/packages/debugger/src/report-format.ts\nindex de04915f..310182f1 100644\n--- a/toolkit/packages/debugger/src/report-format.ts\n+++ b/toolkit/packages/debugger/src/report-format.ts\n@@ -244,7 +244,11 @@ export function formatAuditReportMarkdown(r: AuditReport, ctx: AuditFormatContex\n       lines.push(\n         t.present\n           ? `- ✓ ${t.relativePath}`\n-          : `- ✗ ${t.relativePath} — not captured (may have been pruned by the >30-day cleanup)`,\n+          // Deliberately names NO cause. The report has no run timestamp, so it cannot tell a\n+          // pruned transcript (>30-day cleanup) from one that never existed — an agent whose\n+          // call errored before writing anything leaves the same absence. Naming the cleanup\n+          // here told readers a specific, plausible, wrong cause on minutes-old runs.\n+          : `- ✗ ${t.relativePath} — not captured (no transcript file; cause not recorded)`,\n       )\n     }\n   }\ndiff --git a/toolkit/packages/debugger/test/report-format.test.ts b/toolkit/packages/debugger/test/report-format.test.ts\nindex 2dfbb29b..0d8f287e 100644\n--- a/toolkit/packages/debugger/test/report-format.test.ts\n+++ b/toolkit/packages/debugger/test/report-format.test.ts\n@@ -91,11 +91,29 @@ describe('formatAuditReportMarkdown — honest empty states', () => {\n     expect(md).toMatch(/no transcripts|pruned/i)\n   })\n \n-  it('marks each transcript present/absent with the cleanup note for absent ones', () => {\n+  it('marks each transcript present/absent', () => {\n     const md = formatAuditReportMarkdown(report())\n     expect(md).toContain('transcripts/agent-ac83de77485e77ad1.jsonl')\n     expect(md).toContain('transcripts/agent-a29e57ea76ae2941e.jsonl')\n-    expect(md).toMatch(/pruned|not captured/i)\n+    expect(md).toMatch(/not captured/i)\n+  })\n+\n+  // The report carries no run timestamp, so a per-transcript line CANNOT distinguish a pruned\n+  // transcript from one that never existed (the agent's call errored before writing). Naming\n+  // the >30-day cleanup on that line asserted a specific, wrong cause on minutes-old runs.\n+  // Lock the property over EVERY absent line, not the one line this fix happened to touch.\n+  it('names no cause on a per-transcript absent line', () => {\n+    const md = formatAuditReportMarkdown(\n+      report({\n+        transcripts: [\n+          { agentId: 'a1', relativePath: 'transcripts/agent-a1.jsonl', present: false },\n+          { agentId: 'a2', relativePath: 'transcripts/agent-a2.jsonl', present: false },\n+        ],\n+      }),\n+    )\n+    const absentLines = md.split('\\n').filter((l) => l.startsWith('- ✗ transcripts/'))\n+    expect(absentLines).toHaveLength(2)\n+    for (const line of absentLines) expect(line).not.toMatch(/prune|cleanup|30-day/i)\n   })\n })\n \n"

const LENSES = ['correctness', 'consistency'] as const

const REVIEW_INSTRUCTIONS = (lens: string): string =>
  `## Role\nYou are a specialized code reviewer for the "${lens}" lens, reviewing one real, ` +
  `already-committed diff.\n\n## Instructions\n- Read the diff below end to end.\n- Focus ONLY ` +
  `on the "${lens}" lens (${lens === 'correctness' ? 'does the change do what its own commit message and tests say it does, and are there edge cases it misses' : 'is the change applied consistently everywhere the same logic is duplicated'}).\n` +
  `- Cite the exact file and line for every finding.\n\n## Diff\n`

const JUDGE_INSTRUCTIONS =
  `## Role\nYou are the shared judge for a two-lens review. Two reviewers each produced ` +
  `findings on the SAME diff, independently.\n\n## Required constraints\n1. Judge each finding ` +
  `on its own, re-reading the diff below — do not trust a finding's own wording.\n2. A finding ` +
  `you cannot support from the diff itself is "unverifiable", never "confirmed".\n3. After ` +
  `judging every finding, produce ONE overall verdict for the whole diff: "approve" if every ` +
  `confirmed finding is minor/cosmetic, "request-changes" if any confirmed finding is ` +
  `substantive.\n\n## Diff\n`

const FINDINGS_INSTRUCTIONS =
  `\n\n## Output\nRespond with ONLY a single JSON object, no prose, no markdown fences: ` +
  `{"ok": true, "findings": [{"title": "...", "file": "...", "severity": "high|medium|low", "detail": "..."}]}. ` +
  `An empty "findings" array is a valid, honest answer if the lens found nothing.`

const JUDGE_OUTPUT_INSTRUCTIONS =
  `\n\n## Findings to judge (from both lenses, as raw scripted-stage call results)\n`

const JUDGE_TAIL =
  `\n\n## Output\nRespond with ONLY a single JSON object, no prose, no markdown fences: ` +
  `{"verdict": "approve" | "request-changes", "summary": "one paragraph", ` +
  `"verdicts": [{"title": "...", "verdict": "confirmed|refuted|unverifiable", "citation": "file:line", "rationale": "..."}]}.`

export default definePipeline({
  goal: 'Review a real, already-merged commit (ecdeee95) with two independent scripted lenses, then one shared scripted judge, entirely on the external opencode lane.',
  projectDir: '.',
  name: 'scripted-review',
  stages: [
    {
      name: 'review',
      scripted: {
        model: 'openai/gpt-5.4',
        // DISTINCT-PROMPT FAN: array length (2) IS the call count — one concurrent call per
        // lens, each its own ComposedPrompt (instructions + the literal diff + the shared
        // findings-output contract).
        prompt: LENSES.map((lens) => ({
          compose: [{ text: REVIEW_INSTRUCTIONS(lens) }, { text: DIFF }, { text: FINDINGS_INSTRUCTIONS }],
        })),
        resultShape: { fields: { ok: 'boolean' } },
      },
    },
    {
      name: 'judge',
      scripted: {
        model: 'openai/gpt-5.6-terra',
        // Single call, ComposedPrompt: judge instructions + the SAME literal diff (this stage
        // is not adjacent to nothing — it IS adjacent to `review`, but `review`'s handoff
        // artifact is the findings, not the diff, so the diff has to be re-supplied here as
        // its own literal part rather than reached via artifactContent) + the review stage's
        // aggregated findings (artifactContent: the ONE prior stage's handoff, all 2 calls'
        // results as JSON) + the verdict-output contract.
        prompt: {
          compose: [
            { text: JUDGE_INSTRUCTIONS },
            { text: DIFF },
            { text: JUDGE_OUTPUT_INSTRUCTIONS },
            { from: 'artifactContent' },
            { text: JUDGE_TAIL },
          ],
        },
        resultShape: { fields: { verdict: 'string' } },
      },
    },
  ],
})
