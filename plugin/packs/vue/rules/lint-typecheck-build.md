# Vue Lint, Typecheck, and Build

Run the project's documented lint, `vue-tsc --noEmit` typecheck, Vitest, and Vite build commands.
Treat a gate as green only when it exits with code `0`; long-running gates need a detached log and
an appended exit marker. This is a minimal local copy of the TypeScript-family rule because the
current private pack loader addresses rule files within the selected pack.
