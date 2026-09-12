# Python Pack

This pack provides Python-specific rules, skills, SDK-only critic and reviewer definitions, and a
Pyright language-server declaration for the Workflow Toolbox repository.

## Selection

`wt-lifecycle-hooks` selects the pack when a card Discovery block contains a `Language:` value
matching `python`. `wt-rules-on-demand` serves the pack's topic rules on `Edit` and `Write` tool
calls targeting `.py` or `.pyi` paths. Other language values and an absent `Language:` field do not
select this pack.

## Limits

- The pack covers Python source and stub files only; it supplies no rules or workflow for other
  languages.
- SDK-only status is a convention plus the absence of these definitions from `plugin/agents/` and
  `plugin/agent-templates/`; the pack does not enforce SDK invocation at runtime.
- Pack selection attaches context notes and topic rules. It does not execute TDD, gates, or a
  reviewer automatically.

## What this pack ships

- `pack.json`, declaring `python` with `.py` and `.pyi` triggers.
- `.lsp.json`, declaring the Pyright language server for those extensions.
- `rules/tdd-pytest.md` and `rules/lint-typecheck-build.md`.
- `skills/tdd-red-green/SKILL.md` and `skills/lint-typecheck-build/SKILL.md`.
- `agents/critic.md` and `agents/reviewer.md`.
- `probe/probe.py` and `probe/expected-diagnostic.txt` for the language-server probe.

## Language server

The declaration is `pyright-langserver` with `args: ["--stdio"]` and
`extensionToLanguage: {".py": "python", ".pyi": "python"}`. It sets `diagnostics: true` and a
10,000 ms startup timeout in `.lsp.json`.

Install Pyright separately with either command:

```sh
npm i -g pyright
pip install pyright
```

On 2026-09-12, `npm view pyright version bin` reported version `1.1.414` and the `pyright` and
`pyright-langserver` executables; `pip index versions pyright` reported latest version `1.1.414`.
The locally resolved binaries were version `1.1.408`.

The TypeScript pack's 2026-09-11 missing-binary measurement states that its declaration emitted no
`<new-diagnostics>` block or missing-command warning and therefore fails open
(`plugin/packs/typescript/README.md:45-59`). This Python declaration has the same absent-command
risk; install the declared command before relying on diagnostics.

`basedpyright` is not a drop-in replacement: it uses the different executable
`basedpyright-langserver` and needs its own declaration.

## Probe

Run:

```sh
node toolkit/scripts/lsp-pack-probe.mjs python
```

The probe uses `probe/probe.py`, which contains one missing-argument type error, and expects the
substring in `probe/expected-diagnostic.txt`. It archives artifacts under
`.claude/reports/1861821660-lsp-probes/python/<arm>/` for the available-binary and missing-binary
arms.

Available-binary arm:

Available arm — PASS (2026-09-12, Linux, `command -v` → `/home/doublefx/miniconda3/bin/pyright-langserver`, pyright-langserver 1.1.408 (`pyright --version`; `pyright-langserver --version` prints only a connection error): the harness debug log records `textDocument/publishDiagnostics` received and 1 diagnostic attachment delivered, and the session quoted `Argument missing for parameter`; 39287 ms wall time for the headless session; artifacts `.claude/reports/1861821660-lsp-probes/python/available/` (stdout.log, stderr.log, debug.log, elapsed-ms.txt, command-v.txt, version.txt, workspace-modules.txt).

Missing-binary arm:

Missing arm — PASS (same date; `command -v` → not found on the shim PATH, `node` and `claude` still resolving): the harness attempted to start the server and failed (`Failed to start LSP server`: the command is absent), no `publishDiagnostics` was received and 0 attachments were delivered, the session ended normally (exit 0, 50913 ms) with no diagnostic and no missing-command message — the declaration fails open; artifacts `.claude/reports/1861821660-lsp-probes/python/missing/`.

## Cross-platform verdict

The command must resolve on the Claude Code process PATH; measured on Linux (this machine,
2026-09-12, pyright-langserver 1.1.408); macOS and Windows unmeasured until their probe artifacts
exist.

Linux measurement: both probe arms PASS on 2026-09-12 with pyright-langserver 1.1.408 (`pyright --version`; `pyright-langserver --version` prints only a connection error).

## Optional assets

This pack ships optional pytest TDD and Ruff/Pyright/build rules, matching skills, and SDK-only
critic and reviewer definitions. Consumers must register `.py` and `.pyi` triggers and the
`Language: python` match, as the TypeScript pack requires for its consumers
(`plugin/packs/typescript/README.md:69-74`).
