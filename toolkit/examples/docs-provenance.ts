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

export interface PluginBinDocDecision {
  /** Repo-relative shipped executable path under plugin/bin/. */
  readonly script: `plugin/bin/${string}.mjs`
  /** How this shipped executable is accounted for in the doc inventory. */
  readonly status: 'mapped' | 'exempt' | 'missing-doc-surface'
  /** One-line reason for the recorded outcome. */
  readonly reason: string
}

export interface PluginBinCoverageAudit {
  /** Shipped plugin/bin scripts with neither a manifest mapping nor a recorded outcome. */
  readonly unclassified: readonly string[]
  /** Recorded decisions whose script path is not a shipped plugin/bin executable. */
  readonly unknownRecordedScripts: readonly string[]
  /** Duplicate decision entries for the same shipped script. */
  readonly duplicateRecordedScripts: readonly string[]
  /** Scripts recorded as mapped but absent from the docs-provenance manifest. */
  readonly mappedWithoutManifest: readonly string[]
  /** Scripts recorded as exempt/missing but ALSO mapped in the manifest. */
  readonly nonMappedDecisionsWithManifestEntry: readonly string[]
  /** Exact plugin/bin manifest entries lacking a matching `mapped` decision. */
  readonly manifestScriptsWithoutMappedDecision: readonly string[]
}

