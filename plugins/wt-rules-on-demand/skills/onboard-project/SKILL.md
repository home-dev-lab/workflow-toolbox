---
name: onboard-project
description: Migrate a project's static rules to rules on demand with transcript proof, and register the project for daily follow-up.
---

1. Resolve the installed `wt-rules-on-demand` plugin root from the plugin list. Resolve the project's absolute root P and the active Claude config directory (respect `CLAUDE_CONFIG_DIR` for work profiles).
2. Run `node <plugin-root>/scripts/onboard-project.mjs propose --project P --out <dir outside P> --config-dir <config dir>`.
3. Split the items under `<out>/items/` into groups of about 8 to 10. Spawn one `rules-migrator` agent per group, `model: sonnet`; give each agent its group's item list, each item's `item.json`, source rule, `TRIGGERS.md`, proposal format, and its own item directory. Require `decision.json` (`split`, `whole`, or `static`) per item; for split, require body-only `core.md` and `at-act.md` plus `spec.json`; for whole, require `spec.json`. Split only the act-bound part. Choose `static` with a named reason when no deterministic trigger exists. Never edit the project during proposal authoring. Use only `bash`, `tool`, or `path` triggers; a `prompt` trigger is allowed only after a disposable test session shows a prompt-triggered rule actually reaching the model on this host.
4. Compute the transcript slug by replacing **every** character outside `[A-Za-z0-9-]` in P with `-`. Run `node <plugin-root>/scripts/onboard-project.mjs prove --project P --out <out> --config-dir <config dir> --transcripts <config dir>/projects/<slug of P>`.
5. Read `<out>/onboard-report.md`; review the per-trigger counts, proposed triggers, compliance checks and verdicts. Run `apply` without `--confirm` to view the file plan.
6. **STOP and ask the project owner for explicit go-ahead** before running `node <plugin-root>/scripts/onboard-project.mjs apply --confirm --project P --out <out> --config-dir <config dir>`.
7. To undo, run `node <plugin-root>/scripts/onboard-project.mjs revert --project P --out <out> --config-dir <config dir>`.
