# Java Lint, Typecheck, and Build

Adapted from ECC, `docs/tutorials/03-java-development.md`.

Use the formatter configured by the project, rather than imposing one; `google-java-format` is an
optional project choice. Run compilation through the build tool: `mvn -q test` or `mvn -q verify`
for Maven, and `gradle test --console=plain` or `gradle build --console=plain` for Gradle. Treat a
gate as green only when it exits `0`; record nonzero exit codes and repair the underlying failure.

SpotBugs and Checkstyle are optional project tools, not pack requirements. Run them only when the
project configures them, through Maven or Gradle.

For `.groovy` sources and Gradle build scripts, run Spock or JUnit through the same build tool.
No diagnostics are provided for Groovy.
