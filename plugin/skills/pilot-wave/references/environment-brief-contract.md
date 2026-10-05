This reference belongs to the pilot-wave skill; all paths are relative to the skill directory (the parent of references/).

## The environment-brief contract (reference)

This is the plugin-side contract the agents honor. A spawner fills the blocks; an agent
resolves anything left blank via the cascade. Publish-surface scoping is part of the brief
because it is a generic end-user concern: many projects mix a public repo and a private one,
and only the spawner knows which is which.

| Block | Meaning | Fallback if omitted |
|---|---|---|
| `KNOWLEDGE_BASE_INDEX` | READ-ONLY session knowledge base | `WT_KNOWLEDGE_BASE_INDEX`, then derivation, then none |
| `TASK_TRACKER` | which tracker + how to reach it | auto-detect (board pointer / CLI / task file) |
| `EXECUTOR_LANE` | heavy-increment lane | probe for an available + consented bridge, else absent and split |
| `WORKTREES_DIR` | isolation-worktree home | sibling worktrees dir |
| `REPORT_DIR` | file-report home | a named scratch dir (naming constraint — see Step 1) |
| `QUOTA_POSTURE` | verification-budget posture | comfortable; degrade under pressure |
| `WATCHER_REGISTRY` | which watchers cover the delegate + their signal | absent; state so once in the report |
| publish surface | which repos/dirs are public vs private | assume all private; treat public writes as escalations |

