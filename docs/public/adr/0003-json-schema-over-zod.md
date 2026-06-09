# 3. JSON Schema + json-schema-to-ts, not zod

Date: 2026-06-06

## Status

Accepted

## Context

Structured output is how data crosses the agent boundary: `rt.agent(prompt,
{ schema })` makes the runtime validate the agent's reply against a JSON
Schema (AJV, with retry on mismatch). Every consumed boundary in the toolkit
needs both that runtime contract and a matching TypeScript type.

zod is the popular alternative for schema-plus-type definitions, but the
runtime consumes JSON Schema natively — zod would require a conversion step
and add real bundle weight to artifacts that live under a 512 KB cap.

## Decision

Schemas are authored as `as const` JSON Schema literals, with TypeScript types
derived via `json-schema-to-ts` (`FromSchema`). zod is not used.

Conventions:

- Schemas live next to the pattern or composition that consumes them.
- Patterns own only their *control* schemas (verdicts, scores,
  classifications); domain payload schemas are caller-supplied.
- Small and `required`-tight; enums for closed sets; bounded numbers for
  scores.

## Consequences

- One source of truth for the runtime contract and the TS type — they cannot
  drift.
- `json-schema-to-ts` is **types-only**: verified that `FromSchema`
  usage leaves zero residue in the esbuild bundle.
- Raw JSON Schema is more verbose than zod chains; accepted, because the
  schema literal in the workflow file is exactly what the runtime sees —
  greppable, reviewable, no translation layer.
