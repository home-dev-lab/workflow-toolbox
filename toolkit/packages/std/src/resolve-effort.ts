// resolve-effort.ts — resolve a stage's effective reasoning-effort tier from an
// optional launch-time override, degrading gracefully to the stage's own default.
//
// Compositions read per-role overrides from parseConfig's `effort` role map
// (@workflow-toolbox/build/define — e.g. `cfg.effort?.judge`) and thread them through
// resolveEffort so an invalid or absent override never reaches the harness: it falls
// back to the stage-class default the composition author picked at the call site
// (classify/mechanical/routing -> 'low', synthesis/consolidation -> 'medium',
// reviewer/implementer/fixer/planner -> 'high').
//
// resolveVerifierEffort is the verifier-site variant: the resolved tier is CLAMPED to
// never fall below `floor` (default 'high') — a launch-time override may only RAISE a
// verifier's effort (e.g. to 'xhigh'/'max' for a harder pass), never lower it below the
// quality floor. Mirrors adversarialVerification's own model-floor guardrail (BEST_MODEL
// default + a warning on downgrade) — weaker reasoning effort on a refute-first verifier
// is exactly as risky as a weaker model there.

import type { EffortAlias } from '@workflow-toolbox/runtime'

// Plain array + .includes(), not a Set: a `new Set(...)` module-scope constructor call is
// NOT provably side-effect-free to a bundler's tree-shaker, so an unused Set binding survives
// into consumers that only import std's OTHER exports (observed live: it leaked into the
// debugger CLI's bundled binary as dead code, tripping the unused-vars lint gate there). A
// plain array literal has no such side effect and is trivially dropped when unused — same
// convention already used for this exact check in packages/build/src/define-workflow.ts.
const EFFORT_ORDER: readonly EffortAlias[] = ['low', 'medium', 'high', 'xhigh', 'max']

function isEffortAlias(v: unknown): v is EffortAlias {
  return typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v)
}

/** Resolve a stage's effort tier: `argsValue` wins when it is a valid `EffortAlias`;
 *  any other value (undefined, null, 'auto', a typo, a non-string) degrades to
 *  `stageDefault` — an invalid or absent override never reaches the harness. */
export function resolveEffort(argsValue: unknown, stageDefault: EffortAlias): EffortAlias {
  return isEffortAlias(argsValue) ? argsValue : stageDefault
}

/** Verifier-site variant of {@link resolveEffort}: the resolved tier is clamped to
 *  never fall below `floor` (default 'high') — an override may only RAISE a verifier's
 *  effort, never lower it. `floor` itself must be a valid `EffortAlias`; an invalid
 *  floor falls back to 'high' (the same fail-safe direction as an invalid argsValue). */
export function resolveVerifierEffort(
  argsValue: unknown,
  stageDefault: EffortAlias,
  floor: EffortAlias = 'high',
): EffortAlias {
  const safeFloor = isEffortAlias(floor) ? floor : 'high'
  const resolved = resolveEffort(argsValue, stageDefault)
  return EFFORT_ORDER.indexOf(resolved) >= EFFORT_ORDER.indexOf(safeFloor) ? resolved : safeFloor
}
