# Vue TDD with Vitest

For a behavior change, name the Vitest file that locks the behavior before changing production
code. Run that file and confirm the new assertion fails for the intended reason. Apply the
smallest implementation change that makes it pass, then rerun the same file and record both exit
codes.

Keep the lock specific to the behavior being changed. Do not weaken, skip, or delete an existing
assertion to obtain a green run. This is a minimal local copy of the TypeScript-family rule because
the current private pack loader addresses rule files within the selected pack.
