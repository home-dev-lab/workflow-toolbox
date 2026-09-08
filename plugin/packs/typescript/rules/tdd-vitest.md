# TypeScript TDD with Vitest

For a behavior change, name the Vitest file that locks the behavior before changing production
code. Run that file and confirm the new assertion fails for the intended reason. Apply the
smallest implementation change that makes it pass, then rerun the same file and record both exit
codes.

Keep the lock specific to the behavior being changed. A test that merely exercises an adjacent
path is not proof of the fix. Do not weaken, skip, or delete an existing assertion to obtain a
green run.

After the focused loop is green, run the repository gates required by the task. A behavior-adding
change must increase the suite's passing-test count from its pre-edit baseline.
