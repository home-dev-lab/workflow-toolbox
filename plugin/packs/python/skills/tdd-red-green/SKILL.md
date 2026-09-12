---
name: tdd-red-green
description: Run a focused pytest red-to-green loop for a named Python behavior and report both exit codes.
---

# pytest Red to Green

1. Run the project's focused pytest command for the named test before the implementation change.
2. Confirm the named assertion is red for the behavior being added or fixed, and capture the
   assertion text and exit code.
3. Apply the smallest implementation change that satisfies the assertion.
4. Rerun the same command. Confirm it is green and report its exit code.
5. Refactor only while the focused test remains green, then run broader required gates.

Use the project's package-manager choice to run pytest. pip, uv, and poetry are common choices;
the project's own choice wins. If the named test does not fail before the implementation change,
stop and correct the proof instead of treating a pre-existing green result as red evidence.

Adapted from ECC, `plugin/agents/python-tdd-guide.md`.
