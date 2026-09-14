# Language Packs

## What A Pack Is

A language pack is a directory of language-specific context assets. Selection attaches context notes and topic rules; it runs nothing, as the TypeScript pack Limits section states at plugin/packs/typescript/README.md:18-19. A pack is not a runtime executor, package installer, or a promise that a language server is present.

## Directory Layout

Use the TypeScript pack as the real layout:

```text
plugin/packs/<language>/
  pack.json
  .lsp.json
  README.md
  rules/
  skills/
  agents/
  probe/
    <one source file with ONE planted type error>
    expected-diagnostic.txt      (a substring the delivered diagnostic must contain)
    workspace-modules.txt        (optional: package names the server needs resolvable from the workspace)
```

The probe reads `.lsp.json` (exactly ONE declaration per pack, `command` a bare executable name, never a path), copies `probe/` into a temporary project, and copies each package named in `workspace-modules.txt` from `toolkit/node_modules` into that project (`typescript-language-server` refuses to initialize in a workspace without a `typescript` module — measured 2026-09-12). A pack without `probe/` cannot run the documented probe command.

The current TypeScript example contains two rules, two skills, and two SDK-only agents; see plugin/packs/typescript/pack.json:6-17.

## Pack Manifest

The currently consumed manifest contract is tested rather than loaded at runtime: `language`, `triggers.extensions`, `rules`, `skills`, and `agents` are read in toolkit/packages/build/test/typescript-pack.test.ts:39-52; `triggers.files` (exact file names such as `pom.xml`) is the same kind of declaration for build files without a distinctive extension — both trigger lists are what the pack author asks the consumers to register (section Consumers), the manifest itself runs nothing. Each listed rule, skill, and agent must exist; the test also locks the TypeScript triggers at lines 47-52. Keep every optional asset listed in the manifest.

## Language Server

Each pack declaration supplies `command`, `args`, `extensionToLanguage`, and `diagnostics: true`; the TypeScript assertion is toolkit/packages/build/test/typescript-pack.test.ts:63-72. Generate the plugin-root declaration with:

```sh
pnpm packs:lsp
```

The generator reads plugin/packs/*/.lsp.json, writes pure JSON to plugin/.lsp.json, places TypeScript first and then other packs alphabetically, and refuses duplicate language keys, missing `command`, missing `args`, missing `extensionToLanguage`, and diagnostics other than true. The identity gate is toolkit/packages/build/test/lsp-root-identity.test.ts.

Give the server install line for every platform where it is known. A declaration fails open if its binary is absent: the TypeScript missing-binary measurement at plugin/packs/typescript/README.md:45-59 records no diagnostic and no missing-command warning.

## Probe

Run one archived probe per pack; add `--capability symbol-overview|symbol-lookup|declarations|references|implementations` to measure one navigation capability (omitting it retains the diagnostics two-arm probe).

```sh
node toolkit/scripts/lsp-pack-probe.mjs <pack>
```

Its artifacts live at .claude/reports/1861821660-lsp-probes/<pack>/<arm>/. The `available` arm passes only when `command -v` resolves and a diagnostic naming the planted error arrives. The `missing` arm passes only when no diagnostic arrives and the session ends normally.
Each arm also records `runtime.txt`; for Java, JDT LS requires the `java` first on the Claude Code process PATH to be JDK 21 or newer, not merely a JDK 21 installed elsewhere.

## Cross-Platform Verdict

State: the command must resolve on the Claude Code process PATH; measured on Linux (this machine, date, binary version); macOS and Windows unmeasured until their probe artifacts exist. Do not say that a command “works on” a platform without the corresponding archived probe.

## Consumers

The private `wt-lifecycle-hooks` plugin selects a pack from the `Language:` field in a card Discovery block; its current TypeScript branch is at the private consumer’s hooks/hooks.js:133-135. The private `wt-rules-on-demand` plugin serves topic rules on `Edit` and `Write` calls matching file extensions; its trigger is documented in TRIGGER-TABLE.md:14-16 and implemented in hooks/hooks.js:103-107.

Because neither consumer ships with this plugin, ask their owner for these two registrations when adding a language:

1. Add an explicit language match to `wt-lifecycle-hooks`.
2. Add a file-trigger regex and embed the pack’s rule files in `wt-rules-on-demand`.

## Optional Assets

Rules-on-demand topic rules, TDD/lint/build skills, and SDK-only agents are optional. List every supplied one in `pack.json`; do not imply that an omitted category is required or runs automatically.

The reuse decisions below come from a read-only survey of the ECC (everything-claude-code) reference tree; paths are ECC repository paths.

| Language | ECC path | What it does | Verdict |
| --- | --- | --- | --- |
| Python | plugin/agents/python-tdd-guide.md | pytest red-green and coverage guidance | adapt, adapted from ECC, plugin/agents/python-tdd-guide.md |
| Python | plugin/agents/python-build-resolver.md | minimal build, type, and lint fixes | adapt, adapted from ECC, plugin/agents/python-build-resolver.md |
| Python | plugin/scripts/hooks/pyright-checker.cjs | runs Pyright after edits in ECC’s hook framework | ECC-specific |
| Java (with Groovy) | plugin/agents/java-reviewer.md | Java review guidance for style, null safety, concurrency, and security | adapt, adapted from ECC, plugin/agents/java-reviewer.md |
| Java (with Groovy) | plugin/coding-standards/references/java-style-guide.md | Java style guidance | adapt, adapted from ECC, plugin/coding-standards/references/java-style-guide.md |
| Java (with Groovy) | plugin/scripts/hooks/java-security.js | invokes SpotBugs through ECC’s hook protocol | ECC-specific |
| Go (comparison) | no Go-specific ECC asset found | no reusable pack material | ECC-specific |

## Worked Example

The TypeScript pack provides the model instance: pack.json records selection assets and extensions; .lsp.json declares typescript-language-server; README.md records selection, limits, measurements, probe contract, platform wording, and optional assets; rules/ holds topic rules; skills/ holds TDD and gate guidance; agents/ holds SDK-only critic and reviewer definitions. The TypeScript README documents that `.tsx` has a trigger but no language-server mapping until it receives its own probe.

## Dialect Without A Server

For Groovy, state that the dialect is owned by the Java pack’s triggers and rules and has no .lsp.json entry, so it has no diagnostics declaration. Add one only when a named server has documented command, args, and extension mapping and archived probes pass on both arms; then regenerate the root declaration. No standalone Groovy language server was verified when this recipe was written: the registry lookup for `groovy-language-server` returned E404 and no `groovy-language-server` or `groovy` binary resolved on the measured machine.
