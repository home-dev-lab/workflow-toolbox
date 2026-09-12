---
name: lint-typecheck-build
description: Run the configured Java formatter, compilation, test, and optional analysis gates through Maven or Gradle and report exit codes.
---

# Java Gate Sequence

Use the project's configured formatter. Then run `mvn -q test` or `mvn -q verify` for Maven, or
`gradle test --console=plain` or `gradle build --console=plain` for Gradle. Record every exit code;
only `0` is green. Run SpotBugs or Checkstyle only where the project configures them.

For `.groovy` sources and Gradle build scripts, run Spock or JUnit through the same build tool.
This pack provides no diagnostics for Groovy.
