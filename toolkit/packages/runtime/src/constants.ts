// Shared runtime constants for @workflow-toolbox.
import type { ModelAlias } from './types.js'

/** The strongest model tier currently *available* from Anthropic. Quality-critical
 *  work (adversarial verification, judging) defaults to this — every
 *  "best model" decision routes through this single constant. Bump it when a
 *  stronger tier ships, and un-bump it when a tier is withdrawn — the constant
 *  must always name a tier that is actually callable, not merely the newest.
 *
 *  Currently `'opus'` (Opus 4.8): `'fable'` (Fable 5) was the strongest tier
 *  until 2026-06-12, when a US export-control directive suspended Fable 5 /
 *  Mythos 5 for all customers — a verifier pinned to `'fable'` now errors at
 *  runtime. Opus 4.8 is the strongest tier still callable. Revert to `'fable'`
 *  if/when the suspension lifts.
 *
 *  NOTE: this is a VALUE import — patterns that use it get it inlined into
 *  bundled workflow artifacts by esbuild, so changing it re-emits committed
 *  artifacts (the artifact-identity gate enforces the regeneration). */
export const BEST_MODEL: ModelAlias = 'opus'

/** The closed allowlist of user-passable model aliases, for compositions that
 *  validate a model-selection INPUT (e.g. a `verifierModel` arg). Deliberately
 *  stricter than the open `ModelAlias` type: `'inherit'` and raw model ids are
 *  excluded — this is a validation allowlist, not the type's full domain.
 *  `'fable'` stays listed while its tier is suspended (see BEST_MODEL above):
 *  passing it errors at runtime, but the alias itself remains well-formed.
 *
 *  NOTE: a VALUE import — inlined into bundled workflow artifacts by esbuild,
 *  so changing it re-emits committed artifacts (artifact-identity gate). */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
