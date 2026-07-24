---
"@workflow-toolbox/patterns": minor
---

Export `isExternalBridgeType(agentType)` — a narrow boolean predicate answering "is this agentType a registered external CLI bridge (opencode/codex family), not a Claude specialist". Built on the same `EXTERNAL_CLI_SIGNATURES` registry `adversarialVerification` already uses for its own haiku-vs-BEST_MODEL default, so a composition author outside this package can reuse the exact same bridge-identity discriminator instead of hand-rolling a second, driftable registry of bridge names. The richer `externalGateExpectation` record stays internal — this is deliberately the minimal public surface a caller needs.
