---
name: lint-typecheck-build
description: Run the configured Java formatter, compilation, test, and optional analysis gates through Maven and report exit codes.
---

# Java Gate Sequence

Use the project's configured formatter. Then run `mvn -q test` or `mvn -q verify`. Record every
exit code; only `0` is green. Run SpotBugs or Checkstyle only where the project configures them.
