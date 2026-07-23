---
'@workflow-toolbox/patterns': minor
---

The external-vote provenance gate now detects an `opencode run` with a LINEAR, ReDoS-safe
matcher instead of a single mega-regex. The old regex's `BIN=…opencode …[\s\S]*?… "$BIN" run`
arm backtracked catastrophically (~30s) on a large `opencode`-but-no-`run` command, and a 20k
scan cap hid a real `run` sitting past position 20k inside a long heredoc — so a legitimate
external verifier vote whose `run` came after a big prompt heredoc was wrongly reported as
having no provenance (a false-refuse). The embedded checker scanner now inlines the matcher's
source verbatim and runs it over the FULL command (a head/tail window bounds the work), so a
`run` past 20k is credited and the ReDoS is eliminated. The `commandRe` in the signature
registry is retained for display only; the executable path is the new `matchCommand`.
