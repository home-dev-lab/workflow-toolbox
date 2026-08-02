// opencode-routing.ts — shared bridge-routing model doctrine for compositions
// that can route a role to the `workflow-toolbox:opencode-verifier` agentType
// (coverage-audit, docs-audit, pr-review).
//
// Rule-of-Three trigger (project rule step-back-architectural): the wrapper-
// model gate (`resolveWrapperModel`) and its parse helper (`parseRoleStringMap`)
// were duplicated byte-for-byte across coverage-audit.workflow.ts and
// docs-audit.workflow.ts (commit 340437f); pr-review adding the SAME doctrine
// is the 3rd instance. All three share a genuine
// reason to change together — they encode ONE bridge-routing model doctrine —
// so this is a real generalization, not a coincidental shape match. Verified
// buildable: `wt:build` (esbuild, packages/build/src/bundle.ts) already inlines
// a cross-file import from toolkit/examples/ — docs-provenance.ts is imported
// by both coverage-audit.workflow.ts and pr-review.workflow.ts today and
// appears inlined in both committed artifacts. This module itself is placed
// under toolkit/examples/ (a workflow-authoring SOURCE, bundled at build
// time) — the model-doctrine/OPENCODE_WORKDIR helpers below are pure
// workflow-source logic with no published-package equivalent. Its bridge-
// identity discriminator (`isBridgeAgentType`, further down) DOES delegate to
// a published package (`isExternalBridgeType`, @workflow-toolbox/patterns) —
// that IS a toolkit/packages/*/src change and DOES carry its own changeset
// (see .changeset/ in this commit); the two are separate surfaces, not a
// contradiction.
//
// Also carries the OPENCODE_WORKDIR auto-injection helper —
// a distinct feature (the cd-to-target token economy)
// that happens to be the SAME "route a role to opencode-verifier" doctrine
// family, so it lives alongside the model-doctrine helpers rather than as a
// 3rd near-duplicate module.
//
// Bundled for offline study alongside docs-provenance.ts — see
// packages/build/test/plugin-bundle-identity.test.ts's `isStudyFile`; keep the
// mirror at plugin/skills/workflow-composer/assets/examples/toolkit/ in sync
// (byte-identity gate).

import type { ModelAlias } from '@workflow-toolbox/runtime'
import { isExternalBridgeType } from '@workflow-toolbox/patterns'

// ---------------------------------------------------------------------------
// OPENCODE_WORKDIR auto-injection
// ---------------------------------------------------------------------------

// The one bridge agentType that recognizes the `OPENCODE_WORKDIR:` directive
// line (plugin/agents/opencode-verifier.md) — the cd-to-target token economy
// (def v2, 005c9cf) that used to require the caller to hand-pass
// `OPENCODE_WORKDIR: <repoRoot>` via `hints`. repoRoot is ALREADY a required
// input on every workflow that can reach this doctrine, so once a role
// resolves to EXACTLY this agentType the directive is injected automatically —
// zero caller recipe. Gated on the exact string (not "any resolved
// agentType") because the directive is meaningless — and would be a stray,
// confusing line — to any other agentType a caller might route a role to.
export const OPENCODE_VERIFIER_AGENT_TYPE = 'workflow-toolbox:opencode-verifier'

/** OPENCODE_WORKDIR directive line for a role, or '' when the role did not
 *  resolve to the opencode-verifier bridge. Callers place this FIRST among
 *  the opencode directive lines (workdir must be fixed before the wrapper can
 *  even classify referenced files — see the agent def's step 1). */
export function opencodeWorkdirLine(resolvedType: string | null, repoRoot: string): string {
  return resolvedType === OPENCODE_VERIFIER_AGENT_TYPE ? `OPENCODE_WORKDIR: ${repoRoot}\n\n` : ''
}

// ---------------------------------------------------------------------------
// Bridge-identity discriminator (arbiter ruling
// "Option B" — 2026-07-24) — used ONLY where a resolved agentType can
// legitimately be a same-family Claude SPECIALIST rather than an external
// relay (pr-review's `agentTypes.review`, whose own doc comment documents
// both cases). `resolvedType !== null` is a valid bridge PROXY only where the
// caller's agentType knob is documented cross-model-only (coverage-audit,
// docs-audit) — those two keep the plain `!== null` gate (see
// resolveWrapperModel's call sites in each file); do not switch them to this
// discriminator without re-verifying byte-for-byte behavior on every
// documented input, not just the tested ones.
// ---------------------------------------------------------------------------

