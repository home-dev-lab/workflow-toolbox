---
name: tdd-red-green
description: Run a focused JUnit 5 red-to-green loop for a named Java behavior and report both exit codes.
---

# Java Red to Green

1. Run `mvn -q test` for Maven before the production change.
2. Confirm the named JUnit 5 assertion is red, and record its nonzero exit code.
3. Apply the smallest implementation change that satisfies the assertion.
4. Rerun the same command, confirm it is green, and record exit code `0`.
