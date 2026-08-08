---
"@workflow-toolbox/pipeline-spec": minor
---

`ScriptedStageSpec.prompt` can now be a `ComposedPrompt` (`{ compose: [...] }`) — one prompt
assembled from several `InputRef` sources plus author-written literal text, with no implicit
separator: every byte of whitespace between two parts is a `{ text: ... }` part the author wrote
themselves. A `compose` part cannot itself be a composition (one level only), and an empty
`compose` array is rejected.

This is structurally distinct from the existing distinct-prompt fan (a bare `InputRef[]`, whose
length IS the call count) — a composition is an object carrying a `compose` key, so the two
readings can never collide. The two features compose freely: one element of a distinct-prompt
array may itself be a `ComposedPrompt`.

New exported types: `PromptPart`, `ComposedPrompt`.
