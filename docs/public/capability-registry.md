# The machine capability registry

A workflow declares what a role *needs* in the abstract — `code-intelligence`,
`docs-lookup`, `web-search`, `context-offload` — and never names a concrete tool. The
**machine capability registry** is the operator-owned file that maps each abstract need to
a concrete provider **on this machine**, at launch time. It is the boundary that keeps a
published workflow runnable anywhere: a machine that registers a provider gets the real
tool; a machine that registers none degrades to a named fallback, and the same artifact
runs unchanged either way.

This is the **operator/machine** side of the capability mechanism. The **authoring** side —
how a workflow declares needs and emits a `<name>.capabilities.json` sidecar — is
documented in
[`plugin/skills/workflow-composer/references/capability-needs.md`](../../plugin/skills/workflow-composer/references/capability-needs.md).
An author never touches the registry; an operator never touches the sidecar.

## Location

The registry is a single machine-level JSON file:

```
$XDG_CONFIG_HOME/workflow-toolbox/capability-registry.json
```

which is `~/.config/workflow-toolbox/capability-registry.json` when `XDG_CONFIG_HOME` is
unset. Override the path with the environment variable **`WT_CAPABILITY_REGISTRY`**
(an absolute path to an alternate registry file).

- **Absent file → an EMPTY registry, not an error.** A machine with no registry resolves
  every need to its named degradation (below). The toolkit assumes no tools of yours; a
  harness-only machine is a first-class, supported case.
- **Present but invalid → the launch is refused, loudly.** A registry that is not valid
  JSON, or violates the schema below, makes `wt-observe launch` list every problem and exit
  non-zero rather than launch against a half-read registry.

## Format

The file is a `version: 1` object with a `providers` map. Each key is an abstract need; its
value is an **ordered** list of providers — the first one whose availability probe passes
wins. The two providers below are **examples of what an operator may register**, not
defaults the toolkit ships or assumes:

```jsonc
{
  "version": 1,
  "providers": {
    "code-intelligence": [                 // ORDERED — first available wins
      {
        "name": "serena",
        "mcpServers": {
          "serena": { "command": "uvx", "args": ["serena", "start-mcp-server", "--project", "$CWD"] }
        },
        "tools": ["mcp__serena__*"],       // allow-glob per server is fine; never a denylist
        "protocolHint": "Use the symbolic tools; do not fall back to text search.",
        "probe": { "command": "uvx --version", "timeoutMs": 5000 }
      }
    ],
    "docs-lookup": [
      { "name": "context7", "mcpServers": { "context7": { "command": "ctx" } }, "tools": ["mcp__context7__*"] }
    ]
  }
}
```

### Per-provider fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The provider id shown in the resolution report. |
| `mcpServers` | no | Verbatim SDK server-config fragments (same anchor keys — `command`/`url`/`type` — as the shipped `args.capabilities` contract). These are the servers that mount at the session level when this provider resolves. |
| `tools` | no | The exact tool names this provider grants, or an allow-glob **per server** (`mcp__<server>__*`). Never a denylist — a `disallowedTools`-style glob is silently broken upstream, so the registry grants explicitly and never denies. |
| `protocolHint` | no | A one-line instruction appended to the role's prompt telling it to actually use the provider (provisioning a tool is not adopting it). |
| `probe` | no | An optional availability check — `{ command, timeoutMs? }` — run at launch. A provider with no `probe` is assumed available (declaring it is your assertion that it works). See the security note below. |

Only `name`, `mcpServers`, `tools`, `protocolHint`, and `probe` are recognized on a
provider; any other key is a typo and fails validation.

### The `$CWD` substitution

`$CWD` is the one registry variable. Anywhere it appears inside an `mcpServers` value it is
replaced, **at launch, on the requester's machine**, with the directory the launch was
started from. It must be substituted launcher-side because a delegated run's server has its
own working directory, never the requester's. If a resolved provider's config needs `$CWD`
but the requester's directory cannot be determined, the launch is refused rather than
shipping a broken, half-substituted argument.

## Resolution and degradation

At launch the launcher reads the registry, runs each declared provider's probe, then
resolves each of the workflow's needs to the first available provider — or, when none is
registered or available, to a **named degradation** baked into the toolkit (not the
registry):

| need | degradation when no provider resolves | fallback tools |
|---|---|---|
| `code-intelligence` | `degraded:grep-glob` | `Grep`, `Glob`, `Read` |
| `docs-lookup` | `degraded:web` when web tools exist, else `degraded:none` | `WebSearch`, `WebFetch` |
| `web-search` | `degraded:none` (the need *is* the network fallback) | — |
| `context-offload` | `degraded:inline` (the role summarizes in-window) | — |
| any other need | `degraded:none` | — |

A need marked `optional: true` in the workflow runs degraded silently (still recorded and
visible). A **required** need that degrades to `degraded:none` — no provider and no
fallback that yields any tool — refuses the launch: a role whose defining capability cannot
be provided at all is a run that would lie about what it did.

## Recommended companions (recommend, never require)

If you want the full experience of a capability-using workflow, register a provider for the
needs it declares. Two examples an operator commonly registers: a symbolic
**code-intelligence** MCP for `code-intelligence`, and a **docs** MCP for `docs-lookup`.
These are companions you **may** install and register — never dependencies, never toolkit
defaults, never hard-coded in a shipped sidecar. Whether any given tool is present is
environment- and time-dependent, so a workflow with an abstract need always runs on a bare
machine by degrading to the named fallback. The companion note is only a "you'll get more
if you also have X" hint.

## Security — the registry is the trust root

- **A shipped artifact can only make the machine connect what the machine has explicitly
  registered here.** Workflow sidecars and observer definitions carry abstract needs only;
  the concrete provider comes solely from this operator-owned file. That is the whole point
  of the boundary.
- **`probe.command` is an execution surface.** A probe is a command read from this file and
  run at launch (in argv form, without a shell — the string is tokenized, never
  shell-interpreted), timeout-bounded, and gated by the fact that you own the file. It runs
  even for a provider a given launch will not end up using.
- **Never point `WT_CAPABILITY_REGISTRY` at a registry you do not own.** Because probes
  execute, the override is itself an injection vector if a third party can place the file it
  points at. Treat the registry as trusted, first-party configuration.

## How the launcher uses it

When you run `wt-observe launch <workflow>`, the launcher looks for a
`<workflow>.capabilities.json` sidecar beside the resolved workflow artifact. If one is
present it reads this registry, probes providers, resolves the sidecar's needs, expands the
`$cap:<need>` placeholders in each role's tool allowlist into the resolved provider's tools
(or the named degradation), and composes the result into the delegated run. A resolution
report rides alongside the launch for auditing — **redacted to provider and server names
only**, never the raw `mcpServers` config (which can carry command arguments, paths, or
tokens). No sidecar means no capability resolution happens and the launch proceeds
unchanged.
