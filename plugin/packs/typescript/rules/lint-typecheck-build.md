# TypeScript Lint, Typecheck, and Build

Run toolkit gates from `toolkit/`. Use `pnpm lint`, `pnpm typecheck`, and `pnpm build:dist` in
that order when all three apply. This workspace has no umbrella `pnpm build` script; `build:dist`
is its distributable-package build command.

Treat a gate as green only when its process exits with code `0`. For long-running gates, run the
command detached with a log and an appended exit marker, then poll until the marker is present.
Do not infer success from partial output or a log that lacks an exit code.

The lint configuration is ESLint flat config. Source packages are consumed as TypeScript through
the workspace tooling, so do not add a separate source build step unless the task specifically
requires generated artifacts.
