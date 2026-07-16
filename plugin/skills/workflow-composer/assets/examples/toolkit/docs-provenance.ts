// docs-provenance.ts — the committed doc ↔ source provenance map (Tier 2 of the
// doc-alignment defence; Tier 1 is packages/build/test/docs-contract.test.ts).
//
// Each entry says: "these SOURCE modules are DESCRIBED BY these doc surfaces".
// pr-review consumes it mechanically: when the reviewed diff touches a mapped
// source (prefix match on the Route stage's changedFiles), it appends a
// `docs-alignment` reviewer lens scoped to the mapped surfaces — LLM judgment
// for the prose the mechanical Tier 1 anchors cannot check.
//
// Maintenance contract:
// - Paths are repo-relative (repo root, not toolkit/). `sources` entries are
//   PREFIXES (a directory prefix maps the whole subtree).
// - The manifest is validated by examples/test/docs-provenance.test.ts: a
//   source prefix matching zero files, or a doc path that no longer exists,
//   fails the suite LOUDLY — fix the manifest in the same change that moved
//   the file.
// - When you add a doc surface that explains a module's behavior, add the pair
//   here in the same commit. Over-mapping is cheap (one extra reviewer prompt
//   line); under-mapping silently skips the lens.

export interface ProvenanceEntry {
  /** Repo-relative path prefixes of the implementation this entry covers. */
  readonly sources: readonly string[]
  /** Repo-relative doc surfaces that describe those sources. */
  readonly docs: readonly string[]
}

export const DOCS_PROVENANCE: readonly ProvenanceEntry[] = [
  {
    // AgentType probing + the leaf fence + lean routing (availability gates,
    // probe prompts, graceful degradation semantics).
    sources: [
      'toolkit/packages/patterns/src/probe-agent-type.ts',
      'toolkit/packages/patterns/src/leaf-fence.ts',
      'toolkit/packages/patterns/src/lean-routing.ts',
      'plugin/agents/',
    ],
    docs: [
      'plugin/skills/workflow-composer/references/model-and-agent-routing.md',
      'plugin/skills/workflow-composer/SKILL.md',
    ],
  },
  {
    // The nine patterns + the result envelope (options, caps, envelope shape,
    // pattern count claims).
    sources: ['toolkit/packages/patterns/src/'],
    docs: [
      'plugin/skills/workflow-composer/references/patterns.md',
      'toolkit/README.md',
      'README.md',
    ],
  },
  {
    // Digest + prompt-tag wire protocols (what the observatory parses; the
    // reload-only semantics known-issues documents).
    sources: [
      'toolkit/packages/runtime/src/digest.ts',
      'toolkit/packages/runtime/src/prompt-tag.ts',
    ],
    docs: [
      'docs/public/known-issues.md',
      'plugin/skills/workflow-composer/references/observing-runs.md',
    ],
  },
  {
    // Runtime contract: sandbox typings, model/effort aliases, BEST_MODEL.
    sources: [
      'toolkit/packages/runtime/src/types.ts',
      'toolkit/packages/runtime/src/constants.ts',
      'toolkit/packages/runtime/src/with-agent-defaults.ts',
    ],
    docs: [
      'plugin/skills/workflow-composer/references/model-and-agent-routing.md',
      'plugin/skills/workflow-composer/references/api-reference.md',
    ],
  },
  {
    // Workflow linter rules + size cap (what "compliant artifact" means).
    sources: ['toolkit/packages/build/src/lint.ts'],
    docs: [
      'plugin/skills/workflow-composer/references/api-reference.md',
      'CLAUDE.md',
    ],
  },
  {
    // defineWorkflow / bundler / CLI (the authoring pipeline and its contract).
    sources: [
      'toolkit/packages/build/src/define-workflow.ts',
      'toolkit/packages/build/src/bundle.ts',
      'toolkit/packages/build/src/cli.ts',
    ],
    docs: [
      'plugin/skills/workflow-composer/SKILL.md',
      'toolkit/README.md',
      'README.md',
    ],
  },
  {
    // Orchestrator pipelines (definePipeline / bundlePipeline / PipelineSpec).
    sources: [
      'toolkit/packages/build/src/define-pipeline.ts',
      'toolkit/packages/build/src/bundle-pipeline.ts',
      'toolkit/packages/pipeline-spec/',
    ],
    docs: ['plugin/skills/workflow-composer/references/orchestrator-pipelines.md'],
  },
  {
    // Scaffold emitter (what `wt:scaffold` generates, PATTERN_NAMES).
    sources: ['toolkit/packages/scaffold/src/'],
    docs: [
      'plugin/skills/toolkit-scaffold/SKILL.md',
      'plugin/skills/workflow-composer/SKILL.md',
    ],
  },
  {
    // Run forensics (journal/transcript parsing, tool-denial detection).
    sources: ['toolkit/packages/debugger/src/'],
    docs: [
      'plugin/skills/workflow-debugger/SKILL.md',
      'docs/public/known-issues.md',
    ],
  },
  {
    // Smoke / canaries (the upgrade re-verification story).
    sources: ['toolkit/packages/smoke/src/'],
    docs: ['plugin/skills/upgrade-canary/SKILL.md'],
  },
  {
    // The pr-review composition itself (its worked example + the shipped list).
    sources: ['toolkit/examples/pr-review.workflow.ts'],
    docs: [
      'plugin/skills/workflow-composer/references/worked-example-pr-review.md',
      'plugin/skills/workflow-composer/references/shipped-compositions.md',
    ],
  },
  {
    // Every other shipped composition (the catalog doc + the dev-workflow story).
    sources: ['toolkit/examples/'],
    docs: [
      'plugin/skills/workflow-composer/references/shipped-compositions.md',
      'docs/public/dev-workflow.md',
    ],
  },
  {
    // wt-comm v0: the file-message protocol between escalating agents, the pilot, and
    // the (v0 read-only) observer/relay.
    sources: ['toolkit/packages/comm/src/'],
    docs: [
      'toolkit/packages/comm/README.md',
      'toolkit/packages/comm/teaching/wt-comm-participant.md',
    ],
  },
]

/** The doc surfaces mapped to any of `changedFiles` (repo-relative), deduped,
 *  in manifest order. Empty array = no mapped module touched → the caller
 *  skips the docs-alignment lens. Pure path matching — no fs access, safe
 *  inside the workflow sandbox. Matching semantics: an entry ending in '/'
 *  covers its whole subtree; any other entry is an EXACT file path — never a
 *  string prefix, so a same-stem sibling (`lint.tsx` vs the mapped `lint.ts`)
 *  cannot false-trigger the lens (review finding, run wf_0decbfe8-7e4).
 *  `manifest` defaults to the bundled DOCS_PROVENANCE (dwt paths); pr-review's
 *  launch-time `provenance` knob passes an external repo's manifest here — it
 *  REPLACES the bundled one for the whole match (never merged). */
export function docsForChangedFiles(
  changedFiles: readonly string[],
  manifest: readonly ProvenanceEntry[] = DOCS_PROVENANCE,
): string[] {
  const out: string[] = []
  for (const entry of manifest) {
    const touched = changedFiles.some((f) =>
      entry.sources.some((source) =>
        source.endsWith('/') ? f.startsWith(source) : f === source,
      ),
    )
    if (!touched) continue
    for (const doc of entry.docs) if (!out.includes(doc)) out.push(doc)
  }
  return out
}
