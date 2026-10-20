This reference belongs to the workflow-debugger skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## Thin-envelope runs

An `OPENCODE_REFUSED:` line with exit 3 is an admission outcome: no task was spawned and no
answer was written. Inspect the caller's `WT_OPENCODE_ENVELOPE_ADMISSION` configuration
(or `WT_OPENCODE_VERIFY_ADMISSION` for the verifier) and its matching `_TIMEOUT_MS` override
(default 10000 ms). The trusted module sees the absolute repository and rendered requests;
configuration/import/export/return failures, worker crashes and deadline expiry all refuse
closed. Content-free availability/skill preflights run before admission. Do not infer a missing
model answer or bypass the policy; the bridge agent should relay this line verbatim and stop.

`workflow-toolbox:opencode-envelope` is a different lane shape from the heavy wrappers above. The
script writes its invocation artifacts under the machine state root's (XDG_STATE_HOME or ~/.local/state)
`wt-envelope/<pid>-<timestamp>-<random>/` (or `WT_ENVELOPE_WORKDIR` when explicitly set),
and the manifest for that invocation is `envelope.manifest.json`; the brief `MANIFEST: <path>` line
on stdout is the handle the debugger follows into the manifest, the per-task answer files, and the
per-task logs (`plugin/bin/wt-opencode-envelope.mjs:114-116`,
`plugin/bin/wt-opencode-envelope.mjs:659-675`, `plugin/CHANGELOG.md:11-12`).

- **Where the evidence lives.** The manifest path comes from the Bash output's `MANIFEST:` line;
  each task record in that JSON carries its own `answerFile`, `log`, `model`, `durationMs`, and
  optional `usage`, and each per-task log ends with `EXIT=` because the script owns the CLI call
  and its timeout/logging (`plugin/bin/wt-opencode-envelope.mjs:10-16`,
  `plugin/bin/wt-opencode-envelope.mjs:671-675`, `plugin/agents/opencode-envelope.md:62-69`).
- **Read `laneTokens` literally.** The verifier hook sets `meta.laneTokens` only when
  `usage.tokens` exists, and omits the key entirely otherwise; absent means UNKNOWN, never zero
  (`plugin/bin/wt-verifier-cli-guard-hook.mjs:689-694`,
  `plugin/bin/wt-verifier-cli-guard-hook.mjs:843-848`).
- **Expect one observatory node per external call, not one per envelope agent.** The envelope hook
  unfolds the manifest's `tasks` array and writes one child node per task, and the changelog calls
  out the same invariant as "One envelope, N external calls, N nodes"
  (`plugin/bin/wt-verifier-cli-guard-hook.mjs:843-869`, `plugin/CHANGELOG.md:198-207`).
- **CLI-called vs self-answered is different here.** A wrapper proves delegation with a real CLI
  `tool_use` in the wrapper transcript. A thin envelope proves delegation with the `MANIFEST:` line
  plus the manifest-backed answer/log files. If an envelope agent answered itself, you will find
  neither artifact even if the transcript shows some unrelated tool call such as `git diff`
  (`plugin/bin/wt-opencode-envelope.mjs:118-122`, `plugin/bin/wt-opencode-envelope.mjs:659-675`).
- **`resumeFromRunId`: treat resumed envelopes conservatively.** The workflow runtime does replay
  completed `agent()` calls from cache in the same session, but this skill does not verify any
  envelope-specific idempotency contract in code; the script itself is "run the batch, write the
  manifest" per invocation, so if a routed envelope agent re-runs, treat it as re-running its
  batch (`plugin/skills/workflow-debugger/SKILL.md:89-105`,
  `plugin/bin/wt-opencode-envelope.mjs:10-16`, `plugin/bin/wt-opencode-envelope.mjs:641-675`).

If the class fires, name it plainly rather than describing the run as merely "wrong" —
"the external model was never reached; the wrapper answered in its place" is a
different, more actionable finding than "the review missed something."
