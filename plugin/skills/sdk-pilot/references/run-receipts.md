# SDK pilot run receipts

The summary's `budget.delta_seconds` reconciles actual and declared time, including boundary grace.
`longest_tool_call` identifies the completed call behind its duration; `unfinished_tool_calls` lists
calls still open at run end. If assistant messages arrived after the last result, `fresh_tokens` and
`turns` read `unavailable`, with a message-usage lower bound and completed-turn count alongside.
`cost.coverage` separates attributed, inferred and unmatched dollars and marks a lower bound when
sources or model prices are missing; the same breakdown is printed on the report's `Run total:` line.

While the run is active, the lane's usage.json receipt is atomically refreshed for each SDK assistant usage
receipt. What is running uses those receipts for live phase and run totals; delegated lane usage is
added when that lane ends because its CLI does not expose partial usage. Dedicated parent-waker
assistant-message usage is reported separately under `summary.parent_wakes[]` and excluded from pilot totals.
An approval-hold notice produces `not-delivered:held`; other recipient delivery notices produce
`unconfirmed:recipient-notice`, even if the earlier tool result reported success. A hold establishes
non-delivery at observation time; other notices leave delivery unknown. An admitted send with no
correlated result or recipient notice records `unconfirmed:<reason>` for `timeout`, `stream-ended`,
`aborted`, `error` or a later `denied` call. Without an admitted send, failures remain
`not-delivered:<reason>`. Without a recipient notice, correlated results keep `transport-accepted` or `not-delivered:transport-refused`,
and account refusals keep `not-delivered:account` even when a notice arrives. Requests blocked by a previous consumer that failed
to drain record `not-delivered:prior-waker-stuck`. Ordinary run-end cancellation records
`not-delivered:aborted` before send admission or `unconfirmed:aborted` after admission without a confirmed
outcome. Retry still requires `tool_use_id` to be null and a `not-delivered:denied` or
`not-delivered:no-call` receipt; an `unconfirmed:*` receipt never retries. `not-sent:*` outcomes are unchanged.

To total archived costs mechanically, run `node "${CLAUDE_PLUGIN_ROOT}/bin/wt-run-cost.mjs"
<reports-directory>`. It totals complete runs by LITE/FULL/HARD route and provider family, lists every
run's unknown count, and lists partial or unknown-outcome runs separately; add `--include-partial` only
when those runs should enter route totals. Legacy run and lane windows are inferred from archived
timestamps or documented mtime fallbacks, so do not hand-enter a window for routine aggregation.

## Parent wake e2e

The real-account parent-wake fixture is `node toolkit/scripts/sdk-parent-wake-e2e.mjs
--parent-session '<name> [<ref>]' --parent-mode <bypass|prompting> --keep-fixture` in a source checkout.
An arbiter runs it detached with the receiver idle and no watcher armed, captures the receiver's
transcript, and submits any chosen reading through `decide`. `--wait-ms` defaults to 240000 and
`--pilot-model` to sonnet; critic lanes are local stubs. Transport acceptance alone is not the e2e proof.
