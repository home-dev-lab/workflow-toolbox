---
name: lint-typecheck-build
description: Run the TypeScript workspace lint, typecheck, and distributable build gates in sequence and report their exit codes.
---

# TypeScript Gate Sequence

Run these commands from `toolkit/` in order:

| Gate | Command |
| --- | --- |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Build | `pnpm build:dist` |

For each command, record its exit code before advancing to the next gate. Use a detached command,
log, and explicit exit marker when a gate can exceed the command timeout. Report a table with the
command, exit code, and whether the marker was observed. Do not report a partial log as a gate
result.
