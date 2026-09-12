# Groovy TDD with Spock

For a behavior change, add a focused Spock specification that fails for the intended reason before
changing production code. Run the project's Gradle wrapper, for example `./gradlew test
--console=plain`, and record the nonzero red exit code. Make the smallest implementation change,
then rerun the same command and record exit code `0`.

Use given-when-then blocks and keep the lock specific to the behavior. Do not weaken, skip, or
