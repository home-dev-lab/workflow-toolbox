---
name: quality-gate
user-invocable: true
description: >-
  Invoke when measuring toolkit quality, preparing a release Quality section, tightening a ratchet,
  or turning the current quality baseline into tracker debt cards.
---

# Operate the quality gate

Enter `toolkit/`.

Run `pnpm quality` without another Vitest suite running.

Run `pnpm quality:delta` before a release.

Paste its Markdown table under the release entry's `### Quality` heading.

Do not write the Quality table by hand.

Lower at least one maximum ratchet or raise at least one coverage ratchet.

Run `pnpm quality:baseline` after the improvement.

Stage `quality-baseline.json` with the release record.

Run `pnpm quality:debt-cards -- --format json` to obtain tracker-neutral cards.

Pipe that JSON into the active project's tracker adapter.

Preserve each card's `id` as the tracker idempotency key.

Preserve the `tooling` and `chore` labels.

Preserve P1 for `plugin/bin/` and P2 for other paths.

Use `--top N` to change the default five offenders per judge.

Add `gates: quality-skipped — <reason>` only for a measured release exception.
