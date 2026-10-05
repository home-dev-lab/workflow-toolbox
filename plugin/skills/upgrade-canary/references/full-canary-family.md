This reference belongs to the upgrade-canary skill; all paths are relative to the skill directory (the parent of references/).

### The full canary family

`pnpm canary` runs the matrix; each member is individually runnable when you want
to re-verify one claim (all from `toolkit/`):

| Command | Re-verifies |
|---|---|
| `pnpm smoke` | a VALID committed artifact still launches and completes through the real runtime |
| `pnpm canary:edge` | the runtime still REJECTS what it must (the 512 KB cap; a statement before `meta`) |
| `pnpm canary:nesting` | `workflow()` composes one level deep — and still throws beyond that level |
| `pnpm canary:budget` | budget semantics across two strictly-sequential orchestrator launches |
| `pnpm canary:version` | the cheap gate above (CLI/SDK versions + last verdict vs the marker) — read-only |
| `pnpm canary:agents` | which SDK agent-definition fields the runtime honors (feeds the tested least-privilege recipe builder in `smoke/src/least-privilege.ts`) |
| `pnpm canary:observer` | whether the EXPERIMENTAL `observer:` agent-pairing surface actually attaches at runtime (see below) |
| `pnpm wt:calibrate` | records real-run token signals and derives a grounded `budgetFloor` estimate |
| `tsx packages/smoke/src/capabilities-probe.ts` | the per-run capabilities channel (launch `args` → each agent's declared capabilities) end-to-end |

