# Permission classes for autonomous sessions

These are recommended `permissions.allow` classes, not measured runtime facts. An allow rule is
resolved before the classifier. Writes below `.claude/**` or `.git` still reach the classifier, and
`hard_deny` clears only through an allow rule or by leaving auto mode.

## Node / pnpm workspace

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)", "Bash(pnpm:*)", "Bash(node:*)", "Bash(gh:*)",
      "mcp__planka__*", "Bash(wt-lane:*)", "Bash(wt-lane-wait:*)"
    ]
  }
}
```

## Python project

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)", "Bash(python:*)", "Bash(python3:*)", "Bash(pip:*)", "Bash(gh:*)",
      "mcp__planka__*", "Bash(wt-lane:*)", "Bash(wt-lane-wait:*)"
    ]
  }
}
```

## Generic project

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)", "Bash(gh:*)", "mcp__planka__*", "Bash(wt-lane:*)", "Bash(wt-lane-wait:*)"
    ]
  }
}
```

For a mandated autonomous session, pair the applicable class with no-prompt permission mode and
the plugin guards. The measured guard boundary remains: publish, force-push, remote deletion, and
`rm -rf` are refused by `wt-main-guard-hook.mjs`; the classes above are recommendations, not a
claim that every classifier or project policy permits them.
