# Known issues & open items

The toolkit is **directly usable**: the committed artifacts under
`toolkit/workflows/` launch via `scriptPath` with no toolchain, and a real
39-agent review run validated the full chain end to end. Nothing below blocks
local use.

## Open items

| # | Issue | Impact | Status |
|---|---|---|---|
| 1 | **`budgetFloor` calibration is a cross-run approximation** — the semantics are implemented and tested, and a mechanism ships to ground the number in real runs, but the runtime exposes no per-agent token primitive, so tokens-per-agent stays a statistical estimate. | Floors may cut too early or too late until enough real runs accrue. | `pnpm dwt:calibrate record` captures a real run's agent count + `rt.budget.spent()` + the notification token `usage`; `derive` segregates the two signals (never blends them) and prints `floor ≈ tokens-per-agent × (claims × votes + synthesis) × margin`, or an honest "no signal" rather than a fabricated number. The figure is a lower bound — refine it once ~10 real runs accrue. |

## External limitations — mitigated, not fixable here

| # | Limitation | Mitigation |
|---|---|---|
| A | **The Workflow tool is a research preview**; part of the surface the toolkit relies on (`isolation`, `label`, `budget`, the determinism bans, the 512 KB cap) is verified against the binary, not officially documented. An upgrade can change it. | Firewalled behind `@workflow-toolbox/runtime` — exactly one package changes. Re-verify after upgrades; the `upgrade-canary` skill does exactly this. |
| B | **Silent exclusion over 512 KB** on the `name` path: an oversized file in `.claude/workflows/` is simply never registered — no error anywhere. | `dwt build` warns from 400 KB and throws at 512 KB. Hand-edited artifacts past the cap remain a blind spot. |
| C | **The name registry refreshes lazily** — invocation by `name` can fail right after install. | Use `scriptPath`, which is always reliable; documented in the README. |
| D | **Agents die mid-reasoning at context limits — systematically.** Several occurrences during development; the dying agent's last mid-thought text arrives as a normal-looking completion. | The four defence layers encoded in the examples + README: a schema at every consumed boundary, fresh-evidence verification, decomposed agent scopes, and `WorkflowOutput.error` + `resumeFromRunId`. A discipline, not a fix. |
