# Security policy

## Reporting a vulnerability

If you find a security issue in this plugin or the `@workflow-toolbox` packages,
please report it privately rather than opening a public issue:

- **Preferred:** GitHub private vulnerability reporting —
  <https://github.com/home-dev-lab/workflow-toolbox/security/advisories/new>
- **Email:** `fthomas@apache.org`

Please include the affected component (skill, hook, or npm package), a
description, and reproduction steps. I aim to acknowledge reports within a few
days and to address confirmed issues in a reasonable timeframe.

## Scope and security posture

This is a local developer tool. It has a deliberately small attack surface:

- **No network exposure.** The plugin opens no ports and runs no server. Its only
  outbound connection is the `upgrade-canary`'s best-effort fetch of the public
  Claude Code `CHANGELOG.md` (see [PRIVACY.md](PRIVACY.md)).
- **No data exfiltration.** It collects and transmits no user data, source, or
  conversation content. See [PRIVACY.md](PRIVACY.md).
- **Bundled hook binaries** (`bin/wt-stop-hook.mjs`, `bin/wt-debug.mjs`) are
  built from this repository's own source with esbuild, contain no third-party
  network calls, and are designed never to throw (the Stop hook exits cleanly and
  silently on any malformed input rather than blocking your session).
- **Filesystem reads** are scoped to a Workflow run's own journal and transcripts;
  filesystem **writes** (the audit report folder) happen only when you opt in via
  `$DWT_WORKFLOW_LOG_DIR` or `--out`, to a path you choose.
- **Determinism guardrails.** The toolkit's linter rejects non-deterministic and
  host-API constructs in emitted workflow artifacts; it helps authors stay within
  the Workflow sandbox contract, and does not attempt to bypass it.

## Supported versions

This is a `0.x` research-preview-era project tracking the Claude Code Workflow
tool. Security fixes are applied to the latest released version of the plugin and
the published `@workflow-toolbox/*` packages. There is no long-term-support
branch for older `0.x` releases.
