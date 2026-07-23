---
"@workflow-toolbox/patterns": minor
---

probeAgentType: new `required` option. An explicitly user-configured agentType (e.g. `agentTypes.verify`) that fails its availability probe now throws an actionable error at launch instead of silently degrading to the standard subagent. Default (library default-routing) keeps the graceful degrade.
