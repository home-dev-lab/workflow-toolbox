---
name: second-opinion
description: >
  Get one independent, read-only second opinion from another model family for
  difficult, ambiguous, high-risk, or stuck coding and reasoning problems.
  Uses GPT-6 Astra when GPT-lane consent and its runtime are available;
  otherwise it refuses and the second opinion is to be asked of the user,
  never a same-family Claude consult. The main session keeps the task, edits,
  verification, and final decision.
when_to_use: >
  Use for a difficult, ambiguous, high-risk, or stuck question that needs one
  independent challenge from outside the session's own model family. Force
  Opus only when the user explicitly asks for a Claude Opus consult.
---

# Second opinion

Use this skill for a non-obvious failure, contradictory evidence, a consequential
architecture choice, repeated failed attempts, or an explicit request for an
independent challenge. Do not use it for routine edits or as an implementation
lane. Make exactly one advisor call for the question; consult again only when new
evidence changes the question.

A second opinion is worth asking for because it does not share the session's
blind spots: a model of the same family tends to continue the reasoning it is
shown and to leave the same routes unexplored. Ask the advisor to counter that
bias and to name the routes nobody tried. When no consented external lane is
available, the second opinion is the user: put the question to them instead.

The advisor is read-only. The main session remains responsible for all file
changes, commands, tests, and decisions. Never route this consultation through a
Claude sub-agent: invoke the CLI directly.

## Prepare the request

Write a focused request file containing:

- the precise questions to answer, phrased without a preferred conclusion;
- all relevant facts and raw observations, including exact numbers, units,
  timestamps, errors, paths, configuration values, and command output;
- the source of each fact and what that source or instrument can and cannot show;
- contradictory observations, actions already taken and their observed results;
- unknowns that the advisor must not silently fill with assumptions;
- a request to rank explanations, identify counterexamples and hidden
  assumptions, state uncertainty, and name what it could not verify.

Keep your current hypothesis out of the evidence. If it must be tested, label it
separately as one candidate among alternatives and ask the advisor to attack it.

Choose effort once: `low` for a scoped challenge or review, `medium` for an
unclear cause or real trade-off, and `high` for failed attempts, subtle
cross-system behavior, or an expensive-to-reverse decision. Expect `--effort`
to drive the Astra route only: the Opus route always runs at `xhigh`, whatever
effort you pass.

Choose `auto` by default: it runs GPT-6 Astra when GPT-lane consent and the
Codex runtime are available. Without consent, `auto` refuses with `EXIT=1`,
never falls back to a Claude model, and names the remedy for the level that
refused (`wt-lane-consent --on` for the account, `wt-lane-consent --project
<repo> --on` for a project that narrows consent); ask the user for the second opinion instead. Choose `astra` to require
Astra explicitly. Choose `opus` only when the user explicitly asks for a Claude
Opus consult; the CLI starts a fresh SDK context for it, and it does not
decorrelate the session's own model-family biases.

## Launch detached

Run from the repository the question concerns. Use absolute paths for the
request and output files.

For admission configuration, refusal handling, and snapshot isolation, read
[references/admission.md](references/admission.md) before launching.

### Resolve the current installation on every launch

Use a fresh output path in an existing writable directory. Save this standalone
bootstrap as `<out-file>.launch.mjs` before launching. It uses only Node built-ins,
so even skill text loaded before a plugin update resolves the **current** registry
when executed. Do not replace it with a remembered versioned cache path.

