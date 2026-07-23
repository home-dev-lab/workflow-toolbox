---
'@workflow-toolbox/build': minor
---

`workflow-toolbox build --typecheck` now supports TypeScript 7. TS 7's native-rewrite
release drops the in-process classic compiler API (`ts.sys` / `ts.createProgram`) that the
typecheck path relied on, so `--typecheck` crashed under TS 7. The CLI now detects the
compiler capability and, on TS 7+, shells out to the consumer's own `tsc` against a scoped
temp tsconfig (exit code = pass/fail); TS < 7 keeps the unchanged in-process program path.
