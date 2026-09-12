---
name: tdd-red-green
description: Run a focused JUnit 5 or Spock red-to-green loop for a named Java or Groovy behavior and report both exit codes.
---

# Java Red to Green

1. Run `mvn -q test` for Maven or `gradle test --console=plain` for Gradle before the production change.
2. Confirm the named JUnit 5 or Spock assertion is red, and record its nonzero exit code.
3. Apply the smallest implementation change that satisfies the assertion.
4. Rerun the same command, confirm it is green, and record exit code `0`.

For `.groovy` sources and Gradle build scripts, use Spock or JUnit through that same build tool.
This pack provides no diagnostics for Groovy.
