This reference belongs to the workflow-debugger skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## The `wt-observe` launcher CLI (ships in the same package)

`@workflow-toolbox/debugger` also ships `wt-observe`, the lifecycle CLI for the
Workflow Observatory companion app (the live run UI). `wt-debug` reads a run AFTER
the fact; `wt-observe` manages the server that watches runs as they happen:

| Verb | What it does |
|------|--------------|
| `start [--source <dir>]… [--watch] [--enable-launch]` | resolve the source set (`--source` flags > the persistent config list > auto-discovery of `~/.claude*` config dirs), then adopt a healthy running server or spawn a detached one; `--enable-launch` opts the instance into live launches |
| `stop` | SIGTERM the owned server (identity-checked against the pidfile) and clear the pidfile |
| `status` | pidfile + live health (sources served, launch opt-in), human-readable |
| `launch <workflow> [--args <json>] [--source <label\|dir>]` | POST `/api/launch` a REGISTERED workflow by name — never an arbitrary path — and print `{ runId }` |
| `await <runId>` | block until the run finishes and print `{ runId, status, result }`; its exit code is the outcome (pair it with a background shell — the exit IS the notification) |
| `resume <runId> [--source <label\|dir>]` | the sanctioned explicit recovery of a settled-FAILED run (POST `/api/runs/:runId/recover`; distinct from the server's internal pause-transport resume) |
| `prune` | delete test/probe run records so they stop lingering in the timeline; a still-running record (no terminal json yet) is invisible to prune — live runs can never be deleted |
| `config show \| add-source <dir> \| remove-source <dir> \| add-remote <url> [--token\|--token-file\|--label] \| remove-remote <url>` | manage the persistent source list and remote-hub mounts (never auto-written by `start`; re-adding a remote's canonical URL is how you rotate its credentials) |

Two mechanics worth knowing:

- **Server resolution.** The spawn target is the Observatory checkout, located from
  `$DWT_OBSERVE_ROOT` or by walking up from the current directory (interim posture,
  pre-npm distribution of the app).
- **Per-server API token + identity checks.** `start` generates a random token, hands
  it to the server via env, and records it in the (0600) pidfile; every subsequent
  `/api` action authenticates with that token AND identity-checks the pid first — a
  foreign server that happens to sit on the same port is never commanded.