// DELEGATES to `isExternalBridgeType` (@workflow-toolbox/patterns,
// provenance-gate.ts) — the canonical, ALREADY-SHIPPED discriminator built
// on the SAME registry (EXTERNAL_CLI_SIGNATURES) that
// adversarialVerification's own haiku-vs-BEST_MODEL fan decision keys off
// (adversarial-verification.ts:376,390). Exported at the package root
// specifically for this reuse — two earlier
// drafts of this helper hand-rolled a SECOND registry (an exact-name list,
// then a mirrored regex pair); both were rejected on review as an avoidable
// Nth copy of "what counts as a bridge" one layer up from the wrapper-model
// doctrine's own Rule-of-Three above. One registry now answers "is this
// agentType a bridge" for both the provenance gate AND every wrapper-model
// gate that needs the same answer — a bridge type added or renamed there is
// automatically correct everywhere, including here. Thin re-export (not a
// bare re-export) so every call site in this file keeps its existing
// `string | null` signature without an inline `?? undefined` at each use.
export function isBridgeAgentType(resolvedType: string | null): boolean {
  return isExternalBridgeType(resolvedType)
}

// ---------------------------------------------------------------------------
// Wrapper-role Claude model doctrine (commit 340437f)
// ---------------------------------------------------------------------------

/** Wrapper-role Claude model. A role routed to an external bridge agentType
 *  (agentTypes.<role>) is a THIN RELAY — the external model reasons, the
 *  wrapper only plumbs the CLI call — so it defaults to 'haiku' and the
 *  run-global perAgent.model deliberately does NOT reach it. An explicit
 *  models.<role> always wins (bridge or not). Returns undefined for a
 *  non-bridge role with no override, so the blanket perAgent / pattern
 *  default still applies. */
export function resolveWrapperModel(
  routesToWrapper: boolean,
  explicit: ModelAlias | undefined,
): ModelAlias | undefined {
  if (explicit !== undefined) return explicit
  return routesToWrapper ? 'haiku' : undefined
}

/** Parse a per-role string map (e.g. `{ inventory?, extract?, verify? }` or
 *  pr-review's single-role `{ review? }`) — the shared shape of
 *  `opencodeModels` (external provider/model), `models` (the wrapper's own
 *  Claude model) and `opencodeVariants` (the opencode --variant). `roleKeys`
 *  is the caller's own role set (workflows differ in which roles they
 *  route). When `allowed` is non-null every value is validated against it
 *  (models → MODEL_ALIASES); otherwise any non-empty string is accepted (the
 *  def validates variant names per-model; opencode model ids are
 *  free-form). `errorPrefix` names the calling workflow in thrown messages
 *  (e.g. 'coverage-audit', 'pr-review'). */
export function parseRoleStringMap(
  raw: unknown,
  key: string,
  allowed: readonly string[] | null,
  roleKeys: readonly string[],
  errorPrefix: string,
): Readonly<Record<string, string>> | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${errorPrefix}: "${key}" must be an object when provided`)
  }
  const obj = raw as Record<string, unknown>
  const unknown = Object.keys(obj).filter((k) => !roleKeys.includes(k))
  if (unknown.length > 0) {
    throw new Error(
      `${errorPrefix}: "${key}" has unknown key(s): ${unknown.join(', ')}; ` +
      `accepted keys: ${roleKeys.join(', ')}`,
    )
  }
  const parsed: Record<string, string> = {}
  for (const role of roleKeys) {
    const value = obj[role]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${errorPrefix}: "${key}.${role}" must be a non-empty string when provided`)
    }
    if (allowed !== null && !allowed.includes(value)) {
      throw new Error(`${errorPrefix}: "${key}.${role}" must be one of ${allowed.join(', ')}`)
    }
    parsed[role] = value
  }
  return parsed
}
