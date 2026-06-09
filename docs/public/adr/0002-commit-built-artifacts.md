# 2. Commit built workflow artifacts

Date: 2026-06-06

## Status

Accepted

## Context

`dwt build` emits self-contained `.js` workflows under `toolkit/workflows/`.
Building requires the workspace toolchain (pnpm, tsx, esbuild). The artifacts —
not the TypeScript sources — are what users actually run via the Workflow tool.

Options considered: gitignore the output (rebuild on demand), or commit it.

## Decision

Commit `toolkit/workflows/*.js` to the repository.

## Consequences

- Artifacts are **reviewable and diffable**: a change to a pattern shows up in
  the emitted workflow's diff, which is exactly what a reviewer of a
  sandbox-executed script wants to see.
- Usable without building — clone and launch via `scriptPath`, or copy into
  `.claude/workflows/`, with no toolchain installed.
- Drift risk: sources can change without a rebuild. Mitigations: the build is
  deterministic (pinned esbuild), `dwt check` validates any artifact
  standalone, and the milestone ritual rebuilds before committing.
- Artifact size is visible in diffs, which keeps the 512 KB cap (and its
  silent-exclusion failure mode on the `name` path) on the radar.
