---
"@workflow-toolbox/patterns": patch
---

adversarialVerification/tournament cache-warm: a warm-up routed to an external CLI lane (opencode/codex) now must return CLI-derived proof (a plausible `<cli> --version`); a self-answering wrapper is retried once, then logged as SKIPPED and never counted as a warmed lane. Plain (Claude) warm-ups are unchanged.
