---
name: tdd-red-green
description: Run a focused Vitest red-to-green loop for a named TypeScript behavior and report both exit codes.
---

# Vitest Red to Green

1. Run `pnpm vitest run <named-test-file>` from `toolkit/` before the implementation change.
2. Confirm the named assertion is red for the behavior being added or fixed, and capture the
   assertion text and exit code.
3. Apply the smallest implementation change that satisfies the assertion.
4. Rerun the same command. Confirm it is green and report its exit code.
5. Leave the locking assertion in place and run broader required gates after the focused loop.

If the named test does not fail before the implementation change, stop and correct the proof
instead of treating a pre-existing green result as red evidence.
