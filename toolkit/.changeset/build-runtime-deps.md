---
'@workflow-toolbox/build': patch
---

Declare `@workflow-toolbox/pipeline-spec` and `@workflow-toolbox/patterns` as runtime dependencies. Both reached the published artifact — `pipeline-spec` as a type in an exported signature of the shipped declarations, `patterns` as a bare import in the CLI bundle — while being declared only as devDependencies, which npm does not install for consumers.
