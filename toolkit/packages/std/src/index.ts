// @workflow-toolbox/std — shared utilities for the toolkit's internal packages. narrow.ts is
// zero-dependency; resolve-effort.ts carries a type-only dependency on @workflow-toolbox/runtime
// for the EffortAlias contract (erased at compile time, no runtime footprint).
export * from './narrow.js'
export * from './resolve-effort.js'
