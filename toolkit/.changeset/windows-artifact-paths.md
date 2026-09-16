---
"@workflow-toolbox/patterns": patch
---

`probeAgentType` accepts drive-letter absolute artifact paths (`C:\...`) in the envelope manifest and answer-file checks, alongside POSIX `/...`; relative and newline-bearing paths are still rejected.
