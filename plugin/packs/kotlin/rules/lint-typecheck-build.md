# Kotlin Lint, Typecheck, and Build

Use the formatter and lint tools configured by the project; `ktlint` and `detekt` are optional
project choices, not pack requirements. Compile and test through the build tool: `gradle test
--console=plain` or `gradle build --console=plain` for Gradle, and `mvn -q test` or `mvn -q verify`
for Maven. Treat a gate as green only when it exits `0`.

For Gradle Kotlin DSL files, run the configured Gradle task that compiles the build logic. Do not
assume a language-server diagnostic covers a build model that the project has not imported.
