# @workflow-toolbox/std

Small, dependency-light utilities shared across the `@workflow-toolbox` packages: runtime
type-narrowers for parsing untrusted JSON, and an effort-tier resolver for reading
per-role reasoning-effort overrides out of a workflow's launch config.

Most workflow authors won't import this directly — it backs `@workflow-toolbox/patterns`
and `@workflow-toolbox/build`. It's published standalone because the same narrowing and
effort-resolution logic is useful in any tool that parses agent/runtime output or reads a
workflow's `perAgent`/`effort` launch config.

## Install

```bash
pnpm add @workflow-toolbox/std
```

## What's in it

- `isRecord`, `numOrNull`, `strOrNull` — runtime type-narrowers for `unknown` JSON values
  (journals, SDK messages, marker files). `isRecord` excludes arrays, so callers can
  safely index string keys without an array slipping through as a "record".
- `resolveEffort` / `resolveVerifierEffort` — resolve a stage's effective effort tier
  (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`) from an optional launch-time override,
  degrading gracefully to the stage's own default when the override is absent or
  invalid. `resolveVerifierEffort` additionally clamps the result to never fall below a
  floor (default `'high'`) — an override may only raise a verifier's effort, never lower
  it.

## Example

```ts
import { isRecord, resolveEffort } from '@workflow-toolbox/std'

// Narrow an untrusted JSON value before indexing string keys.
function readName(parsed: unknown): string | null {
  return isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : null
}

// Resolve a stage's effort tier from a launch-time override, falling back to
// the stage's own default when the override is absent or invalid.
const effort = resolveEffort(config.effort?.classify, 'low')
```

## Docs

- [toolkit/README.md](../../README.md) — the full authoring contract and pattern library.
- [Architecture](../../../docs/public/architecture.md) — design principles and the
  runtime/toolkit responsibility split.

## License

FSL-1.1-ALv2 — see [LICENSE](../../../LICENSE).
