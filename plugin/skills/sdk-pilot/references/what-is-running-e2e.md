# What is running lifecycle e2e

This procedure proves that the real Claude Code host renders an SDK LITE run's structured
`.lane/lifecycle.json` transitions. It requires Claude credentials, a small live tracker card, `tmux`, and a
dedicated card worktree. Keep the complete command output and the owner's screenshots as integration evidence.

## Mechanical host fixture

From the repository root, run the host-click e2e with its structured timeline fixture:

```bash
node toolkit/packages/build/test/fixtures/what-is-running/host-click-e2e.mjs \
  --plugin-dir "$PWD/plugin" --cwd "$PWD" --lifecycle-fixture true \
  --out "$PWD/.lane/wir-lifecycle-host-e2e" \
  | tee "$PWD/.lane/wir-lifecycle-host-e2e.log"
```

The fixture writes Discovery, TDD, and Verify entries to `.lane/lifecycle.json` and a deliberately conflicting
Plan entry to the runner log. A pass states that the structured source won, saves the host captures, and ends in
`EXIT=0`. Paste the command output verbatim into the integration report.

## Real SDK LITE run

1. Prepare a small card whose routing inputs select LITE, a dedicated worktree, and an exact regular card file as
   described in the parent `sdk-pilot` skill.
2. Launch `wt-pilot-runner.mjs` detached with the command in the parent skill. Keep its absolute worktree and log
   paths visible in the integration report.
3. In a separate terminal, start Claude Code with this checkout's plugin and open `/wir`:

```bash
claude --plugin-dir "$PWD/plugin"
```

4. Poll both sources without modifying them:

```bash
while ! grep -q '^EXIT=' <worktree>/.lane/sdk-pilot.log; do
  node -e 'const fs=require("node:fs"); const p=process.argv[1]; const x=JSON.parse(fs.readFileSync(p,"utf8")); console.log(JSON.stringify(x.phases.map(({phase,round,entered_at,exited_at})=>({phase,round,entered_at,exited_at}))))' <worktree>/.lane/lifecycle.json
  sleep 2
done
```

5. Capture the pane whenever its current stage changes. A normal LITE route visibly advances through Discovery,
   TDD, Verify, and Report, with the other canonical stages marked skipped, then waits for arbiter review. The pane
   must not say `(from log)` while `lifecycle.json` is valid.
6. Save the final pane screenshot, the complete `sdk-pilot.log`, the printed timeline samples, and the final
   `lifecycle.json`. Paste the terminal output verbatim into the report. If host automation cannot drive the pane,
   record that limitation and attach the owner's screenshots instead; do not substitute fixture output for the live
   run.

The timeline and runner-log reads use Node `fs` against `.lane/*` and do not depend on `/proc`, so this phase-source
check is portable across Linux, macOS, and Windows. Process discovery elsewhere in the pane remains capability- and
platform-specific.
