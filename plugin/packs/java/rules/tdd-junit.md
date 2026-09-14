# Java TDD with JUnit 5

Adapted from ECC, `docs/tutorials/03-java-development.md`.

For a behavior change, first add a focused JUnit 5 test that fails for the intended reason. Run
`mvn -q test` for Maven projects or `gradle test --console=plain` for Gradle projects, and record
the nonzero red exit code. Make the smallest production change, rerun the same command, and record
its zero green exit code. Do not weaken, skip, or delete the lock to make the gate green.