export const PLUGIN_BIN_DOC_DECISIONS: readonly PluginBinDocDecision[] = [
  {
    script: 'plugin/bin/wt-actionable-gate-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the shipped Stop gate and its snapshot contract.',
  },
  {
    script: 'plugin/bin/wt-actionable-snapshot-producer-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the shipped Planka producer and what it deliberately stays silent on.',
  },
  {
    script: 'plugin/bin/wt-label-intent-producer-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the shipped label-intent-lens producer, its trigger, and what it deliberately stays silent on.',
  },
  {
    script: 'plugin/bin/wt-adopt-check-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this SessionStart adoption-state notice under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-adopt-rules-check-hook.mjs',
    status: 'mapped',
    reason:
      'Deprecated name kept as a shim delegating to wt-adopt-check-hook.mjs, so sessions already running when the rename landed keep the hook; same doc surface as its target. Remove one release after the rename.',
  },
  {
    script: 'plugin/bin/wt-lane-saturation-hook.mjs',
    status: 'mapped',
    reason:
      'Known-issues documents this PreToolUse external-lane contention guard (deny-by-default as of 0.118.0) under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-env-prerequisite-drift-hook.mjs',
    status: 'mapped',
    reason:
      'Known-issues documents this SessionStart post-adoption environment-drift light under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-arc-watch.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this monitor and its terminal-state output contract under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-autonomy-arm.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this mandate-declaration CLI, its per-session marker and its deliberate not-a-hook shape under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-autonomy-watch.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this monitor, its mandate gate, and its once-per-idle-stretch wake contract under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-check-commit-signatures-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this dual PostToolUse/PreToolUse commit-signature gate under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-check-commit-signatures.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this standalone CLI and its exit-code contract under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-check-observer-pairing.mjs',
    status: 'mapped',
    reason: 'Wave-fidelity checker docs tell operators to run and interpret this CLI.',
  },
  {
    script: 'plugin/bin/wt-debug.mjs',
    status: 'mapped',
    reason: 'Public debugger CLI described in the README, architecture, toolkit docs, and debugger skill docs.',
  },
  {
    script: 'plugin/bin/wt-delegation-ladder-hook.mjs',
    status: 'mapped',
    reason: 'README and plugin docs describe the shipped SessionStart delegation-ladder injection.',
  },
  {
    script: 'plugin/bin/wt-hook-registration-drift-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this SessionStart/UserPromptSubmit stale-registration detector under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-lane-consent-gate-hook.mjs',
    status: 'mapped',
    reason:
      'Known-issues documents this PreToolUse external-lane consent gate (fail-closed on unreadable settings and on its own internal errors) under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-lane-consent-check-hook.mjs',
    status: 'exempt',
    reason: 'A disagreement detector for wt-lane-consent.mjs (mapped) with no user-facing invocation contract of its own — it only ever surfaces a SessionStart notice when the resolved consent state disagrees with itself; the CLI it complements is the operative surface a reader is pointed at (see the pilot-wave DOCS_PROVENANCE entry).',
  },
  {
    script: 'plugin/bin/wt-lane-consent-check.mjs',
    status: 'exempt',
    reason: 'Same disagreement-detector role as its hook sibling, standalone: it audits for drift against wt-lane-consent.mjs (mapped) and has no independent invocation contract that a reader would look up on its own.',
  },
  {
    script: 'plugin/bin/wt-lane-consent.mjs',
    status: 'mapped',
    reason: 'The pilot-wave skill documents this CLI as the way to read and change the executor-lane consent switch.',
  },
  {
    script: 'plugin/bin/wt-lane-postdiff-check.mjs',
    status: 'mapped',
    reason: 'Pilot docs point operators to this snapshot/check pair after every executor-lane call, to flag files touched outside the brief.',
  },
  {
    script: 'plugin/bin/wt-lane-activity.mjs',
    status: 'mapped',
    reason: 'Pilot orchestrator docs tell operators to run this reader, right after wt-lane-probe.mjs, to see the current sub-task, tokens/model, and stall verdict of a lane wt-lane-probe reports active.',
  },
  {
    script: 'plugin/bin/wt-lane-probe.mjs',
    status: 'mapped',
    reason: 'Pilot orchestrator docs tell operators to run this probe to verify executor routing.',
  },
  {
    script: 'plugin/bin/wt-lesson-harvest-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this Stop hook, its surface-never-persist boundary and its silence conditions under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-memory-index-check-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this SessionStart knowledge-base probe under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-memory-index-check.mjs',
    status: 'mapped',
    reason: 'Fidelity-checker docs instruct operators to run and consume this CLI/report.',
  },
  {
    script: 'plugin/bin/wt-observe.mjs',
    status: 'mapped',
    reason: 'Public launcher CLI with durable docs across the README, toolkit docs, and debugger docs.',
  },
  {
    script: 'plugin/bin/wt-outbound-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this spawn-registry writer/nudge hook under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-probe-claim-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this SendMessage probe-claim guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-pilot-card-reconcile.mjs',
    status: 'mapped',
    reason: 'Pilot orchestrator docs tell operators to run this reconciliation CLI on claimed cards.',
  },
  {
    script: 'plugin/bin/wt-pilot-guard-hook.mjs',
    status: 'mapped',
    reason: 'Pilot docs explicitly describe this shipped guard and the verbs it refuses.',
  },
  {
    script: 'plugin/bin/wt-main-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse main-session guard, its measured-BLOCKING and journal-only classes, and the allow-once escape hatch under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-push-scope-check.mjs',
    status: 'mapped',
    reason: 'Pilot docs instruct operators to run this push-scope guard before escalation/push.',
  },
  {
    script: 'plugin/bin/wt-queue-not-empty-gate-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this tracker-agnostic Stop gate and its marker contract under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-quota-probe.mjs',
    status: 'mapped',
    reason: 'README, privacy, and security docs describe this bundled public quota probe.',
  },
  {
    script: 'plugin/bin/wt-quota-watch.mjs',
    status: 'mapped',
    reason: 'README, privacy, and security docs describe the bundled quota monitor and probe pairing.',
  },
  {
    script: 'plugin/bin/wt-registry-heartbeat-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the shipped Stop heartbeat and its repeated-block semantics.',
  },
  {
    script: 'plugin/bin/wt-run-gate.mjs',
    status: 'mapped',
    reason: 'Pilot docs instruct operators to use this non-bypassable gate runner for repo gates.',
  },
  {
    script: 'plugin/bin/wt-observer-pairing-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PostToolUse observer-pairing reporter under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-service-watch.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this service monitor and its degraded-flag contract under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-wake-channel.mjs',
    status: 'exempt',
    reason: 'Internal dependency-free MCP transport whose complete invocation contract is the adjacent plugin/.mcp.json registration.',
  },
  {
    script: 'plugin/bin/wt-session-start-registry-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the SessionStart scan hook and its explicit-session contract.',
  },
  {
    script: 'plugin/bin/wt-spawn-capability-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse unwritable-report spawn blocker under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-spawn-registry-scan.mjs',
    status: 'mapped',
    reason: 'Known-issues documents the standalone scan/ack CLI and its explicit-session contract.',
  },
  {
    script: 'plugin/bin/wt-spawn-shape-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse observer-preserving spawn guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-rule-edit-horizon-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PostToolUse ambient-rule reload-horizon notice under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-rule-convention-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse rule-writing-convention blocker under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-live-config-tree-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse live-ambient-rules-tree switch guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-stale-date-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PostToolUse stale-deadline advisory under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-shipped-twin-check-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PostToolUse shipped-twin advisory under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-stale-date-guard.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this standalone CLI, its usage, and its exit codes under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-stop-hook.mjs',
    status: 'mapped',
    reason: 'README, architecture, privacy, security, and toolkit docs describe this shipped Stop hook.',
  },
  {
    script: 'plugin/bin/wt-command-repeat-check.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this unregistered standalone CLI and its flag/exit-code contract under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-verdict-cap-check.mjs',
    status: 'mapped',
    reason: 'Fidelity-checker docs tell operators to run this CLI on verifier reports.',
  },
  {
    script: 'plugin/bin/wt-verifier-cli-guard-hook.mjs',
    status: 'mapped',
    reason: 'Opencode-verifier and routing docs describe the shipped mechanical verifier guard.',
  },
  {
    script: 'plugin/bin/wt-unquoted-tool-glob-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse unquoted-glob blocking guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-var-colon-modifier-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse var-colon-modifier warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-merge-chain-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse merge-chain warning guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-missing-package-script-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse missing-package-script warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-pipestatus-bash-only-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse PIPESTATUS warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-find-newermt-format-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse find-newermt-format warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-git-commit-backtick-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse git-commit-backtick warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-guard-journal-scan.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this standalone read CLI, its exit codes, and the shared guard-journal.mjs write side under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-guard-recurrence-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this SessionStart recurrence surface (threshold, grouping, silence contract) under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-isolated-spawn-report-path-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse isolated-spawn out-of-tree-write warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-pgrep-env-dump-guard-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PreToolUse full-listing pgrep/ps env-dump warn-only guard under Shipped Hooks, Guards & Monitors.',
  },
  {
    script: 'plugin/bin/wt-propagation-reminder-hook.mjs',
    status: 'mapped',
    reason: 'Known-issues documents this PostToolUse tooling/plugin-edit propagation reminder under Shipped Hooks, Guards & Monitors.',
  },
]

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
    // The pilot delegation suite (dev-loop drivers) is DESCRIBED BY its composer
    // skill, which also documents the environment-brief contract. The whole
    // plugin/agents/ subtree is mapped above to the routing docs (accurate for
    // the leaf/lean/opencode-verifier agentTypes); this narrower entry adds the
    // pilot-wave surface for the three pilot definitions specifically. The pilot
    // suite lives in plugin/agent-templates/, not plugin/agents/ — Claude Code
    // silently ignores `observer:` on a plugin-registered agent, so the pilots stay
    // unregistered templates, adopted as project copies (see adopt).
    sources: [
      'plugin/agent-templates/pilot.md',
      'plugin/agent-templates/pilot-orchestrator.md',
      'plugin/agent-templates/pilot-watchdog.md',
      // The lane-consent CLI is documented by the same skill, because consent is
      // resolved there (Step 1) and the CLI is what a reader is pointed at to see
      // or change the switch. Its two siblings (the check CLI and its hook) stay
      // `missing-doc-surface`: they are DISAGREEMENT detectors with no user-facing
      // invocation contract, which is a different thing from being undocumented by
      // oversight.
      'plugin/bin/wt-lane-consent.mjs',
    ],
    docs: ['plugin/skills/pilot-wave/SKILL.md'],
  },
  {
    // The adopt opt-in installer (writes editable, versioned rule copies of
    // the cross-cutting guardrails) is described by its own skill.
    sources: ['plugin/skills/adopt/scripts/'],
    docs: ['plugin/skills/adopt/SKILL.md', 'README.md'],
  },
  {
    // The bundled cross-cutting rule files (the delegation ladder + companions)
    // that adopt installs; described by their own README and the repo README.
    sources: ['plugin/rules/'],
    docs: ['plugin/rules/README.md', 'README.md'],
  },
  {
    // The nine patterns + the result envelope (options, caps, envelope shape,
    // pattern count claims) plus their execution/tuning knobs (per-role
    // model/effort/agentType, cache-warm, stageKey), split across two files.
    sources: ['toolkit/packages/patterns/src/'],
    docs: [
      'plugin/skills/workflow-composer/references/patterns.md',
      'plugin/skills/workflow-composer/references/patterns-execution.md',
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
    // Observed-role wt-comm brief auto-injection: tolerant observer extraction,
    // prompt suffixing, defineWorkflow wiring, and scaffold/docs caveats.
    sources: [
      'toolkit/packages/runtime/src/observed-role-brief.ts',
      'toolkit/packages/runtime/src/prompt-tag.ts',
      'toolkit/packages/build/src/define-workflow.ts',
      'toolkit/packages/scaffold/src/scaffold.ts',
    ],
    docs: [
      'docs/public/known-issues.md',
      'plugin/skills/workflow-composer/references/api-reference.md',
      'plugin/skills/workflow-composer/references/observer-definitions.md',
      'toolkit/packages/comm/README.md',
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
    // Scaffold emitter (what `wt:scaffold` generates: workflow / agent / observer /
    // capabilities-sidecar artifacts).
    sources: ['toolkit/packages/scaffold/src/'],
    docs: [
      'plugin/skills/toolkit-scaffold/SKILL.md',
      'plugin/skills/workflow-composer/SKILL.md',
      'plugin/skills/workflow-composer/references/capability-needs.md',
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
    // Capability registry + sidecar resolver + launcher glue (machine registry
    // format/location/WT_CAPABILITY_REGISTRY, $cap: expansion, named degradations,
    // fail-loud launch refusal). The operator-facing registry doc + the author-facing
    // needs/sidecar doc together describe this surface.
    sources: [
      'toolkit/packages/debugger/src/capability-registry.ts',
      'toolkit/packages/debugger/src/launch-capabilities.ts',
    ],
    docs: [
      'docs/public/capability-registry.md',
      'plugin/skills/workflow-composer/references/capability-needs.md',
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
    // Every other shipped composition (the catalog doc + the dev-workflow story
    // + the bundled examples README, which now names per-workflow usage intent).
    sources: ['toolkit/examples/'],
    docs: [
      'plugin/skills/workflow-composer/references/shipped-compositions.md',
      'docs/public/dev-workflow.md',
      'plugin/skills/workflow-composer/assets/examples/README.md',
    ],
  },
  {
    // wt-comm: the file-message protocol between escalating agents, the pilot, and
    // the observer/relay (hint producer since v0.2).
    sources: ['toolkit/packages/comm/src/'],
    docs: [
      'toolkit/packages/comm/README.md',
      'toolkit/packages/comm/teaching/wt-comm-participant.md',
      'toolkit/packages/comm/teaching/wt-comm-observer-consumer.md',
    ],
  },
  {
    // Public debugger/observability executables shipped under plugin/bin/.
    sources: [
      'plugin/bin/wt-debug.mjs',
      'plugin/bin/wt-observe.mjs',
      'plugin/bin/wt-stop-hook.mjs',
    ],
    docs: [
      'README.md',
      'toolkit/README.md',
      'docs/public/architecture.md',
      'plugin/skills/workflow-debugger/SKILL.md',
      'plugin/skills/workflow-composer/references/observing-runs.md',
      'PRIVACY.md',
      'SECURITY.md',
    ],
  },
  {
    // Bundled quota monitor/probe pair.
    sources: ['plugin/bin/wt-quota-probe.mjs', 'plugin/bin/wt-quota-watch.mjs'],
    docs: ['README.md', 'PRIVACY.md', 'SECURITY.md'],
  },
  {
    // Pilot operators are instructed to run these helper CLIs/guards directly.
    sources: [
      'plugin/bin/wt-run-gate.mjs',
      'plugin/bin/wt-push-scope-check.mjs',
      'plugin/bin/wt-pilot-guard-hook.mjs',
      'plugin/bin/wt-pilot-card-reconcile.mjs',
      'plugin/bin/wt-lane-probe.mjs',
      'plugin/bin/wt-lane-activity.mjs',
      'plugin/bin/wt-lane-postdiff-check.mjs',
    ],
    docs: [
      'plugin/agent-templates/pilot.md',
      'plugin/agent-templates/pilot-orchestrator.md',
      'plugin/launch-agents/agents/pilot.md',
      'plugin/launch-agents/agents/pilot-orchestrator.md',
    ],
  },
  {
    // The verifier backstop is part of the shipped opencode-verifier contract.
    sources: ['plugin/bin/wt-verifier-cli-guard-hook.mjs'],
    docs: [
      'plugin/agents/opencode-verifier.md',
      'plugin/launch-agents/agents/opencode-verifier.md',
      'plugin/skills/workflow-composer/references/model-and-agent-routing.md',
    ],
  },
  {
    // Knowledge-base/report verification helper CLIs used by fidelity checking.
    sources: ['plugin/bin/wt-memory-index-check.mjs', 'plugin/bin/wt-verdict-cap-check.mjs'],
    docs: ['plugin/agents/fidelity-checker.md', 'plugin/launch-agents/agents/fidelity-checker.md'],
  },
  {
    // Observer pairing verification CLI used by the wave fidelity checker.
    sources: ['plugin/bin/wt-check-observer-pairing.mjs'],
    docs: ['plugin/agents/wave-fidelity-checker.md', 'plugin/launch-agents/agents/wave-fidelity-checker.md'],
  },
  {
    // Shipped SessionStart delegation-ladder injection.
    sources: ['plugin/bin/wt-delegation-ladder-hook.mjs'],
    docs: ['README.md', 'plugin/skills/adopt/SKILL.md'],
  },
  {
    // Shipped Stop hooks whose operator-facing semantics are documented as known issues/contracts.
    sources: [
      'plugin/bin/wt-actionable-gate-hook.mjs',
      'plugin/bin/wt-actionable-snapshot-producer-hook.mjs',
      'plugin/bin/wt-registry-heartbeat-hook.mjs',
      'plugin/bin/wt-session-start-registry-hook.mjs',
      'plugin/bin/wt-spawn-registry-scan.mjs',
    ],
    docs: ['docs/public/known-issues.md'],
  },
  {
    // The shipped hooks/guards/monitors written up in the "Shipped Hooks, Guards &
    // Monitors" section — none had a doc surface before.
    sources: [
      'plugin/bin/wt-adopt-check-hook.mjs',
      'plugin/bin/wt-label-intent-producer-hook.mjs',
      // Deprecated name kept as a shim so sessions already running when the rename landed do
      // not lose the hook. Same doc surface as the file it delegates to; delete both this line
      // and the shim one release after the rename.
      'plugin/bin/wt-adopt-rules-check-hook.mjs',
      'plugin/bin/wt-env-prerequisite-drift-hook.mjs',
      'plugin/bin/wt-guard-recurrence-hook.mjs',
      'plugin/bin/wt-lane-saturation-hook.mjs',
      'plugin/bin/wt-lane-consent-gate-hook.mjs',
      'plugin/bin/wt-arc-watch.mjs',
      'plugin/bin/wt-autonomy-arm.mjs',
      'plugin/bin/wt-autonomy-watch.mjs',
      'plugin/bin/wt-check-commit-signatures-hook.mjs',
      'plugin/bin/wt-check-commit-signatures.mjs',
      'plugin/bin/wt-hook-registration-drift-hook.mjs',
      'plugin/bin/wt-lesson-harvest-hook.mjs',
      'plugin/bin/wt-memory-index-check-hook.mjs',
      'plugin/bin/wt-outbound-guard-hook.mjs',
      'plugin/bin/wt-probe-claim-guard-hook.mjs',
      'plugin/bin/wt-queue-not-empty-gate-hook.mjs',
      'plugin/bin/wt-observer-pairing-guard-hook.mjs',
      'plugin/bin/wt-rule-edit-horizon-hook.mjs',
      'plugin/bin/wt-rule-convention-guard-hook.mjs',
      'plugin/bin/wt-live-config-tree-guard-hook.mjs',
      'plugin/bin/wt-service-watch.mjs',
      'plugin/bin/wt-spawn-capability-guard-hook.mjs',
      'plugin/bin/wt-spawn-shape-guard-hook.mjs',
      'plugin/bin/wt-stale-date-guard-hook.mjs',
      'plugin/bin/wt-shipped-twin-check-hook.mjs',
      'plugin/bin/wt-stale-date-guard.mjs',
      'plugin/bin/wt-command-repeat-check.mjs',
      'plugin/bin/wt-unquoted-tool-glob-guard-hook.mjs',
      'plugin/bin/wt-var-colon-modifier-guard-hook.mjs',
      'plugin/bin/wt-merge-chain-guard-hook.mjs',
      'plugin/bin/wt-missing-package-script-guard-hook.mjs',
      'plugin/bin/wt-main-guard-hook.mjs',
      'plugin/bin/wt-pipestatus-bash-only-guard-hook.mjs',
      'plugin/bin/wt-find-newermt-format-guard-hook.mjs',
      'plugin/bin/wt-git-commit-backtick-guard-hook.mjs',
      'plugin/bin/wt-guard-journal-scan.mjs',
      'plugin/bin/wt-isolated-spawn-report-path-hook.mjs',
      'plugin/bin/wt-pgrep-env-dump-guard-hook.mjs',
      'plugin/bin/wt-propagation-reminder-hook.mjs',
    ],
    docs: ['docs/public/known-issues.md'],
  },
]

function mappedPluginBinScripts(manifest: readonly ProvenanceEntry[]): Set<string> {
  return new Set(
    manifest.flatMap((entry) =>
      entry.sources.filter(
        (source) => source.startsWith('plugin/bin/') && source.endsWith('.mjs'),
      ),
    ),
  )
}

/** Audit whether shipped plugin/bin executables are all either manifest-mapped or explicitly
 *  recorded with a reason. `missing-doc-surface` is SILENT here on purpose: the gap is then
 *  explicit and reportable, not invisible by omission. */
export function auditPluginBinCoverage(
  shippedScripts: readonly string[],
  manifest: readonly ProvenanceEntry[] = DOCS_PROVENANCE,
  decisions: readonly PluginBinDocDecision[] = PLUGIN_BIN_DOC_DECISIONS,
): PluginBinCoverageAudit {
  const shipped = [...new Set(shippedScripts)].sort()
  const mapped = mappedPluginBinScripts(manifest)
  const decisionCounts = new Map<string, number>()
  const decisionByScript = new Map<string, PluginBinDocDecision>()
  for (const decision of decisions) {
    decisionCounts.set(decision.script, (decisionCounts.get(decision.script) ?? 0) + 1)
    if (!decisionByScript.has(decision.script)) decisionByScript.set(decision.script, decision)
  }

  const unclassified = shipped.filter(
    (script) => !mapped.has(script) && !decisionByScript.has(script),
  )
  const unknownRecordedScripts = [...decisionByScript.keys()]
    .filter((script) => !shipped.includes(script))
    .sort()
  const duplicateRecordedScripts = [...decisionCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([script]) => script)
    .sort()
  const mappedWithoutManifest = decisions
    .filter((decision) => decision.status === 'mapped' && !mapped.has(decision.script))
    .map((decision) => decision.script)
    .sort()
  const nonMappedDecisionsWithManifestEntry = decisions
    .filter((decision) => decision.status !== 'mapped' && mapped.has(decision.script))
    .map((decision) => decision.script)
    .sort()
  const manifestScriptsWithoutMappedDecision = [...mapped]
    .filter((script) => decisionByScript.get(script)?.status !== 'mapped')
    .sort()

  return {
    unclassified,
    unknownRecordedScripts,
    duplicateRecordedScripts,
    mappedWithoutManifest,
    nonMappedDecisionsWithManifestEntry,
    manifestScriptsWithoutMappedDecision,
  }
}

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
