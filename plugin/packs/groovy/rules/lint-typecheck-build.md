# Groovy and Gradle Gates

Use the formatter and static-analysis tools configured by the project. Run compilation and tests
through the Gradle wrapper: `./gradlew test --console=plain` or `./gradlew build --console=plain`.
Treat a gate as green only when its process exits `0`; record nonzero exits and repair their cause.

For a long-running gate, use a detached process with an appended exit marker and poll until the
marker is present. A partial log is not a gate result.
