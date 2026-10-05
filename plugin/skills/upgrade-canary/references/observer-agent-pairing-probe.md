This reference belongs to the upgrade-canary skill; all paths are relative to the skill directory (the parent of references/).

### The observer-agent-pairing probe (`pnpm canary:observer`)

An `AgentDefinition.observer?: string` names another agent type as a read-only
background observer of the agent that carries it — the observer gets periodic
activity digests and reports via the `ObserverReport` tool, but never
participates in the task. This is what the pilot suite's `pilot-watchdog` /
`pilot-orchestrator-watchdog` pairing relies on. It is **experimental,
undocumented, and gated at process start** by
`CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1` — absent, the field is silently
ignored — so this probe exists to catch a silent SDK-upgrade regression on it,
the same way `pnpm canary:agents` catches one on tool/skill/MCP fencing.

Standalone (like `canary:agents`, NOT folded into `pnpm canary`'s per-runtime-target
matrix — see the module header in `packages/smoke/src/observer-canaries.ts` for why).
Run it directly:

```bash
CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS=1 pnpm canary:observer
```

Without the env var it reports every leg `NOT_MEASURED` and spends zero live
launches — it never silently assumes "attached" or "not attached" just because
the feature couldn't be exercised.

⚠ **Corrected 2026-08-03, read before re-tuning this probe or trusting a `NOT_ATTACHED`
from it.** This probe drives a headless SDK `query()` session in which the model
calls the `Agent`/`Task` tool to spawn a NESTED subagent. That is a DIFFERENT
launch shape from the INTERACTIVE Agent-tool spawn path — the one the pilot
suite's `pilot-watchdog` pairing actually uses in production — and this repo has
**independent, on-disk confirmation the interactive path attaches observers
today** (a live session's own `pilot-watchdog` transcripts: a `role:"user"`
message with `origin: {"kind": "observer-activity"}` wrapping
`<pilot-activity>...</pilot-activity>`, delivered into the observer's own
transcript). Nothing has ever independently shown the headless/nested-spawn path
this probe drives can attach at all. So a clean negative on THIS probe's legs —
enough observed turns, zero attach signal — reports `NOT_MEASURED`, **never** a
loud `NOT_ATTACHED`: it cannot currently distinguish "this specific launch shape
never attaches" from "attachment broke". Building a canary for the interactive
path itself is an explicit, acknowledged gap (out of scope for this pass) — see
`observer.ts`'s `classifyAttachment` doc for the full reasoning and the
`pathHasWorkingBaseline` parameter that encodes it.

Five legs, each a THREE-state verdict (`ATTACHED` / `NOT_ATTACHED` / `NOT_MEASURED`
— never collapsed to a boolean, so "couldn't measure" never reads as "broken"):

| Leg | What it checks |
|---|---|
| `observer-flag-present` | the feature gate env var — always informational, `ok:true` either way |
| `observer-positive-control` | an ANONYMOUS spawn (no `name`), via the headless/nested-spawn path above — a clean negative here reports `NOT_MEASURED` (see the correction above), never `NOT_ATTACHED`, because that path has no independent confirmation it can attach at all. The runner still SKIPS every downstream leg whenever this one is not `ATTACHED` (reports them `NOT_MEASURED`, reason "skipped") — a downstream result would be equally uninterpretable either way |
| `observer-report-tool` | mechanical assertion: the observer's `ObserverReport` call succeeds (folded from the SAME run as the positive control) |
| `observer-sendmessage-refused` | mechanical assertion: `SendMessage` is REFUSED for the observer even when declared in its `tools:` — this is the documented, CORRECT contract ("an observer must never participate in the task"); only an unexpected SUCCESS is a regression |
| `observer-named-headless` | a SEPARATE run, named spawn, same headless/nested-spawn path and same "no known baseline" caveat as the positive control. It is NOT a reproduction of the interactive-CLI "named spawn rebuilds its AgentDefinition and drops the observer pairing" bug (that mechanism is specific to the in-process "teammate" path an interactive session takes for a named spawn; a headless SDK session does not go through it) |

Detection reads the parent session's OWN SDK message stream — never subagent
transcript files off disk — via two signals: (a) `subagent_type` tagging on
assistant/user messages (the same mechanism `sdk-agent-probe.ts` proved), and
(b) the harness-emitted `origin.kind` ENVELOPE (`'observer-activity'` on a
digest delivered TO an observer, `'observer'` on a report delivered FROM one).
The envelope, never the payload text, is what is matched — a detector that
greps for a literal marker string it also planted would be a guaranteed false
positive (a documented trap from the manual PoC this probe replaces).

An observed-agent prompt forces 3 sequential tool calls before this probe will
trust a "no digest seen" result at all — fewer than that is always
`NOT_MEASURED` regardless of the baseline question above
(`MIN_OBSERVED_TOOL_CALLS` in `observer.ts`).

**Known harness quirk worth knowing before re-tuning this probe**: the SDK's
`Agent` tool defaults `run_in_background` to `true`, and even with it forced
`false`, the tool's own `tool_result` can arrive as an early acknowledgment
*before* the spawned agent's own tool calls appear in the stream — a parent
prompt that replies as soon as the tool call "returns" ends the whole session
(and the still-running subagent + its observer) prematurely. The prompt in
`observer-canaries.ts` works around this by making the parent poll via
`Bash sleep` in a loop until it has explicit confirmation the spawned agent
actually finished, rather than trusting the tool_result alone.

