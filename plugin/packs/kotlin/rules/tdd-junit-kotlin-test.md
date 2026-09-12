# Kotlin TDD with JUnit 5 and kotlin.test

For a behavior change, first add a focused JUnit 5 or `kotlin.test` assertion that fails for the
intended reason. Run it through Gradle with `gradle test --console=plain` or Maven with `mvn -q
zero exit code. Do not weaken, skip, or delete the lock to obtain green.

For Kotlin scripts, use the project-configured Gradle task and keep build-logic coverage specific
