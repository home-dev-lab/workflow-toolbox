# wt-delegation-ladder — rationale and field cases

Nothing extracted. An independent cross-family review (2026-09-02) found that this file's
"4. A wrapper around an external model must never render its verdict itself" paragraph fuses
the part `wt-verifier-cli-guard-hook.mjs` enforces (deny the verdict tool until a real
external-CLI invocation is proven) with a directive the hook's own message does not restate —
"invoking the external tool directly is recommended precisely because invocation is then its
own provenance." The paragraph carries no blank line internally, so the whole-paragraph-only
split invariant leaves nothing separable without dropping that recommendation. Left whole in
the rule.
