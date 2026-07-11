// @workflow-toolbox/build — public API
//
// IMPORTANT for WORKFLOW ENTRY FILES (*.workflow.ts): import defineWorkflow
// from '@workflow-toolbox/build/define' (sandbox-pure subpath), NOT from '@workflow-toolbox/build'.
// This index re-exports the Node-side bundler (node:vm, esbuild); importing
// it from a workflow entry drags those into the platform-neutral bundle and
// `workflow-toolbox build` fails with "Could not resolve node:vm".
//
// Batch A exports:
//   • defineWorkflow + normalizeArgs (sandbox-pure, bundled into workflow artifacts)
//   • lintWorkflowSource + MAX_WORKFLOW_BYTES (Node-side linter, pure string analysis)
//
// Batch B exports:
//   • bundleWorkflow (Node-side bundler) + BundleResult (type)
//
// Deliberately NOT re-exported here (bundler internals — this package's own
// tests import them from './bundle.js' directly): serializeMeta,
// sizeWarnings, SANDBOX_GLOBAL_NAMES. The public surface is what a workflow
// author needs; exposing the pipeline's plumbing would invite calling it
// outside the bundleWorkflow pipeline (§9 anti-creep).

// ---------------------------------------------------------------------------
// define-workflow: workflow declaration and input normalization
// ---------------------------------------------------------------------------

export { defineWorkflow, normalizeArgs, parseConfig } from './define-workflow.js'
export type { WorkflowMeta, DefinedWorkflow, WorkflowConfig } from './define-workflow.js'

// ---------------------------------------------------------------------------
// lint: workflow source linter (pure string analysis; validate-workflow.mjs is derived from this module)
// ---------------------------------------------------------------------------

export { lintWorkflowSource, MAX_WORKFLOW_BYTES } from './lint.js'
export type { LintResult } from './lint.js'

// ---------------------------------------------------------------------------
// bundle: esbuild bundler (Node-side; not for use inside workflow artifacts)
// ---------------------------------------------------------------------------

export { bundleWorkflow } from './bundle.js'
export type { BundleResult } from './bundle.js'

// ---------------------------------------------------------------------------
// define-pipeline / bundle-pipeline: ORCHESTRATOR pipeline authoring (I5) — the
// declarative PipelineSpec the observe-ui pipeline runner consumes, NOT the sandbox
// `pipeline()` primitive a defineWorkflow-bundled script calls (see docs/public/adr/0008 for
// the vocabulary convention). No sandbox-pure subpath needed here — a pipeline entry is
// never bundled into a Workflow-sandbox artifact, so it may import this root freely.
// ---------------------------------------------------------------------------

export { definePipeline } from './define-pipeline.js'
export type { DefinedPipeline } from './define-pipeline.js'
export { bundlePipeline } from './bundle-pipeline.js'
export type { BundlePipelineResult } from './bundle-pipeline.js'
