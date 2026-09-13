---
name: artifact-server
user-invocable: true
description: >-
  Use when a local file needs a clickable localhost or tailnet link in chat or a Function Hooks
  pane, or when the user asks how to configure, inspect, stop, or restart the artifact server.
argument-hint: "[file-path]"
---

# Artifact server

The artifact server turns registered local files into clickable links. A persistent monitor for
each Claude session starts or attaches to one per-user server and keeps that session registered even
while idle. It is enabled by default; set `WT_ARTIFACT_SERVER=0` before starting Claude Code to
disable it.

## Roots and links

When `WT_ARTIFACT_SERVER_ROOTS` is unset, the monitor registers the current project's existing
`.claude/reports` and `.claude/worktrees` directories. The project is the session cwd's Git root, or
the cwd when it is not in a repository. Their mounts are `<project>-reports` and
`<project>-worktrees`; projects with the same basename receive stable short hash suffixes. The home
directory is never the default.

Configure several roots with the platform's path delimiter (`:` on POSIX, `;` on Windows). An entry
is `name=path`, or a bare path named from its basename. Names must be unique:

```bash
export WT_ARTIFACT_SERVER_ROOTS="reports=/work/project/.claude/reports:/work/shared/artifacts"
```

Files mount at `/<name>/...`. Different sessions can register different roots; the server serves
their deduplicated union. Each monitor owns its registration and removes it when that session exits.
There is no HTTP registration or other network control endpoint.

Always ask the helper for a link. It picks the longest matching root and exits 3 outside all roots:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" url "/absolute/path/to/report.md"
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" url "/absolute/path/to/report.md" --remote
```

`--remote` exits 3 when no tailnet URL is available. In a normal shell, replace
`${CLAUDE_PLUGIN_ROOT}` with the installed plugin root.

## Lifecycle

The default port is stable for the OS user in the 48000-48999 range. Set
`WT_ARTIFACT_SERVER_PORT` to override the first candidate. Discovery probes every candidate for the
service identity and current OS uid before choosing a free port. A foreign listener causes fallback
through up to 20 ports, and concurrent starts resolve through kernel bind contention.

The server uses an owner-only mode-0700 state directory under:
`$XDG_STATE_HOME/wt-artifact-server` when set, otherwise `~/.local/state/wt-artifact-server` on
Linux, `~/Library/Application Support/wt-artifact-server` on macOS, or
`%LOCALAPPDATA%\wt-artifact-server` on Windows. It refuses a directory owned by another uid or
writable by group/others. Each monitor atomically writes one mode-0600 `registrations/*.json` file
containing its PID, roots, deny policy, and start time. `server.json` is also mode 0600 and records
the real port, local and remote URLs, pinned roots, PID, version, and start time.

The server checks registration PIDs with `process.kill(pid, 0)` every two seconds. An idle live
session keeps it alive. Clean removal of the last registration stops it immediately; a dead
monitor's registration is ignored and removed after a 10-minute grace, configurable with
`WT_ARTIFACT_SERVER_IDLE_GRACE_S`. A newer plugin never replaces an older running server
automatically; its monitor prints one restart notice.

Human-only operator commands are:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" stop
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" restart
```

`stop` and `restart` refuse while sessions are registered, and fail closed if the uid, count, or
process identity cannot be verified. Add `--force` to override the registration refusal. On Linux,
the state PID's `/proc/<pid>/cmdline` must contain `wt-artifact-server.mjs`; other platforms have a
weaker identity check and require `--force`. These controls are CLI-only and are not agent tools.

## Tailscale

The server always binds `127.0.0.1`. If `tailscale ip -4` detects a local Tailscale address, it also
binds that address and accepts the machine's MagicDNS name from `tailscale status --json`. Failure
to detect Tailscale degrades to local-only operation. The server never configures Tailscale Serve.

The direct remote URL is `http://<tailscale-ip>:<port>`. Function Hooks `Link` requires HTTPS; an
operator can configure the tailnet-only proxy manually:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<port>
```

When that proxy is detected, `--remote` uses `https://<machine>.<tailnet>.ts.net`. Never use
`tailscale funnel`, which would expose the server publicly.

There is no password, token, cookie, or authentication beyond Tailscale membership. Every device on
the tailnet that can reach the server can read every allowed file under every registered root. The
per-user derived port separates local users' discovery, but it does not protect files readable over
the tailnet.

## Serving security

- Only `GET` and `HEAD` are accepted. Host is restricted to localhost, loopback, the detected
  Tailscale IP, and detected MagicDNS name. No CORS permission is sent.
- Every path is checked lexically and by realpath. Traversal and symlinks escaping a root receive
  403. Roots are canonicalized only when first observed and pinned; replacing a root with a symlink
  makes it unavailable until a new session registers it.
- The default case-insensitive deny list blocks `.git`, `.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `id_ed25519*`, `credentials*`, and `*.secret*`. `WT_ARTIFACT_SERVER_DENY` adds patterns. Only
  `WT_ARTIFACT_SERVER_ALLOW_UNSAFE_DENYLIST=1` replaces the defaults. Policy is per registration and
  is checked against canonical path segments plus the root basename, so benign symlink aliases do
  not bypass it.
- Markdown raw HTML is escaped. `.txt`, `.log`, and `.json` are escaped; `.html` is served unchanged
  but sandboxed by CSP without scripts or same-origin authority. Raw SVG and unknown content use the
  same sandbox CSP; generated Markdown and indexes use a strict no-script CSP.
- Health reports service version and OS uid. UID and Linux command-line checks prevent cross-user
  attachment and accidental stale-PID signalling; they are not cryptographic attestation against a
  malicious process running as the same user. There is no rate limit or file-size limit.
