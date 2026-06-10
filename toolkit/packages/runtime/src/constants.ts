// Shared runtime constants for @workflow-toolbox.
import type { ModelAlias } from './types.js'

/** The strongest model tier currently shipped by Anthropic. Quality-critical
 *  work (adversarial verification, judging) defaults to this — every
 *  "best model" decision routes through this single constant. Bump it when a
 *  stronger tier ships. NOTE: this is a VALUE import — patterns that use it
 *  get it inlined into bundled workflow artifacts by esbuild, so bumping it
 *  re-emits committed artifacts. */
export const BEST_MODEL: ModelAlias = 'fable'
