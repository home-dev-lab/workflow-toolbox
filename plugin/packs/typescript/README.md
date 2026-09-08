# TypeScript Pack

This pack provides TypeScript-specific rules, skills, and SDK-only critic and reviewer definitions
for the Workflow Toolbox repository.

## Selection

`wt-lifecycle-hooks` selects the pack when a card Discovery block contains a `Language:` value
matching `typescript`. `wt-rules-on-demand` serves the pack's topic rules on `Edit` and `Write`
tool calls targeting `.ts` or `.tsx` paths. Other language values and an absent `Language:` field
do not select this pack.

## Limits

- The pack covers TypeScript and TSX only; it supplies no rules or workflow for other languages.
- SDK-only status is a convention plus the absence of these definitions from `plugin/agents/` and
  `plugin/agent-templates/`; the pack does not enforce SDK invocation at runtime.
- Pack selection attaches context notes and topic rules. It does not execute TDD, gates, or a
  reviewer automatically.

## Adding Another Pack

Create a sibling directory with a manifest, topic rules, skills, SDK-only definitions, and a
manifest test. Add that pack's rule sources and file triggers to `wt-rules-on-demand`, then extend
the `Language:` selection in `wt-lifecycle-hooks`. Keep language matching explicit so one pack
does not load for another language.