The lookup follows the adopted-script convention (`../adopt/SKILL.md`, "Script
resolution"): explicit `WT_PLUGIN_ROOT`, then applicable `workflow-toolbox@*`
entries in `<profile>/plugins/installed_plugins.json`, then runtime
`CLAUDE_PLUGIN_ROOT`. Project/local entries in this project or its ancestors rank
above user entries; equal ranks retain registry order. A selected broken install
refuses rather than falling through. Use `WT_PLUGIN_ROOT` only for an intentional,
current absolute checkout/install override; clear a stale override after updating.
Here `<profile>` is `CLAUDE_CONFIG_DIR` when set, otherwise the `.claude` directory
under `HOME`, `USERPROFILE`, or the OS home directory, in that order.

```javascript
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const env = process.env
// Native realpath expands Windows 8.3 short names; the JS one keeps them. Fall back where native fails.
function canonical(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null
  try { return fs.realpathSync.native(value) } catch { /* try the JS resolver */ }
  try { return fs.realpathSync(value) } catch { return null }
}
function withinProject(owner, here) {
  if (!here || !owner) return false
  const relative = path.relative(owner, here)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function applicable(entry) {
  if (entry?.scope === 'user') return true
  if (entry?.scope !== 'project' && entry?.scope !== 'local') return false
  const here = canonical(env.CLAUDE_PROJECT_DIR || process.cwd())
  const owner = canonical(entry.projectPath)
  return withinProject(owner, here)
}
function readRegistry() {
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude')
  const registry = path.join(config, 'plugins', 'installed_plugins.json')
  try { return JSON.parse(fs.readFileSync(registry, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
function currentRoot() {
  if (env.WT_PLUGIN_ROOT !== undefined) return env.WT_PLUGIN_ROOT
  const parsed = readRegistry()
  const entries = Object.entries(parsed?.plugins ?? parsed ?? {}).flatMap(([key, values]) =>
    key.startsWith('workflow-toolbox@') ? (Array.isArray(values) ? values : [values]).filter(applicable) : [])
  const rank = (entry) => Number(entry.scope === 'project' || entry.scope === 'local')
  entries.sort((a, b) => rank(b) - rank(a))
  return entries.length ? entries[0].installPath : env.CLAUDE_PLUGIN_ROOT
}
const candidate = currentRoot()
const root = canonical(candidate)
if (!root) throw new Error(`Cannot resolve workflow-toolbox plugin root: ${String(candidate)}; check WT_PLUGIN_ROOT and the installed-plugin registry`)
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
if (manifest.name !== 'workflow-toolbox') throw new Error(`Not a workflow-toolbox installation: ${root}`)
await import(pathToFileURL(path.join(root, 'bin', 'wt-second-opinion.mjs')).href)
```

### Linux

Both stdout and stderr, including a missing `node`, bootstrap, CLI, or imported
module, go to `<out-file>.launch.log`. Keep this log beside `--out`; never redirect
the launch to `/dev/null`.

```bash
request=<request-file>
out=<out-file>
repo=<repository>
setsid nohup node "${out}.launch.mjs" \
  --request "$request" --out "$out" --effort <low|medium|high> \
  --route <auto|astra|opus> --repo "$repo" >"${out}.launch.log" 2>&1 < /dev/null &
```

### macOS

Stock macOS has `nohup` but no `setsid`; use the same bootstrap and log:

```sh
request=<request-file>
out=<out-file>
repo=<repository>
nohup node "${out}.launch.mjs" \
  --request "$request" --out "$out" --effort <low|medium|high> \
  --route <auto|astra|opus> --repo "$repo" >"${out}.launch.log" 2>&1 < /dev/null &
```

Put every file the reviewer must read under `--repo`, and name it by absolute
path. Expect `EXIT=2` before the reviewer starts when, on Linux, a named file is
not readable inside the reviewer's sandbox; read the refusal for the path.
Then apply one remedy: copy the file under `--repo` and name the copy; or
re-run with `WT_LANE_SANDBOX_READ=<path>` for that exact file. Multiple files use
a colon-separated list of absolute exact file paths, never a whole directory
(`WT_LANE_SANDBOX_READ='/absolute/a.md:/absolute/b.md'`). Set it in the launch
environment before starting the process. Or, for a path
only mentioned and not needed, re-run with
`WT_SECOND_OPINION_UNREAD='["<path>"]'`. Read a `NOTE:` line as a named
directory the reviewer cannot see: the review ran without it. Name the files
you need reviewed; never rely on a named directory to carry them.

### Windows (PowerShell)

Save the same bootstrap as `<out-file>.launch.mjs`. The short-lived Node launcher
below gives the detached child ignored stdin and file-backed stdout/stderr, then
unrefs it before returning to PowerShell. It does not use PowerShell-managed
stream redirection or inherit the caller's pipes. Stderr is
`<out-file>.launch.log`, stdout is `<out-file>.launch.stdout.log`; read both on
failure. `<out-file>.launch.pid` records the child PID. Launch exceptions
(including a missing `node`) are also written to the stderr launch log.

```powershell
$request = <request-file>
$out = <out-file>
$repo = <repository>
$launchArgs = @("${out}.launch.mjs", '--request', $request, '--out', $out,
  '--effort', '<low|medium|high>', '--route', '<auto|astra|opus>', '--repo', $repo)
$detach = @'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs'
const [bootstrap, ...args] = process.argv.slice(1)
const out = args[args.indexOf('--out') + 1]
const log = out + '.launch.log'
const fds = []
try {
  fds.push(openSync(out + '.launch.stdout.log', 'a'))
  fds.push(openSync(log, 'a'))
  const child = spawn(process.execPath, [bootstrap, ...args], {
    detached: true, windowsHide: true, stdio: ['ignore', ...fds],
  })
  child.unref()
  child.once('error', (error) => { appendFileSync(log, String(error) + '\n'); process.exitCode = 1 })
  if (child.pid) writeFileSync(out + '.launch.pid', String(child.pid))
} catch (error) {
  appendFileSync(log, String(error) + '\n')
  process.exitCode = 1
} finally {
  for (const fd of fds) closeSync(fd)
}
'@
try {
  $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  if ((Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue) -notin @('Standard', 'Windows')) {
    $launchArgs = @($launchArgs | ForEach-Object { '"' + ($_ -replace '(\\+)$', '$1$1') + '"' })
  }
  & $node --input-type=module -e $detach -- @launchArgs
  if ($LASTEXITCODE -ne 0) { throw "Detached node launcher exited with code $LASTEXITCODE" }
} catch {
  [IO.File]::AppendAllText("${out}.launch.log", ($_ | Out-String))
  throw
}
```

### Check startup within a minute

About one minute after launch, verify that `--out` exists and its **first line**
is `ROUTE=...` (`ROUTE=gpt-astra` or `ROUTE=claude-opus`). If it is absent or the
first line is not `ROUTE=...`, immediately read `<out-file>.launch.log` (and the
stdout launch log on Windows) and any existing output. Report the launch as
failed; **never wait on missing output**. A terminal `REFUSED: ...` / `EXIT=...`
in `--out` is already a completed refusal, even without a route line. Admission
can publish `PENDING:` before route selection: report that startup is still
pending in the startup-failure report and investigate its policy/snapshot instead
of silently waiting for a route.

Once startup is confirmed, poll the output file until its final line is
`EXIT=<code>`. Read the **whole file**, never only the final line: the first line
identifies the selected route
(`ROUTE=gpt-astra` or `ROUTE=claude-opus`), the body is the complete answer or
refusal, and the last line is completion status. A refusal names the unavailable
lane, runtime or quota condition and its remedy; never bypass it by silently
choosing another model. A refusal of `auto` for lack of lane consent means the
second opinion is the user's to give.

Treat the answer as evidence, not a verdict. Check material claims against the
repository and primary sources, resolve disagreement with a new observation,
and retain the final decision in the main session.
