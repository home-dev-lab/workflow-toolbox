# Permission classes for autonomous sessions

Two facts decide the shape, both measured (2026-09-09, Claude Code 2.1.266):

- **A session in auto mode can edit its own project and user settings** — allow rules included —
  with no prompt: a write under `.claude/**` reaches the classifier and the classifier let it pass.
  So nothing in project or user settings is a fence against the session that reads it.
- **`permissions.deny` rules are enforced in `bypassPermissions` mode**, with no plugin and no hook
  loaded. A deny rule in the MANAGED settings (a root-owned file the session cannot write) is the
  one floor a session cannot lift.

The classifier's `hard_deny` (exfiltration class) clears through nothing — not a message, not an
allow rule — and it does not exist in bypass mode; leaving auto mode removes it along with the
prompts.

## The three floors of a permanently autonomous session

| floor | where | what it refuses | can the session lift it? |
|---|---|---|---|
| managed `permissions.deny` | `/etc/claude-code/managed-settings.json` (root) | the never-list below | no |
| the plugin guard hooks | `wt-main-guard-hook.mjs` and siblings | refspec branch deletion (`git push X :b`), catastrophic `rm -rf`, `git reset --hard` on a dirty tree | only by editing the plugin cache |
| the secret guard (where installed) | Function Hooks plugin | a secret value reaching the context or an outbound message | no, if loaded from a path it does not own |

Pair them with `permissions.defaultMode: "bypassPermissions"` (user settings) for the sessions
that must never ask. Order matters: the managed deny lands FIRST, the mode switch second.

## The never-list as managed deny rules — measured set

Every rule below was exercised from a headless session in `bypassPermissions` with only these
rules loaded; each named command was refused, and a plain `git push --dry-run` still ran.

```json
{
  "permissions": {
    "deny": [
      "Bash(git push --force*)", "Bash(git push * --force*)",
      "Bash(git push -f*)", "Bash(git push * -f*)",
      "Bash(git push --delete*)", "Bash(git push * --delete*)",
      "Bash(git push -d*)", "Bash(git push * -d *)",
      "Bash(npm publish*)", "Bash(pnpm publish*)", "Bash(yarn publish*)",
      "Bash(pnpm changeset publish*)", "Bash(npx changeset publish*)",
      "Bash(git branch -D*)", "Bash(git clean -f*)",
      "Bash(git checkout -- .*)", "Bash(git checkout .*)", "Bash(git checkout -f*)",
      "Bash(git restore .*)", "Bash(git stash drop*)", "Bash(git stash clear*)"
    ]
  }
}
```

Not expressible as a rule, measured: `git push X :branch` — a trailing `:*` is read as the prefix
separator, so five variants all let the command run; the guard hook covers it. Do not write
`Bash(npm * publish*)`: it also refuses `npm run publish-nothing`.

`git reset --hard` is deliberately absent: a fresh worktree is re-based with it on a clean tree.
It belongs to a conditional guard (refuse when `git status --porcelain` is non-empty), not to a
flat deny.

## Allow classes — only useful while a session still prompts

In auto or default mode, an allow rule resolves before the classifier and removes a prompt for a
class of commands. Recommended, not measured against every project policy:

- Node / pnpm workspace: `Bash(git:*)`, `Bash(pnpm:*)`, `Bash(node:*)`, `Bash(gh:*)`,
  `mcp__planka__*`, `Bash(wt-lane:*)`, `Bash(wt-lane-wait:*)`
- Python project: `Bash(git:*)`, `Bash(python:*)`, `Bash(python3:*)`, `Bash(pip:*)`, `Bash(gh:*)`,
  `mcp__planka__*`, `Bash(wt-lane:*)`, `Bash(wt-lane-wait:*)`
- Generic project: `Bash(git:*)`, `Bash(gh:*)`, `mcp__planka__*`, `Bash(wt-lane:*)`,
  `Bash(wt-lane-wait:*)`

Writes below `.claude/**` or `.git` reach the classifier even with a matching allow rule.
