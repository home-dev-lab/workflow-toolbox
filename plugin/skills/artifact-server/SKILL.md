---
name: artifact-server
user-invocable: true
description: >-
  Use when handing the user a report or artifact path and a clickable localhost or tailnet link
  should be provided, or when the user asks how to configure, inspect, stop, or restart the server.
argument-hint: "[absolute-file-path]"
---

# Artifact server

The artifact server turns registered local files into clickable links. A persistent monitor for
each Claude session starts or attaches to one per-user server and keeps that session registered even
while idle. It is enabled by default; disable the `artifact_server` plugin option in Claude Code
settings, or use the `WT_ARTIFACT_SERVER=0` environment fallback when that option is absent.
A one-line SessionStart notice gives the link command only after probing a live server; otherwise it
reports status unknown without suggesting a link that may be dead.

The user-facing plugin options are `artifact_server`, `artifact_server_roots`,
`artifact_server_port`, `artifact_server_idle_grace_s`, and `artifact_server_deny`. A plugin option
wins over its corresponding `WT_ARTIFACT_SERVER*` environment fallback; an absent option and env
value use the defaults below. Option lists are comma- or newline-separated. The legacy roots env
fallback remains platform-path-delimited.

## Roots and links

When `artifact_server_roots` and `WT_ARTIFACT_SERVER_ROOTS` are unset, the monitor registers the current project's existing
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

Always ask the helper for a link. Never hand the user a file path: whoever proposes an artifact
must provide its complete URL. Prefer the remote URL whenever one exists because it works both on
the server machine and from another tailnet device; `localhost` only works on the server machine.
Try `--remote` first, then fall back to the local command only when it exits 3. The helper picks the
longest matching root and exits 3 outside all roots:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" url "/absolute/path/to/report.md" --remote
node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" url "/absolute/path/to/report.md"
```

`--remote` exits 3 when no tailnet URL is available. In a normal shell, replace
`${CLAUDE_PLUGIN_ROOT}` with the installed plugin root.

The deliverable is the single file's complete URL, not the root index. Index browsing is only a
local convenience and does not survive every path-mounted proxy: in particular, a trailing slash on
a Tailscale Serve mount root such as `/artifacts/` routes to the upstream root handler rather than
this server. Never construct or hand over such a mount-root link. Root-relative links in rendered
Markdown, such as `[other](/report.md)`, also target the domain root under a path mount because the
server cannot infer the proxy-owned prefix; artifact authors must use document-relative links.

## Lifecycle

The default port is stable for the OS user in the 48000-48999 range. Set the
`artifact_server_port` option, or its `WT_ARTIFACT_SERVER_PORT` fallback, to override the first candidate. Discovery probes every candidate for the
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
`artifact_server_idle_grace_s` or its `WT_ARTIFACT_SERVER_IDLE_GRACE_S` fallback. A newer plugin never replaces an older running server
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
binds that address and accepts the machine's MagicDNS name from `tailscale status --json`. On WSL,
if `tailscale` is unavailable, detection asks PowerShell to resolve `tailscale.exe` and converts that
returned path with `wslpath`; no Windows install directory is assumed. Discovery distinguishes a
successful lookup with no tailnet IP from an unavailable lookup, while local serving remains usable.
The server never configures Tailscale Serve.

Detection is a precondition for proxied access, not an optional convenience. Every Serve request
presents the MagicDNS Host, and that name enters the server's Host allow-list only when detection
finds it. A `421 Misdirected Request` therefore means the presented Host was not detected and admitted;
inspect Tailscale detection and server status before debugging the proxy, DNS, or firewall.

The direct remote URL is `http://<tailscale-ip>:<port>`. Function Hooks `Link` requires HTTPS; an
operator can configure the tailnet-only proxy manually:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<port>
```

When an exact proxy mapping is detected, `--remote` preserves its HTTPS hostname, non-default port,
and mount path. Ambiguous tables or mappings to another backend fall back to the direct IP URL rather
than composing a plausible but wrong HTTPS link. Never use `tailscale funnel`, which would expose
the server publicly.

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
  `id_ed25519*`, `credentials*`, and `*.secret*`. `artifact_server_deny`, or its
  `WT_ARTIFACT_SERVER_DENY` fallback, adds patterns. Only the test/internal env-only knob
  `WT_ARTIFACT_SERVER_ALLOW_UNSAFE_DENYLIST=1` replaces the defaults. The other test-only knobs,
  `WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS` and `WT_ARTIFACT_SERVER_TAILSCALE_BINARY` (a pinned
  `tailscale` executable for hermetic probes; PATH stays the default), are also env-only. Policy is per registration and
  is checked against canonical path segments plus the root basename, so benign symlink aliases do
  not bypass it.
- Markdown raw HTML is escaped. `.txt`, `.log`, and `.json` are escaped. HTML is unchanged and
  sandboxed without scripts by default. An HTML file whose first non-whitespace content is the
  visible `<!-- wt-artifact-server: rich -->` marker opts into inline scripts, still without
  same-origin authority, network connections, or external images. The marker travels inside the
  file; an extension can be lost on rename, while a sibling policy file can drift away. Rich mode
  narrows blast radius but does not make the artifact trusted: opening it still runs unreviewed code
  the owner chose to open. Raw SVG and unknown content retain the no-script sandbox; generated
  Markdown and indexes use a strict no-script CSP.
- Health reports service version and OS uid. UID and Linux command-line checks prevent cross-user
  attachment and accidental stale-PID signalling; they are not cryptographic attestation against a
  malicious process running as the same user. There is no rate limit or file-size limit.
