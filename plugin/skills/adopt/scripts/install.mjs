#!/usr/bin/env node
// install.mjs — the deterministic engine behind the adopt skill.
//
// Writes EDITABLE copies of workflow-toolbox's managed guardrails into the user's
// config, each stamped with a versioned banner AND a content fingerprint so a later
// run can tell (a) whether the copy is behind the plugin and (b) whether the USER has
// edited it. Four managed SETS share one engine:
//
//   • rules  — the cross-cutting guardrail rule files (content SOURCED from the
//              plugin's rules/ dir at run time — every *.md there except README.md,
//              the single source of the shipped rule text; this mirrors how the agents
//              set sources plugin/agents/). Target: <cwd>/.claude/rules. Banner is
//              line 1 (rule files carry no YAML frontmatter).
//   • agents — editable copies of the pilot delegation-suite agent definitions
//              (content SOURCED from the plugin's agents/ dir at run time — the agent
//              defs are their own single source; inlining them here would drift).
//              Target: <cwd>/.claude/agents. Banner is an HTML comment placed AFTER
//              the YAML frontmatter, because an agent def MUST start with `---`.
//              A project copy of pilot.md + pilot-watchdog.md (+ pilot-orchestrator.md +
//              pilot-orchestrator-watchdog.md) is what lets the watchdog `observer:`
//              pairing attach (plugin-installed agents do not honor it), and the
//              fingerprint is what makes a stale copy DETECTABLE after a plugin bump —
//              the hazard a raw manual copy has no defence against.
//   • autonomy — the session-autonomy mandate markdown, sourced from the plugin's
//                autonomy/ dir at run time. Target: <cwd>/.claude. Banner is line 1,
//                same plain-markdown prepend shape as the rules set.
//   • docs — RETIRED. It installed the rules' rationale/field-case overflow into
//            <cwd>/.claude/docs/wt. The shipped rules no longer point at any rationale
//            file (the repository history is the record), so nothing is installed; a
//            copy already installed at an adopter is left untouched and may be deleted.
//            `--set docs` fails with that explanation instead of a bare unknown-set error.
//
// It is safe BY CONSTRUCTION: `--install` never overwrites a locally-edited (or
// hand-authored) file — that needs an explicit `--force`. `--check` and `--diff`
// are always read-only. Successful writes journal their shipped snapshot so a later
// edited-copy arbitration can show adopted, local, and currently shipped text.
//
// Usage (the skill orchestrates these; a human can run them directly too):
//   node install.mjs [--set rules|agents|autonomy|scripts|all] --check   [--dir <dir>]   # report, write nothing
//   node install.mjs [--set rules|agents|autonomy|all] --install [--dir <dir>]   # write absent + refresh UNEDITED
//   node install.mjs [--set rules|agents|autonomy|all] --install --force [--dir <dir>]  # also overwrite edited copies
//   node install.mjs --set <set> --install --force --file <file> --dir <dir>  # overwrite one arbitrated copy
//   node install.mjs --set <set> --diff <file> --dir <dir>                   # read-only adopted/local/shipped view
//   node install.mjs [--set …] --install --replace-symlinks [--dir <dir>]      # replace a SYMLINKED target with a managed copy in place
//   node install.mjs [--set …] --check|--install --global                      # target the CONFIG dir instead of the project
//
// Default --set is `rules` (backward-compatible with the original rules-only tool).
// Each set targets its own default dir under <cwd>; `--dir` overrides the target exactly and
// therefore requires a SINGLE --set (with `--set all` each set keeps its own default). For
// rules, do not pass the parent of an adopted `wt/` directory: --install refuses that
// duplicate trap; use `--dir <root>/wt` or `--global`.
//
// `--global` targets the CONFIG dir — CLAUDE_CONFIG_DIR, or ~/.claude when that is unset —
// resolving the path here so no caller has to build it. That matters because a caller who
// hardcodes ~/.claude is RIGHT on a default machine and silently WRONG on one with a second
// config profile: it then reports on files it never looked at. Unlike --dir, `--global`
// composes with `--set all` (each set takes its own subdir); the two flags are mutually
// exclusive, since passing both means the caller believes two different things at once.
//
// SYMLINK SAFETY: if a target file is a symlink (e.g. a config dir whose rules are
// symlinked from another one), the engine NEVER writes through it — it reports the
// symlink and leaves it (and its target) untouched. `--replace-symlinks` opts in to
// atomically replacing the symlink with a regular managed file after rendering succeeds
// (the former target is preserved). This is never silent: a plain --install SKIPS a symlink.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// A consumer that closes our stdout early (e.g. `| head`) must not crash us.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0)
  throw err
})

const BANNER_TOOL = 'workflow-toolbox'
const SETTINGS_FILE = 'settings.json'
const SETTINGS_TRACE_DIR = 'workflow-toolbox'
const SETTINGS_TRACE_FILE = 'adopt-settings-trace.json'
const SETTINGS_BACKUP_PREFIX = 'settings.json.workflow-toolbox.bak.'
const ADOPT_JOURNAL_FILE = '.workflow-toolbox-adopt-journal.jsonl'

// ⚠ THIS LIST HAS A TWIN: plugin/bin/lib/env-prerequisites.mjs, which the SessionStart
// drift check reads. This installer REPAIRS a missing prerequisite; that hook DETECTS
// one that went missing later — two mechanisms, one fact.
//
// The twin is a real duplication and it is DELIBERATE. This script must stay a single
// relocatable file: the installer tests copy it alone into a synthetic plugin root, so
// a runtime import of a sibling module breaks it by construction (measured — the import
// threw ERR_MODULE_NOT_FOUND across six test files). Self-containment wins here.
//
// What keeps the two copies honest is therefore a TEST, not an import:
// packages/build/test/env-prerequisite-drift-hook.test.ts asserts the two declarations
// are identical, key for key and value for value. Add a requirement to one and that
// test goes red naming the other — which is the point, because the failure it prevents
// is the detector going quiet about a requirement only the installer knows.
const UNIVERSAL_ENV_REQUIREMENTS = [
  {
    key: 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
    value: '3',
    sets: ['rules', 'agents'],
  },
]

const AGENT_ONLY_ENV_REQUIREMENTS = [
  {
    key: 'CLAUDE_CODE_EXPERIMENTAL_OBSERVER_AGENTS',
    value: '1',
    sets: ['agents'],
  },
]

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function settingsTracePath(configRoot) {
  return path.join(configRoot, SETTINGS_TRACE_DIR, SETTINGS_TRACE_FILE)
}

function settingsRequirementsFor(chosen) {
  const names = new Set(chosen)
  const reqs = [...UNIVERSAL_ENV_REQUIREMENTS, ...AGENT_ONLY_ENV_REQUIREMENTS]
  return reqs.filter((req) => req.sets.some((set) => names.has(set)))
}

function readJsonObject(filePath, label) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'missing', filePath, label }
    }
    return { kind: 'unreadable', filePath, label }
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', filePath, label, reason: 'invalid JSON' }
  }
  if (!isPlainObject(value)) {
    return { kind: 'invalid', filePath, label, reason: 'root must be a JSON object' }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'env') && !isPlainObject(value.env)) {
    return { kind: 'invalid', filePath, label, reason: 'env must be a JSON object when present' }
  }
  return { kind: 'ok', filePath, label, value }
}

function readSettingsTrace(configRoot) {
  const tracePath = settingsTracePath(configRoot)
  const trace = readJsonObject(tracePath, 'settings trace')
  if (trace.kind === 'ok') return trace
  if (trace.kind === 'missing') return { kind: 'missing', filePath: tracePath, label: trace.label }
  return { kind: 'invalid', filePath: tracePath, label: trace.label, reason: 'trace unavailable' }
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function verifyPreservedKeys(before, after, scope, ignored = null) {
  for (const key of Object.keys(before)) {
    if (key === ignored) continue
    if (!Object.prototype.hasOwnProperty.call(after, key)) fail(`settings write verification failed: ${scope} key lost (${key})`)
    if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      fail(`settings write verification failed: ${scope} key changed unexpectedly (${key})`)
    }
  }
}

function verifySettingsAdditions(afterEnv, additions) {
  for (const { key, value } of additions) {
    if (!Object.prototype.hasOwnProperty.call(afterEnv, key)) fail(`settings write verification failed: intended env key missing (${key})`)
    if (afterEnv[key] !== value) fail(`settings write verification failed: intended env value differs (${key})`)
  }
}

function verifySettingsWrite(before, after, additions) {
  const beforeRoot = isPlainObject(before) ? before : {}
  if (!isPlainObject(after)) fail('settings write verification failed: root is not a JSON object after writing')
  const beforeEnv = isPlainObject(beforeRoot.env) ? beforeRoot.env : {}
  const afterEnv = isPlainObject(after.env) ? after.env : null
  if (!afterEnv) fail('settings write verification failed: env is missing or not an object after writing')
  const expectedRootCount = Object.keys(beforeRoot).length + (Object.prototype.hasOwnProperty.call(beforeRoot, 'env') ? 0 : 1)
  if (Object.keys(after).length !== expectedRootCount) fail('settings write verification failed: root key count changed unexpectedly')
  if (Object.keys(afterEnv).length !== Object.keys(beforeEnv).length + additions.length) {
    fail('settings write verification failed: env key count changed unexpectedly')
  }
  verifyPreservedKeys(beforeRoot, after, 'root', 'env')
  verifyPreservedKeys(beforeEnv, afterEnv, 'env')
  verifySettingsAdditions(afterEnv, additions)
}

function backupSettingsFile(filePath) {
  const backupPath = `${filePath}.workflow-toolbox.bak.${Date.now()}`
  fs.copyFileSync(filePath, backupPath)
  return backupPath
}

function classifyEnvRequirement(settingsRead, traceRead, requirement) {
  if (settingsRead.kind === 'unreadable') return { status: 'UNREADABLE (left untouched)', write: false }
  if (settingsRead.kind === 'invalid') return { status: `INVALID (${settingsRead.reason}; left untouched)`, write: false }
  const env = settingsRead.kind === 'ok' && isPlainObject(settingsRead.value.env) ? settingsRead.value.env : {}
  if (Object.prototype.hasOwnProperty.call(env, requirement.key)) {
    return {
      status:
        env[requirement.key] === requirement.value
          ? 'PRESENT (matches the managed default; left intact)'
          : 'PRESENT (differs from the managed default; left intact)',
      write: false,
    }
  }
  const traceKeys = traceRead.kind === 'ok' && isPlainObject(traceRead.value.keys) ? traceRead.value.keys : {}
  const previouslyManaged = Object.prototype.hasOwnProperty.call(traceKeys, requirement.key)
  return {
    status: previouslyManaged ? 'ABSENT (previously managed here; would be re-added on --install)' : 'ABSENT (would be added on --install)',
    write: true,
  }
}

function writeSettingsTrace(configRoot, settingsPath, version, writes, priorTrace) {
  const tracePath = settingsTracePath(configRoot)
  fs.mkdirSync(path.dirname(tracePath), { recursive: true })
  const base =
    priorTrace.kind === 'ok' && isPlainObject(priorTrace.value)
      ? cloneJson(priorTrace.value)
      : { schemaVersion: 1, tool: BANNER_TOOL, owner: 'adopt', keys: {} }
  if (!isPlainObject(base.keys)) base.keys = {}
  for (const requirement of writes) {
    base.keys[requirement.key] = {
      value: requirement.value,
      version,
      settingsPath,
    }
  }
  writeJsonFile(tracePath, base)
}

function planSettingsUpdate(requirements, settingsRead, traceRead) {
  const plannedWrites = []
  const statuses = new Map()
  for (const requirement of requirements) {
    const status = classifyEnvRequirement(settingsRead, traceRead, requirement)
    statuses.set(requirement.key, status.status)
    if (status.write) {
      plannedWrites.push(requirement)
    }
  }
  return { plannedWrites, statuses }
}

function commitSettingsUpdate(configRoot, settingsPath, settingsRead, traceRead, plannedWrites, version) {
  const beforeValue = settingsRead.kind === 'ok' ? settingsRead.value : {}
  const nextValue = cloneJson(beforeValue)
  const beforeEnv = isPlainObject(nextValue.env) ? nextValue.env : {}
  nextValue.env = { ...beforeEnv }
  for (const requirement of plannedWrites) nextValue.env[requirement.key] = requirement.value
  verifySettingsWrite(beforeValue, nextValue, plannedWrites)
  fs.mkdirSync(configRoot, { recursive: true })
  let backupPath = null
  if (settingsRead.kind === 'ok') backupPath = backupSettingsFile(settingsPath)
  writeJsonFile(settingsPath, nextValue)
  const reread = readJsonObject(settingsPath, 'settings')
  if (reread.kind !== 'ok') fail('settings write verification failed: could not re-read settings.json after writing')
  verifySettingsWrite(beforeValue, reread.value, plannedWrites)
  writeSettingsTrace(configRoot, settingsPath, version, plannedWrites, traceRead)
  return backupPath
}

function renderSettingsStatuses(requirements, plan, backupPath = null, wrote = false) {
  for (const requirement of requirements) {
    const verb = wrote && plan.plannedWrites.some((planned) => planned.key === requirement.key)
      ? backupPath
        ? `WROTE (backup ${path.basename(backupPath)} created)`
        : 'WROTE'
      : plan.statuses.get(requirement.key)
    process.stdout.write(`  ${requirement.key}: ${verb}\n`)
  }
}

function processSettings(configRoot, chosen, args, version) {
  const requirements = settingsRequirementsFor(chosen)
  if (requirements.length === 0) return { anyAbsent: false, anyProblem: false }
  const settingsPath = path.join(configRoot, SETTINGS_FILE)
  const tracePath = settingsTracePath(configRoot)
  const settingsRead = readJsonObject(settingsPath, 'settings')
  const traceRead = readSettingsTrace(configRoot)
  process.stdout.write(`[settings] target=${settingsPath} · trace=${tracePath}\n`)
  process.stdout.write(
    'adopt: account-level env prerequisites are checked only for the ACTIVE config profile here; if you use other CLAUDE_CONFIG_DIR profiles, rerun under each profile.\n',
  )
  const settingsPlan = planSettingsUpdate(requirements, settingsRead, traceRead)
  const anyAbsent = settingsPlan.plannedWrites.length > 0
  const anyProblem = settingsRead.kind === 'invalid' || settingsRead.kind === 'unreadable'
  if (args.mode !== 'install' || !anyAbsent) {
    renderSettingsStatuses(requirements, settingsPlan)
    return { anyAbsent, anyProblem }
  }
  if (!(settingsRead.kind === 'ok' || settingsRead.kind === 'missing')) return { anyAbsent, anyProblem: true }
  const backupPath = commitSettingsUpdate(configRoot, settingsPath, settingsRead, traceRead, settingsPlan.plannedWrites, version)
  renderSettingsStatuses(requirements, settingsPlan, backupPath, true)
  return { anyAbsent, anyProblem }
}

/** The rule files this skill installs as editable copies — DISCOVERED from the plugin's
 *  rules/ dir at run time (every *.md except README.md), so the shipped set is exactly
 *  what the bundle contains and grows without editing this engine. Content is NOT inlined:
 *  each file is its own single source, read verbatim under a banner — the mirror of how the
 *  agents set sources plugin/agents/. The SessionStart hook injects the delegation-ladder
 *  PRINCIPLE ephemerally; these are the persistent, user-editable copies. */
function discoverRuleItems(root) {
  const dir = path.join(root, 'rules')
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return [] // no bundle dir → nothing to manage (graceful)
  }
  return entries
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
    .map((file) => ({ file }))
}

/** The pilot delegation suite, installed as editable project copies. Content is NOT
 *  inlined — it is READ from the plugin's agents/ dir at run time (the agent defs are
 *  their own single source). Each `file` is both the source basename under
 *  <pluginRoot>/agents/ and the installed filename under <target>/.claude/agents. */
const MANAGED_AGENTS = [
  { file: 'pilot.md' },
  { file: 'pilot-watchdog.md' },
  { file: 'pilot-orchestrator.md' },
  { file: 'pilot-orchestrator-watchdog.md' },
]

const MANAGED_AUTONOMY = [
  { file: 'AUTHORIZATIONS.md' },
  { file: 'AUTONOMY.md' },
  { file: 'PERMISSIONS.md' },
  { file: 'PILOT-CONTRACT.md' },
  { file: 'PILOT-RUNNER.md' },
]

/** The plugin's REGISTERED agents (`plugin/agents/`) — DISCOVERED from the filesystem at
 *  run time, never hard-coded, so an agent added to that dir later shows up here with
 *  nobody editing a list (the same discipline `discoverRuleItems` already applies to the
 *  rules set). These are NOT part of the `agents` managed set above: Claude Code loads
 *  them directly as `workflow-toolbox:<name>` the moment the plugin is installed, and
 *  `adopt` does nothing for them — but from an adoptant's side, "not adopted
 *  because already registered" and "missing" both look like "absent from
 *  .claude/agents/". Naming them is what tells the two apart (card: an adoptant asked
 *  why two already-available agents "hadn't been added" — they had, under their
 *  namespaced form, and nothing said so). */
function discoverRegisteredAgents(root) {
  const dir = path.join(root, 'agents')
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return [] // no bundle dir → nothing to report (graceful, mirrors discoverRuleItems)
  }
  return entries
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.slice(0, -3))
    .sort()
}

function resolvedConfigRoot() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function formatMtime(mtime) {
  return Number.isFinite(mtime?.getTime?.()) ? mtime.toISOString() : '?'
}

/** Classify a DIVERGED shadow pair: is the difference confined to the frontmatter block (and
 *  if so, which top-level keys differ), or does the agent's instruction BODY differ too? A
 *  one-line model pin and a rewritten agent body both collapse into the same "DIVERGED" word
 *  otherwise — a reader can't tell a routing preference from an agent that no longer does what
 *  its name claims. Mirrors the drift-DIRECTION breakdown a few hundred lines below
 *  (`driftMissingFromShipped`/`driftMissingFromProject`): the classification is printed ON TOP
 *  of the existing "DIVERGED" signal, never in place of it — `Buffer.compare` above still owns
 *  the gate/exit-code-relevant equality check.
 *  Returns `{ kind: 'body' }`, `{ kind: 'frontmatter', keys: string[] }` (keys sorted, may be
 *  empty when the block differs only via a multi-line/list value `simpleFrontmatterKeys` can't
 *  name — reported as "frontmatter differs" rather than guessed at), or `null` when either side
 *  has no leading frontmatter block to compare (can't classify; caller falls back to the bare
 *  DIVERGED text unchanged). */
function classifyAgentDivergence(pluginText, userText) {
  const pluginBlock = frontmatterBlock(pluginText)
  const userBlock = frontmatterBlock(userText)
  if (pluginBlock == null || userBlock == null) return null
  const pluginBody = pluginText.slice(pluginBlock.length)
  const userBody = userText.slice(userBlock.length)
  if (pluginBody !== userBody) return { kind: 'body' }
  const pluginKeys = simpleFrontmatterKeys(pluginBlock)
  const userKeys = simpleFrontmatterKeys(userBlock)
  const allKeys = new Set([...pluginKeys.keys(), ...userKeys.keys()])
  const diffKeys = [...allKeys].filter((key) => pluginKeys.get(key) !== userKeys.get(key)).sort()
  return { kind: 'frontmatter', keys: diffKeys }
}

/** The classification, rendered as the text appended to a DIVERGED line — empty string when
 *  the pair can't be classified (falls back to the bare word, unchanged behaviour). */
function describeAgentDivergenceKind(pluginText, userText) {
  const kind = classifyAgentDivergence(pluginText, userText)
  if (!kind) return ''
  if (kind.kind === 'body') return '; body differs'
  return kind.keys.length > 0
    ? `; frontmatter-only: ${kind.keys.join(', ')}`
    : '; frontmatter-only'
}

function describeRegisteredAgentShadowing(root, userAgentsDir, name) {
  const pluginPath = path.join(root, 'agents', `${name}.md`)
  const userPath = path.join(userAgentsDir, `${name}.md`)
  try {
    const userStat = fs.statSync(userPath)
    if (!userStat.isFile()) return null
    const pluginStat = fs.statSync(pluginPath)
    const pluginContent = fs.readFileSync(pluginPath)
    const userContent = fs.readFileSync(userPath)
    if (Buffer.compare(pluginContent, userContent) === 0) {
      return `  - workflow-toolbox:${name} is shadowed by ${userPath} (matches the plugin copy)\n`
    }
    const kindText = describeAgentDivergenceKind(pluginContent.toString('utf8'), userContent.toString('utf8'))
    return (
      `  - workflow-toolbox:${name} is shadowed by ${userPath} ` +
      `(DIVERGED; plugin mtime=${formatMtime(pluginStat.mtime)}; user mtime=${formatMtime(userStat.mtime)}${kindText})\n`
    )
  } catch {
    return null
  }
}

/** Print the note distinguishing "already available, registered" from "adopted, managed
 *  here" — for the `agents` set only, in BOTH --check and --install (it is informational,
 *  not tied to a write). Silent when the registered set is empty (nothing to report),
 *  same convention as the rest of this script's graceful-degradation. */
function printRegisteredAgentsNote(root, userAgentsDir) {
  const registered = discoverRegisteredAgents(root)
  if (registered.length === 0) return
  process.stdout.write(
    `adopt: ${registered.length} other agent(s) ship with the plugin and are already ` +
      `available as workflow-toolbox:<name> — they are not adopted because they don't need to ` +
      `be: only the pilot suite requires a local copy, to keep its observer pairing.\n`,
  )
  for (const name of registered) process.stdout.write(`  - workflow-toolbox:${name}\n`)
  for (const name of registered) {
    const shadowing = describeRegisteredAgentShadowing(root, userAgentsDir, name)
    if (shadowing) process.stdout.write(shadowing)
  }
}

function formatSetList(names) {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

function formatSetFlags(names) {
  return names.map((name) => `--set ${name}`).join(names.length === 2 ? ' or ' : ', ')
}

function untouchedSetLine(chosenSet, allSetNames) {
  const untouched = allSetNames.filter((name) => name !== chosenSet)
  if (untouched.length === 0) return null
  const noun = untouched.length === 1 ? 'set exists too; it was' : 'sets exist too; they were'
  return `adopt: the ${formatSetList(untouched)} ${noun} untouched here, and ${formatSetFlags(untouched)} covers ${untouched.length === 1 ? 'it' : 'them'}.\n`
}

/** The managed sets. `kind` drives banner placement; `srcDir` is the plugin bundle
 *  dir each set reads its files from; `resolveItems(root)` lists the managed files (the
 *  rules set discovers them from the bundle; the agents set is a fixed suite). */
const SETS = {
  // defaultDir = default target under the project cwd. globalSubdir = default target under
  // the resolved CONFIG dir (--global) — kept as its OWN field rather than derived from
  // defaultDir's basename, because that derivation broke the moment defaultDir grew a
  // subfolder: `path.basename('.claude/rules/wt')` is `wt`, not `rules/wt`, and would have
  // resolved --global installs to `<configRoot>/wt` instead of `<configRoot>/rules/wt`.
  //
  // rules → `.claude/rules/wt/` is the DEFAULT since the rules/wt/ subfolder migration
  // (card 1835727457): the boundary between "my rules" and "the plugin's adopted rules"
  // now exists in the tree, not only in the `wt-` filename convention nothing enforced.
  // `--dir` still overrides this outright for a caller who wants a different location
  // (e.g. the flat pre-migration root, for read-only inspection during the transition).
  rules: { kind: 'rules', srcDir: 'rules', defaultDir: '.claude/rules/wt', globalSubdir: 'rules/wt', resolveItems: discoverRuleItems },
  // srcDir is `agent-templates/`, NOT `agents/`: a plugin's agents/ dir is what REGISTERS an
  // agent type, and a registered pilot is a broken pilot — Claude Code ignores `observer:` on
  // plugin-installed agents, so `workflow-toolbox:pilot` spawns and runs with no watchdog and
  // no warning. Keeping the pilot defs outside agents/ means that unwatched path does not
  // exist to be taken; they reach a session only as project copies under their bare names,
  // which is the only form where the pairing attaches. The other shipped agents (leaf, lean,
  // …) stay in agents/ — they declare no observer, so registration serves them correctly.
  agents: { kind: 'agents', srcDir: 'agent-templates', defaultDir: '.claude/agents', globalSubdir: 'agents', resolveItems: () => MANAGED_AGENTS },
  autonomy: { kind: 'autonomy', srcDir: 'autonomy', defaultDir: '.claude', globalSubdir: '', resolveItems: () => MANAGED_AUTONOMY },
  scripts: { kind: 'scripts', srcDir: 'bin', defaultDir: '.claude/scripts', globalSubdir: 'scripts', resolveItems: () => [{ file: 'wt-lane.mjs' }, { file: 'wt-lane-wait.mjs' }] },
}

const MANAGED_SET_NAMES = Object.keys(SETS)

// Retired set name: `--set docs` names it and exits non-zero, rather than failing as an unknown set.
const RETIRED_DOCS_SET = 'docs'

// The pre-migration location for the rules set — the direct parent of the new default
// (`.claude/rules/wt` → `.claude/rules`). Used ONLY as a heuristic for the legacy-fallback
// check in processSet() and by the migrate-dry-run report: it is tied structurally to the
// `rules/wt` default above, not to any hard-coded machine path.
function legacyRulesDir(dir) {
  return path.basename(dir) === 'wt' ? path.dirname(dir) : null
}

// Match only against the banner line, never the body — a body mention of the phrase
// must not be read as a banner.
const VERSION_RE = new RegExp(`installed from ${BANNER_TOOL} v(\\d+)\\.(\\d+)\\.(\\d+)`)
const FP_RE = /content sha256:([0-9a-f]{12})/

// A DRIFT line reports one divergent line of TEXT, and that line lives on exactly one
// side — the project copy or the shipped template, never both.
// A label that just says "(missing)" makes the reader supply the missing half themselves,
// and the guess goes wrong as often as it goes right (measured: a full session inverted it,
// declared a publish blocked that wasn't, and spawned a pilot on a premise that was the exact
// opposite of the truth). So every per-line DRIFT entry below names the side it is missing
// FROM, on the line the reader actually reads — never in a legend, never only in the summary.
//   - a line present in the PROJECT copy but absent from the shipped template is "missing
//     from the shipped template" (the project has it; the template doesn't — yet).
//   - a line present in the SHIPPED template but absent from the project copy is "missing
//     from the project copy" (the template has it; the project hasn't caught up).
const MISSING_FROM_SHIPPED = 'missing from shipped template'
const MISSING_FROM_PROJECT = 'missing from project copy'
// The leading YAML frontmatter block of an agent def, incl. its trailing newline.
const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/

class AdoptFatalError extends Error {}

function fail(msg) {
  process.stdout.write(`adopt: ${msg}\n`)
  process.exit(1)
}

/** The plugin root (the dir holding .claude-plugin/plugin.json), walking up from this
 *  script. Both the version and the agents/ source dir are resolved from it. */
function pluginRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  fail('could not locate the plugin manifest (.claude-plugin/plugin.json) above this script')
}

function currentVersion(root) {
  const manifest = path.join(root, '.claude-plugin', 'plugin.json')
  const v = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
  if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) return v
  fail(`plugin.json version is missing or malformed at ${manifest}`)
}

function fingerprint(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
}

/** Content comparison ignores trailing whitespace at EOF (including a missing/extra final
 * newline). That formatting carries no rule semantics and must not manufacture drift. */
function contentFingerprint(body) {
  return fingerprint(body.replace(/[ \t\r\n]+$/u, ''))
}

function banner(version, fp, file = '') {
  if (file.endsWith('.mjs')) return `// installed from ${BANNER_TOOL} v${version} · content sha256:${fp} by the adopt skill -- editable copy.`
  return (
    `<!-- installed from ${BANNER_TOOL} v${version} · content sha256:${fp} by the adopt ` +
    `skill — editable copy. Re-run the ${BANNER_TOOL}:adopt skill to check for updates; ` +
    `--install refreshes only an UNEDITED copy, --force overwrites your local edits. -->`
  )
}

/** The fingerprinted CONTENT of a managed item — exactly what the user may edit, so an
 *  unedited installed file reproduces its stamped fingerprint. BOTH sets read the file
 *  verbatim from their plugin bundle dir (rules/ or agents/); each file is its own
 *  single source. */
function itemContent(set, item, root) {
  const src = path.join(root, set.srcDir, item.file)
  if (!fs.existsSync(src)) fail(`${set.kind} source not found: ${src} — the ${set.kind} bundle (plugin/${set.srcDir}/) is out of sync`)
  const content = fs.readFileSync(src, 'utf8')
  if (set.kind !== 'scripts') return content
  const replaceExactlyOnce = (body, fragment, replacement) => {
    const count = body.split(fragment).length - 1
    if (count !== 1) fail(`${item.file === 'wt-lane-wait.mjs' ? 'waiter' : 'launcher'} transformation expected exactly one occurrence in ${src}: ${fragment.slice(0, 60)}`)
    return body.replace(fragment, () => replacement)
  }
  if (item.file === 'wt-lane-wait.mjs') {
    return replaceExactlyOnce(content, "import { classifyLane, laneHostPlatform, readCurrentSupervisions } from './lib/lane-supervisor-core.mjs'", `import os from 'node:os'
import { pathToFileURL } from 'node:url'
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude')
let runtimeRoot = process.env.CLAUDE_PLUGIN_ROOT || process.env.WT_PLUGIN_ROOT || null
if (!runtimeRoot) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    const plugins = parsed?.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : parsed
    const key = Object.keys(plugins).find((name) => name.startsWith('workflow-toolbox@'))
    const entry = key ? plugins[key] : null
    runtimeRoot = (Array.isArray(entry) ? entry[0] : entry)?.installPath || null
  } catch {}
}
if (!runtimeRoot) throw new Error('could not locate workflow-toolbox plugin root; update the plugin and re-adopt wt-lane-wait.mjs')
const { classifyLane, laneHostPlatform, readCurrentSupervisions } = await import(pathToFileURL(path.join(runtimeRoot, 'bin', 'lib', 'lane-supervisor-core.mjs')).href)`)
  }
  if (item.file !== 'wt-lane.mjs') return content
  // The adopted launcher has no stable plugin-cache neighbour. Resolve the installed plugin at
  // launch time instead of copying consent logic, so a changed resolver cannot fail open here.
  let adopted = replaceExactlyOnce(content, "import { resolveConsent } from './lib/lane-consent-check-core.mjs'\nimport { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'\nimport { effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'\nimport { resolveLaneSkillAllowlist } from './lib/lane-skill-allowlist.mjs'\nimport { laneModelRefusal, resolveRoleVariant, variantRefusal } from './lib/lane-model-allowlist.mjs'\nimport { appendSupervisorJournal, argvSummary, claimCurrentSupervision, classifyLane, inspectProcess, laneHardBoundAt, latestWorktreeWrite, processEvidenceStatus, readCurrentSupervision, readLogTail, sameIdentity, shellQuote, supervisionPaths, terminateLane, writeJsonAtomic } from './lib/lane-supervisor-core.mjs'\nimport { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'", `
function pluginRoot(env = process.env) {
  for (const candidate of [env.CLAUDE_PLUGIN_ROOT, env.WT_PLUGIN_ROOT]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
  const registry = path.join(configDir, 'plugins', 'installed_plugins.json')
  try {
    const parsed = JSON.parse(readFileSync(registry, 'utf8'))
    const plugins = parsed?.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : parsed
    const key = Object.keys(plugins).find((name) => name.startsWith('workflow-toolbox@'))
    const entry = key ? plugins[key] : null
    const installed = Array.isArray(entry) ? entry[0] : entry
    if (typeof installed?.installPath === 'string' && installed.installPath) return installed.installPath
  } catch { /* handled by the fail-closed caller */ }
  return null
}

async function loadAdoptedConsentModules() {
  const root = pluginRoot()
  if (!root) throw new Error('could not locate workflow-toolbox plugin root via CLAUDE_PLUGIN_ROOT, WT_PLUGIN_ROOT, or plugins/installed_plugins.json')
  const resolver = path.join(root, 'bin', 'lib', 'lane-consent-check-core.mjs')
  const gate = path.join(root, 'bin', 'lib', 'lane-consent-gate-core.mjs')
    const fence = path.join(root, 'bin', 'lib', 'opencode-skill-fence.mjs')
    const allowlist = path.join(root, 'bin', 'lib', 'lane-skill-allowlist.mjs')
    const modelAllowlist = path.join(root, 'bin', 'lib', 'lane-model-allowlist.mjs')
    const pluginOptions = path.join(root, 'bin', 'lib', 'plugin-options.mjs')
    const supervisor = path.join(root, 'bin', 'lib', 'lane-supervisor-core.mjs')
    const pluginDataDir = path.join(root, 'bin', 'lib', 'plugin-data-dir.mjs')
    const host = path.join(root, 'bin', 'lib', 'host', 'adapter.mjs')
    const launcher = path.join(root, 'bin', 'wt-lane.mjs')
  try {
    const [{ resolveConsent }, { evaluateConsentGate }, fenceModule, allowlistModule, modelAllowlistModule, , supervisorModule, pluginDataModule, hostModule, launcherModule] = await Promise.all([import(pathToFileURL(resolver).href), import(pathToFileURL(gate).href), import(pathToFileURL(fence).href), import(pathToFileURL(allowlist).href), import(pathToFileURL(modelAllowlist).href), import(pathToFileURL(pluginOptions).href), import(pathToFileURL(supervisor).href), import(pathToFileURL(pluginDataDir).href), import(pathToFileURL(host).href), import(pathToFileURL(launcher).href)])
    return { resolveConsent, evaluateConsentGate, effectiveSkillDiscoveryRefusal: fenceModule.effectiveSkillDiscoveryRefusal, materialiseAllowedSkills: fenceModule.materialiseAllowedSkills, opencodeChildEnv: fenceModule.opencodeChildEnv, opencodeSkillFenceRefusal: fenceModule.opencodeSkillFenceRefusal, spawnOpencode: fenceModule.spawnOpencode, verifyEffectiveOpencodeSkillDiscovery: fenceModule.verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence: fenceModule.verifyOpencodeSkillFence, resolveLaneSkillAllowlist: allowlistModule.resolveLaneSkillAllowlist, laneModelRefusal: modelAllowlistModule.laneModelRefusal, resolveRoleVariant: modelAllowlistModule.resolveRoleVariant, variantRefusal: modelAllowlistModule.variantRefusal, appendSupervisorJournal: supervisorModule.appendSupervisorJournal, argvSummary: supervisorModule.argvSummary, claimCurrentSupervision: supervisorModule.claimCurrentSupervision, classifyLane: supervisorModule.classifyLane, inspectProcess: supervisorModule.inspectProcess, inspectStartedProcess: launcherModule.inspectStartedProcess, laneHardBoundAt: supervisorModule.laneHardBoundAt, latestWorktreeWrite: supervisorModule.latestWorktreeWrite, processEvidenceStatus: supervisorModule.processEvidenceStatus, readCurrentSupervision: supervisorModule.readCurrentSupervision, readLogTail: supervisorModule.readLogTail, sameIdentity: supervisorModule.sameIdentity, shellQuote: supervisorModule.shellQuote, supervisionPaths: supervisorModule.supervisionPaths, terminateLane: supervisorModule.terminateLane, writeJsonAtomic: supervisorModule.writeJsonAtomic, resolvePluginDataDir: pluginDataModule.resolvePluginDataDir, hostAdapter: hostModule.hostAdapter }
  } catch {
    throw new Error(\`the installed workflow-toolbox plugin is older or incompatible; update it and re-adopt wt-lane.mjs (runtime modules: \${resolver}, \${gate}, \${fence}, \${allowlist}, \${modelAllowlist}, \${pluginOptions}, \${supervisor}, \${pluginDataDir}, \${host}, \${launcher})\`)
  }
}`)
  adopted = replaceExactlyOnce(adopted, "import { hostAdapter } from './lib/host/adapter.mjs'\n", '')
  adopted = replaceExactlyOnce(adopted, "import { isInvokedDirectly } from './lib/host/entry-guard.mjs'\n", `function isInvokedDirectly(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    const moduleUrl = new URL(importMetaUrl)
    if (moduleUrl.search || moduleUrl.hash) return false
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch { return false }
}
`)
  adopted = replaceExactlyOnce(adopted, "async function loadConsentModules() {\n  return { resolveConsent, evaluateConsentGate, effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence, resolveLaneSkillAllowlist, laneModelRefusal, resolveRoleVariant, variantRefusal, appendSupervisorJournal, argvSummary, claimCurrentSupervision, classifyLane, inspectProcess, inspectStartedProcess, laneHardBoundAt, latestWorktreeWrite, processEvidenceStatus, readCurrentSupervision, readLogTail, sameIdentity, shellQuote, supervisionPaths, terminateLane, writeJsonAtomic, resolvePluginDataDir, hostAdapter }\n}", "async function loadConsentModules() {\n  return loadAdoptedConsentModules()\n}")
  adopted = replaceExactlyOnce(adopted, "async function loadIntegrationModule() {\n  return import('./lib/lane-integrate.mjs')\n}", `async function loadIntegrationModule() {
  const root = pluginRoot()
  if (!root) throw new Error('could not locate workflow-toolbox plugin root via CLAUDE_PLUGIN_ROOT, WT_PLUGIN_ROOT, or plugins/installed_plugins.json')
  const integration = path.join(root, 'bin', 'lib', 'lane-integrate.mjs')
  return import(pathToFileURL(integration).href)
}`)
  adopted = replaceExactlyOnce(adopted, "import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'", "import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'\nimport os from 'node:os'\nimport { pathToFileURL } from 'node:url'")
  const relativeRuntimeImport = adopted.match(/import .* from '\.\/lib\/(?:lane-consent-|opencode-skill-fence)[^']*'/)?.[0]
  if (relativeRuntimeImport) {
    fail(`launcher transformation left a relative runtime import in ${src}: ${relativeRuntimeImport.slice(0, 60)}`)
  }
  return adopted
}

/** Resolve the plugin root the adopted wt-lane launcher will use. This intentionally mirrors
 * the generated pluginRoot() above: explicit launcher roots win, then the active config's
 * installed-plugin registry. The launcher cannot import this standalone installer helper, so
 * fixture tests lock the two paths to the same observable result. */
function adoptedLauncherPluginRoot(env = process.env) {
  for (const candidate of [env.CLAUDE_PLUGIN_ROOT, env.WT_PLUGIN_ROOT]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude')
  const registry = path.join(configDir, 'plugins', 'installed_plugins.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(registry, 'utf8'))
    const plugins = parsed?.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : parsed
    const key = Object.keys(plugins).find((name) => name.startsWith('workflow-toolbox@'))
    const entry = key ? plugins[key] : null
    const installed = Array.isArray(entry) ? entry[0] : entry
    if (typeof installed?.installPath === 'string' && installed.installPath) return installed.installPath
  } catch {
    // Reported below with the same remedies as a missing runtime module.
  }
  return null
}

/** Extract runtime modules from the generated dynamic loaders. Keeping no parallel module
 * list means a future path joined from root and passed to import() is automatically part of
 * this preflight. */
function adoptedLauncherRuntimeModules(adopted, runtimeRoot) {
  const moduleByVariable = new Map()
  for (const match of adopted.matchAll(/const\s+(\w+)\s*=\s*path\.join\(root,\s*((?:'[^']+'(?:,\s*)?)+)\)/g)) {
    const segments = [...match[2].matchAll(/'([^']+)'/g)].map((segment) => segment[1])
    if (segments.length > 0) moduleByVariable.set(match[1], path.join(runtimeRoot, ...segments))
  }
  const modules = [...adopted.matchAll(/import\(pathToFileURL\((\w+)\)\.href\)/g)]
    .map((match) => moduleByVariable.get(match[1]))
    .filter(Boolean)
  if (modules.length === 0) fail('launcher transformation produced no runtime modules')
  return modules
}

function preflightAdoptedLauncherRuntime(chosen, sourceRoot) {
  if (!chosen.includes('scripts')) return
  const runtimeRoot = adoptedLauncherPluginRoot()
  if (!runtimeRoot) {
    fail('wt-lane.mjs plugin root could not be resolved — install or update workflow-toolbox, then retry')
  }
  const adopted = itemContent(SETS.scripts, { file: 'wt-lane.mjs' }, sourceRoot)
  for (const modulePath of adoptedLauncherRuntimeModules(adopted, runtimeRoot)) {
    if (!realFile(modulePath)) {
      fail(`wt-lane.mjs runtime module is missing from the resolved plugin root: ${modulePath} — update or reinstall workflow-toolbox, then retry.`)
    }
  }
}

/** The shipped content's fingerprint, or null when the source cannot be read.
 *
 *  Deliberately NOT itemContent(): that one calls fail() → exit(1), which is right for an
 *  INSTALL (you cannot install from a source that is not there) and wrong for a --check,
 *  where it would abort the whole report mid-list. Worse, the SessionStart hook parses this
 *  script's stdout without inspecting the exit code, so a mid-run abort would drop every
 *  remaining file from the hook's view — leaving it SILENT about items it never reached.
 *  A guard that goes quiet because it broke is worse than one that never existed, so this
 *  degrades to null and the caller falls back to the version comparison. */
function shippedFingerprint(set, item, root, installedBody = null, preserveAgentFrontmatter = false) {
  try {
    const source = fs.readFileSync(path.join(root, set.srcDir, item.file), 'utf8')
    const rendered = set.kind === 'scripts' ? itemContent(set, item, root) : source
    // A clean agent can legitimately retain an installer-preserved local frontmatter field.
    // Compare that copy to the current shipped definition with the same field retained, not to
    // the raw template which could never match it.
    const expected =
      preserveAgentFrontmatter && set.kind === 'agents' && installedBody !== null
        ? preserveLocalFrontmatter(rendered, installedBody).content
        : rendered
    return contentFingerprint(expected)
  } catch (error) {
    if (error instanceof AdoptFatalError) throw error
    return null
  }
}

/** Insert the banner right AFTER the YAML frontmatter (an agent def MUST start with
 *  `---`, so the banner cannot be line 1). Verified empirically: the harness parses
 *  and registers an agent def with an HTML comment as the first body line, and honors
 *  the prompt below it. `stripAgentBanner` is the exact inverse. */
function insertAgentBanner(source, b) {
  const m = FRONTMATTER_RE.exec(source)
  if (!m) fail('agent source is missing a leading YAML frontmatter block (must start with ---)')
  const head = m[1]
  return `${head}${b}\n\n${source.slice(head.length)}`
}

/** Recover the pre-banner content of an installed agent copy (inverse of insert): drop
 *  the banner comment line that sits just after the frontmatter, plus the single blank
 *  line the insert added — leaving the source's own body (incl. any blank line it had). */
function stripAgentBanner(text) {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return text
  const head = m[1]
  let after = text.slice(head.length)
  const nl = after.indexOf('\n')
  const firstLine = nl === -1 ? after : after.slice(0, nl)
  if (VERSION_RE.test(firstLine)) after = after.slice(nl + 1).replace(/^\n/, '')
  return head + after
}

/** Recover the pre-banner content of an installed RULE (banner is line 1). Conditional on
 *  the first line actually being a recognized banner — mirrors `stripAgentBanner`'s own
 *  guard. Cross-family review finding: this used to strip line 1
 *  UNCONDITIONALLY, silently treating a raw (unbannered) shipped source file's own title
 *  line as disposable framing. That never mattered while the shipped-name-direct-adoption
 *  comparison in `auditOverlap` was unreachable (it used to short-circuit to ABSENT before
 *  ever comparing content); fixing that reachability exposed this as a real false-positive
 *  DRIFT on every genuinely clean, directly-adopted rule. */
function stripRuleBanner(text) {
  const head = onDemandFrontmatter(text)
  const candidate = head ? text.slice(head.length) : text
  const nl = candidate.indexOf('\n')
  const firstLine = nl === -1 ? candidate : candidate.slice(0, nl)
  if (!VERSION_RE.test(firstLine)) return text
  if (nl === -1) return ''
  return candidate.slice(nl + 1).replace(/^\n+/, '')
}

function stripScriptBanner(text) {
  const first = text.indexOf('\n')
  if (first === -1 || !text.startsWith('#!')) return stripRuleBanner(text)
  const secondEnd = text.indexOf('\n', first + 1)
  const second = secondEnd === -1 ? text.slice(first + 1) : text.slice(first + 1, secondEnd)
  if (!VERSION_RE.test(second)) return text
  return text.slice(0, first + 1) + text.slice(secondEnd + 1).replace(/^\n+/, '')
}

/** The full installed file: content + a banner stamped with the fingerprint of the content
 *  ACTUALLY WRITTEN. When `oldContent` is given (the file about to be overwritten, agents set
 *  only), any local single-line frontmatter field it carries — one the shipped def does not
 *  itself define — is spliced into the content BEFORE the banner is computed, so the stamped
 *  fingerprint covers exactly what lands on disk. Stamping the SHIPPED-ONLY content's hash and
 *  splicing a preserved field in afterward (the prior shape) writes a file that can never
 *  reproduce its own banner — `classify()` reads it back as EDITED forever, even though the
 *  installer just wrote it from its own template a moment earlier. Returns
 *  `{ text, preserved }`; `preserved` is `[]` when there is nothing local to carry (the common
 *  case, and the only case for the rules/autonomy sets, which pass no `oldContent`). */
function renderItem(set, item, version, root, oldContent = null) {
  const rawContent = itemContent(set, item, root)
  const { content, preserved } =
    set.kind === 'agents' ? preserveLocalFrontmatter(rawContent, oldContent) : { content: rawContent, preserved: [] }
  const b = banner(version, fingerprint(content), item.file)
  const onDemandHead = set.kind === 'rules' ? onDemandFrontmatter(oldContent ?? '') : null
  let text
  if (set.kind === 'agents') text = insertAgentBanner(content, b)
  else if (onDemandHead) text = `${onDemandHead}${b}\n\n${content}`
  else if (set.kind === 'scripts' && content.startsWith('#!')) {
    text = `${content.slice(0, content.indexOf('\n') + 1)}${b}\n\n${content.slice(content.indexOf('\n') + 1)}`
  } else text = `${b}\n\n${content}`
  return { text, preserved }
}

// --- Frontmatter preservation across a re-adoption -------------------------------------------
//
// `--install --force` used to REPLACE an agent file wholesale, silently dropping any field a
// user had locally added to the frontmatter (the standing example: a `model:` pin — the visible
// mechanism by which a delegation tier is chosen instead of inherited). The loss carried no
// signal: the write succeeded, exit code 0, nothing printed. This block makes a re-adoption
// carry a local, single-line-valued frontmatter key FORWARD into the freshly-rendered shipped
// text, and announce what it kept — silently, when there is nothing to carry (the common case).
//
// DESIGN DECISION (the card asked this be made explicitly, not left as a default): the SHIPPED
// agent-templates/*.md do NOT carry a `model:` pin themselves, and this fix does not add one.
// A model/tier choice is a deployment policy (which account, which cost posture, which task
// mix) — the same reason the delegation-ladder rules keep concrete tier mappings out of the
// shipped, environment-free rule text and into a project's own local layer. Baking a pin into
// the shipped def would force every adopter onto one project's tier choice; the correct fix is
// that a LOCAL pin, once made, survives re-adoption — which is what this block does.
//
// Deliberately conservative: only a frontmatter key whose ENTIRE value sits on one line (no
// list/continuation lines under it) is ever treated as "simple" and carried over. A multi-line
// local addition (e.g. a locally edited `disallowedTools:` list) is NOT reproduced — merging
// that safely would need a real YAML-aware editor, and a half-merged list is worse than a clearly
// SKIPPED file (the pre-existing EDITED/--force contract already gives the user that route).

/** The raw frontmatter block INCLUDING both `---` delimiters, or null if `text` doesn't start
 *  with one (mirrors FRONTMATTER_RE; a wrapper so callers don't repeat the null check). */
function frontmatterBlock(text) {
  const m = FRONTMATTER_RE.exec(text)
  return m ? m[1] : null
}

/** Single-line, top-level frontmatter keys found in `block` (the raw block incl. delimiters),
 *  as a Map of key -> its exact source line. A key is "simple" only when (a) its value is not a
 *  YAML block-scalar indicator (`|`, `>`, optionally with a chomping/indent modifier — these
 *  introduce a multi-line value that may resume after one or more BLANK lines, which a
 *  next-line-only continuation check would miss and mis-preserve a truncated field), and (b) the
 *  line right after it is NOT an indented/continuation line (and isn't the closing `---`) —
 *  anything else (a YAML list, a folded string, a trailing comment block) is left alone rather
 *  than guessed at, per the conservative-merge note above. Cross-family review finding:
 *  a block scalar followed by a blank line before its own continuation
 *  (`notes: |\n\n  continued\n`) used to read as "simple" and lose its continuation on merge. */
function simpleFrontmatterKeys(block) {
  const lines = block.split(/\r?\n/)
  const keys = new Map()
  const BLOCK_SCALAR_RE = /^[|>][-+]?\d*\s*$/
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i]
    if (line === '---') break
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line)
    if (!m) continue
    if (BLOCK_SCALAR_RE.test(m[2].trim())) continue
    const next = lines[i + 1]
    const isContinuation = next !== undefined && next !== '---' && /^[ \t]/.test(next) && next.trim() !== ''
    if (isContinuation) continue
    keys.set(m[1], line)
  }
  return keys
}

/** Splice `extraLines` into `frontmatterSource` (a full agent-def string starting with its own
 *  frontmatter), immediately before the CLOSING `---` delimiter. Returns the spliced string, or
 *  the input unchanged if its frontmatter can't be located (should not happen — callers only
 *  call this with content that already round-tripped through FRONTMATTER_RE). */
function spliceIntoFrontmatter(frontmatterSource, extraLines) {
  const block = frontmatterBlock(frontmatterSource)
  if (!block) return frontmatterSource
  const blockLines = block.split(/\r?\n/)
  let closeIdx = -1
  for (let i = blockLines.length - 1; i >= 1; i--) {
    if (blockLines[i] === '---') {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return frontmatterSource
  const newBlockLines = [...blockLines.slice(0, closeIdx), ...extraLines, ...blockLines.slice(closeIdx)]
  return newBlockLines.join('\n') + frontmatterSource.slice(block.length)
}

/** Carry any LOCAL, single-line frontmatter key from `oldContent` (the file about to be
 *  overwritten) into `rawShippedContent` (the PLAIN shipped text — no banner yet), for every
 *  key the shipped def does not itself define. Returns `{ content, preserved }` — `content` is
 *  `rawShippedContent` unchanged and `preserved` is `[]` when there is nothing local to carry
 *  (silent, common case — the second sense of the card's closure criterion). `oldContent` may
 *  be a previously-banner-stamped copy; its banner line is stripped first so the banner's own
 *  HTML-comment line is never mistaken for a frontmatter key (it lives after the frontmatter
 *  anyway, so this only matters for defensiveness).
 *
 *  ⚠ Deliberately operates on the UNBANNERED content, before `renderItem` stamps the banner —
 *  a caller that spliced a preserved field in AFTER the banner was computed would ship a
 *  banner whose fingerprint covers content the file does not actually hold, which is exactly
 *  the defect this function used to cause: the installer would write a file from its own
 *  template and `--check` would immediately read it back as EDITED. */
function preserveLocalFrontmatter(rawShippedContent, oldContent) {
  if (oldContent == null) return { content: rawShippedContent, preserved: [] }
  const shippedBlock = frontmatterBlock(rawShippedContent)
  const oldBlock = frontmatterBlock(stripAgentBanner(oldContent))
  if (!shippedBlock || !oldBlock) return { content: rawShippedContent, preserved: [] }
  const shippedKeys = simpleFrontmatterKeys(shippedBlock)
  const oldKeys = simpleFrontmatterKeys(oldBlock)
  const extraLines = []
  const preserved = []
  for (const [key, line] of oldKeys) {
    if (!shippedKeys.has(key)) {
      extraLines.push(line)
      preserved.push(key)
    }
  }
  if (extraLines.length === 0) return { content: rawShippedContent, preserved: [] }
  return { content: spliceIntoFrontmatter(rawShippedContent, extraLines), preserved }
}

/** The line carrying the banner: line 1 for a rule, the line after the frontmatter for
 *  an agent (an agent's line 1 is always `---`). */
function bannerLine(set, text) {
  if (set.kind === 'agents') {
    const m = FRONTMATTER_RE.exec(text)
    if (!m) return ''
    const after = text.slice(m[1].length)
    const nl = after.indexOf('\n')
    return nl === -1 ? after : after.slice(0, nl)
  }
  if (set.kind === 'scripts') {
    const first = text.indexOf('\n')
    const after = first === -1 ? '' : text.slice(first + 1)
    const nl = after.indexOf('\n')
    return nl === -1 ? after : after.slice(0, nl)
  }
  const head = set.kind === 'rules' ? onDemandFrontmatter(text) : null
  const candidate = head ? text.slice(head.length) : text
  const nl = candidate.indexOf('\n')
  return nl === -1 ? candidate : candidate.slice(0, nl)
}

function onDemandFrontmatter(text) {
  const block = frontmatterBlock(text)
  return block && /^on-demand\s*:/m.test(block) ? block : null
}

function explicitNestedTarget(set, dir, args) {
  if (!args.dir || set.kind !== 'rules') return null
  return path.join(dir, 'wt')
}

function hasAdoptionBanner(set, file) {
  try {
    return VERSION_RE.test(bannerLine(set, fs.readFileSync(file, 'utf8')))
  } catch {
    return false
  }
}

function discoveredConfigRoots() {
  const home = os.homedir()
  const roots = new Set([resolvedConfigRoot(), path.join(home, '.claude')])
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && /^\.claude(?:-|$)/.test(entry.name)) {
        roots.add(path.join(home, entry.name))
      }
    }
  } catch {
    // The active and default config roots above remain sufficient when HOME is unreadable.
  }
  return [...roots].map((dir) => path.resolve(dir))
}

function adoptionDirectoryInfo(dir) {
  try {
    const real = fs.realpathSync(dir)
    return {
      realPath: real,
      kind: real === path.resolve(dir) ? 'real directory' : `symlinked directory -> ${real}`,
    }
  } catch {
    return { realPath: path.resolve(dir), kind: 'unresolved directory' }
  }
}

function adoptedFiles(set, dir, root) {
  return new Set(
    set.resolveItems(root)
      .filter((item) => hasAdoptionBanner(set, path.join(dir, item.file)))
      .map((item) => item.file),
  )
}

function existingAdoptionCandidates(name, set, root) {
  const candidates = new Map()
  const add = (level, dir, placement = 'static') => {
    const resolved = path.resolve(dir)
    const files = adoptedFiles(set, resolved, root)
    if (files.size === 0) return
    const { realPath, kind } = adoptionDirectoryInfo(resolved)
    const existing = candidates.get(resolved)
    if (existing) existing.levels.add(level)
    else candidates.set(resolved, { dir: resolved, realPath, placement, levels: new Set([level]), kind, files })
  }

  add('project', path.join(process.cwd(), set.defaultDir))
  if (name === 'rules') add('project on-demand', path.join(process.cwd(), '.claude', 'rules-on-demand'), 'on-demand')
  for (const configRoot of discoveredConfigRoots()) {
    add('config', path.join(configRoot, set.globalSubdir))
    if (name === 'rules') add('config on-demand', path.join(configRoot, 'rules-on-demand'), 'on-demand')
  }
  return [...candidates.values()]
}

function mergeOnDemandAliases(candidates) {
  const byRealPath = new Map()
  const merged = []
  for (const candidate of candidates) {
    if (candidate.placement !== 'on-demand') {
      merged.push(candidate)
      continue
    }
    const existing = byRealPath.get(candidate.realPath)
    if (!existing) {
      byRealPath.set(candidate.realPath, candidate)
      merged.push(candidate)
      continue
    }
    for (const level of candidate.levels) existing.levels.add(level)
    for (const file of candidate.files) existing.files.add(file)
  }
  return merged
}

function overlappingCandidates(candidates) {
  const locationsByFile = new Map()
  for (const candidate of candidates) {
    for (const file of candidate.files) {
      const locations = locationsByFile.get(file) ?? []
      locations.push(candidate)
      locationsByFile.set(file, locations)
    }
  }
  return new Set([...locationsByFile].filter(([, locations]) => locations.length > 1).flatMap(([, locations]) => locations))
}

function resolveImplicitInstallDirs(chosen, args, root) {
  if (!['check', 'install'].includes(args.mode) || args.dir) return new Map()
  const bySet = new Map()
  const ambiguous = []
  for (const name of chosen) {
    let candidates = existingAdoptionCandidates(name, SETS[name], root)
    if (args.global) {
      const activeRoot = path.resolve(resolvedConfigRoot())
      candidates = candidates.filter(({ dir }) => {
        const relative = path.relative(activeRoot, dir)
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      })
    } else if (args.mode === 'check') {
      const projectRoot = path.resolve(process.cwd(), '.claude')
      candidates = candidates.filter(({ dir }) => {
        const relative = path.relative(projectRoot, dir)
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      })
    }
    candidates = mergeOnDemandAliases(candidates).filter((candidate) =>
      candidate.placement !== 'on-demand' ||
      !candidates.some((other) => other.placement === 'static' && other.realPath === candidate.realPath),
    )
    const overlapping = overlappingCandidates(candidates)
    if (overlapping.size > 0) ambiguous.push({ name, candidates: [...overlapping] })
    else if (candidates.length > 0) {
      const itemDirs = new Map()
      for (const candidate of candidates) {
        for (const file of candidate.files) itemDirs.set(file, candidate.dir)
      }
      bySet.set(name, { defaultDir: candidates.length === 1 ? candidates[0].dir : null, itemDirs })
    }
  }
  if (ambiguous.length > 0) {
    const lines = ambiguous.flatMap(({ name, candidates }) =>
      candidates.map(({ dir, levels, kind }) => `  [${name}] ${[...levels].join('/')} ${kind}: ${dir}`),
    )
    fail(
      `DUPLICATE adopted targets found; the same managed files would load from more than one directory:\n${lines.join('\n')}\n` +
        `refusing to guess; pass --dir '<directory>' with one --set, or --global for the active config profile.`,
    )
  }
  return bySet
}

function refuseExplicitRootInstall(set, dir, args, root) {
  const nestedDir = explicitNestedTarget(set, dir, args)
  if (args.mode !== 'install' || !nestedDir) return
  const bannerFiles = set
    .resolveItems(root)
    .filter((item) => hasAdoptionBanner(set, path.join(nestedDir, item.file)))
    .map((item) => item.file)
  if (bannerFiles.length === 0) return
  const named = bannerFiles.slice(0, 3).join(', ')
  fail(
    `--dir ${dir} is a rules root with adopted files under ${nestedDir}/ ` +
      `(first banner files: ${named}${bannerFiles.length > 3 ? ', …' : ''}). ` +
      `Use --dir ${nestedDir} or --global; refusing to create flat duplicates beside wt/.`,
  )
}

function stripBannerFor(set, text) {
  return set.kind === 'agents' ? stripAgentBanner(text) : set.kind === 'scripts' ? stripScriptBanner(text) : stripRuleBanner(text)
}

// Fingerprint scope (known limit, both kinds): an unedited copy is recognized by
// re-hashing its content with the WHOLE banner line dropped. So an edit glued ONTO
// the banner line itself (text after `-->`, no newline) is stripped along with the
// banner and stays invisible — such a copy reads "clean" and a later refresh would
// overwrite it. Editing the body (the normal case) is always detected; this narrow
// blind spot predates the agents set (it is identical for the rules set).
/** Classify an installed file against the plugin: absent | symlink (a link we must NOT
 *  write through) | hand-authored (no toolbox banner) | edited-unknown (managed,
 *  pre-fingerprint banner — cannot verify) | edited (managed, locally modified) |
 *  clean (managed, matches its fingerprint). The symlink check is FIRST and uses lstat
 *  (never follows the link) — existsSync/readFileSync would silently resolve THROUGH a
 *  symlink and a later write would clobber its real target. */
function classify(target, set) {
  let lst
  try {
    lst = fs.lstatSync(target)
  } catch {
    return { state: 'absent' } // nothing at this path
  }
  if (lst.isSymbolicLink()) {
    let linkTarget = ''
    try {
      linkTarget = fs.readlinkSync(target)
    } catch {
      /* an unreadable link is still a link we must not write through */
    }
    return { state: 'symlink', linkTarget }
  }
  const content = fs.readFileSync(target, 'utf8')
  const line = bannerLine(set, content)
  const vm = VERSION_RE.exec(line)
  if (!vm) return { state: 'hand-authored' }
  const installedVer = `${vm[1]}.${vm[2]}.${vm[3]}`
  const fpm = FP_RE.exec(line)
  const body = stripBannerFor(set, content)
  const contentFp = contentFingerprint(body)
  if (!fpm) return { state: 'edited-unknown', installedVer, contentFp, frontmatter: onDemandFrontmatter(content) }
  const clean = fingerprint(body) === fpm[1] || contentFingerprint(body) === fpm[1]
  // Re-derive this from the body; never trust the banner hash for shipped-content identity.
  return { state: clean ? 'clean' : 'edited', installedVer, contentFp, body, frontmatter: onDemandFrontmatter(content) }
}

function journalPath(dir) {
  return path.join(dir, ADOPT_JOURNAL_FILE)
}

function appendAdoptionJournal(dir, entry) {
  fs.appendFileSync(journalPath(dir), `${JSON.stringify(entry)}\n`)
}

function adoptedSnapshot(dir, file, version) {
  let lines
  try {
    lines = fs.readFileSync(journalPath(dir), 'utf8').trim().split('\n').reverse()
  } catch {
    return null
  }
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.file === file && entry.afterVersion === version && typeof entry.adoptedText === 'string') {
        return entry.adoptedText
      }
    } catch {
      // A damaged older line must not hide a later usable snapshot.
    }
  }
  return null
}

function printThreeWayDiff(set, dir, file, version, root) {
  if (!file || path.basename(file) !== file) fail('--diff requires one managed file basename')
  const item = set.resolveItems(root).find((candidate) => candidate.file === file)
  if (!item) fail(`--diff file is not managed by --set ${set.kind}: ${file}`)
  const target = path.join(dir, file)
  const classified = classify(target, set)
  if (!['clean', 'edited', 'edited-unknown'].includes(classified.state)) {
    fail(`--diff requires a managed copy at ${target} (found ${classified.state})`)
  }
  const local = fs.readFileSync(target, 'utf8')
  const adopted = adoptedSnapshot(dir, file, classified.installedVer)
  const adoptedText = adopted ?? '[unavailable: this copy predates the adoption journal]'
  process.stdout.write(`adopt: read-only three-way view for ${target}\n`)
  process.stdout.write(`=== ADOPTED v${classified.installedVer} ===\n${adoptedText}\n`)
  process.stdout.write(`=== LOCAL ${target} ===\n${stripBannerFor(set, local)}\n`)
  process.stdout.write(`=== SHIPPED v${version} ===\n${itemContent(set, item, root)}\n`)
}

function cmp(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

// === CHANGELOG-SPAN CORE START — kept BYTE-IDENTICAL between changelog-span.mjs and
// install.mjs; locked by adopt-changelog-span-drift.test.ts. Duplicated rather than
// imported because install.mjs must stay a single relocatable script — its own tests
// copy it alone into a synthetic plugin root, so a runtime import of a sibling module
// breaks it there (measured elsewhere in this codebase: the same reason
// UNIVERSAL_ENV_REQUIREMENTS is duplicated against plugin/bin/lib/env-prerequisites.mjs,
// kept honest by env-prerequisite-drift-hook.test.ts's own text-equality check rather
// than an import). Every helper name is prefixed `changelogSpan*` so pasting this block
// into install.mjs cannot collide with that file's OWN `cmp()` (different signature:
// string-vs-string, not tuple-vs-tuple). ===
const CHANGELOG_SPAN_HEADING_RE = /^##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/

/** Parse a semver-ish string 'x.y.z' into a comparable [x,y,z] tuple. Throws on a
 *  malformed string — callers only ever pass adopt's own installed/current versions,
 *  both of which are validated elsewhere (VERSION_RE / plugin.json's own manifest
 *  check) before they ever reach here. */
function changelogSpanParseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  if (!m) throw new Error(`changelogSpan: not a valid x.y.z version: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function changelogSpanCmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** Every `## [x.y.z]` heading in `changelog`, in FILE order (newest-first, the normal
 *  Keep-a-Changelog convention — never assumed by callers, only used here to find each
 *  heading's line range). Each item carries the exact line index its heading starts at,
 *  so the caller can slice the body down to (but not including) the NEXT heading of any
 *  version — an `## [Unreleased]` section has no version token and is correctly never
 *  matched, matching the plugin-changelog-gate's own `changelogRecordsVersion`. */
function changelogSpanParseHeadings(changelog) {
  const lines = changelog.split(/\r?\n/)
  const headings = []
  for (let i = 0; i < lines.length; i++) {
    const m = CHANGELOG_SPAN_HEADING_RE.exec(lines[i])
    if (!m) continue
    headings.push({
      version: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`,
      versionTuple: [Number(m[1]), Number(m[2]), Number(m[3])],
      lineIndex: i,
      headingLine: lines[i],
    })
  }
  return { lines, headings }
}

/**
 * Slice `changelog` (plugin/CHANGELOG.md's text, Keep a Changelog format) for every
 * heading strictly newer than `fromVersion` up to and including `toVersion`.
 *
 * @param {string} changelog        raw CHANGELOG.md text
 * @param {string} fromVersion      the stale copy's installed version, e.g. '0.112.0'
 * @param {string} toVersion        the current plugin version, e.g. '0.144.0'
 * @param {{maxEntries?: number}} [opts]  cap on entries returned (default 10); the
 *   MOST RECENT entries are kept and the rest are counted in `omittedCount` — never
 *   silently dropped, per the card's invariant 4.
 *
 * @returns {{recorded:true, entries:Array<{version:string, heading:string, body:string}>,
 *            totalCount:number, omittedCount:number, missingVersionCount:number|null}
 *          |{recorded:false, oldestRecordedVersion:string|null}}
 */
function changelogSpan(changelog, fromVersion, toVersion, opts = {}) {
  const maxEntries = opts.maxEntries ?? 10
  const from = changelogSpanParseVersion(fromVersion)
  const to = changelogSpanParseVersion(toVersion)
  const { lines, headings } = changelogSpanParseHeadings(changelog)

  if (headings.length === 0) {
    return { recorded: false, oldestRecordedVersion: null }
  }

  // Oldest/newest by VALUE, never by file position — a hand-edited or reordered
  // changelog must not silently invert this via list order.
  let oldest = headings[0]
  for (const h of headings) {
    if (changelogSpanCmp(h.versionTuple, oldest.versionTuple) < 0) oldest = h
  }

  if (changelogSpanCmp(from, oldest.versionTuple) < 0) {
    // fromVersion predates every heading this changelog carries — nothing to slice,
    // and saying so is the whole point: this is NOT "no changes", it is "no record".
    return { recorded: false, oldestRecordedVersion: oldest.version }
  }

  // Headings strictly after `from`, up to and including `to` — sorted NEWEST FIRST
  // (the useful reading order for "what did I miss"), independent of file order.
  const inRange = headings
    .filter((h) => changelogSpanCmp(h.versionTuple, from) > 0 && changelogSpanCmp(h.versionTuple, to) <= 0)
    .sort((a, b) => -changelogSpanCmp(a.versionTuple, b.versionTuple))

  // COVERAGE, computed only from the two REQUESTED versions — never from the file's
  // oldest/newest heading, which is exactly the reading that missed the interior gap
  // (see the file-header comment). Minor-version arithmetic: the plugin's whole history
  // sits under major 0 and every release bumps a minor by exactly one number (patch
  // bumps are rare, in-place hotfixes that share their minor with a sibling heading),
  // so "expected minors between from and to" is `to.minor - from.minor`, compared
  // against the count of DISTINCT minors actually represented among `inRange`'s
  // headings. A major mismatch invalidates that arithmetic outright — reported as
  // `null` (cannot determine), never guessed at as complete.
  let missingVersionCount = null
  if (from[0] === to[0]) {
    const expectedMinors = to[1] - from[1]
    const recordedMinors = new Set(inRange.map((h) => h.versionTuple[1])).size
    missingVersionCount = Math.max(0, expectedMinors - recordedMinors)
  }

  // Body = from this heading's line, up to (not including) the next heading of ANY
  // version in the whole file (not just those in-range) — so a body never swallows a
  // sibling entry that happened to fall outside the requested range.
  const allByLine = [...headings].sort((a, b) => a.lineIndex - b.lineIndex)
  function bodyFor(h) {
    const pos = allByLine.findIndex((x) => x.lineIndex === h.lineIndex)
    const nextLineIndex = pos + 1 < allByLine.length ? allByLine[pos + 1].lineIndex : lines.length
    return lines
      .slice(h.lineIndex, nextLineIndex)
      .join('\n')
      .replace(/\n+$/, '')
  }

  const totalCount = inRange.length
  const shown = inRange.slice(0, maxEntries)
  const omittedCount = totalCount - shown.length

  const entries = shown.map((h) => ({
    version: h.version,
    heading: h.headingLine,
    body: bodyFor(h),
  }))

  return { recorded: true, entries, totalCount, omittedCount, missingVersionCount }
}
// === CHANGELOG-SPAN CORE END ===

/** Cached text of plugin/CHANGELOG.md, read once per process — several stale items in
 *  one run must not each pay a fresh read. `null` means "not yet attempted",
 *  `''` means "attempted and unreadable" (a missing/unreadable changelog degrades to a
 *  stated line, never a crash of the whole --check report). */
let cachedPluginChangelog = null

function pluginChangelogText(root) {
  if (cachedPluginChangelog !== null) return cachedPluginChangelog
  try {
    cachedPluginChangelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  } catch {
    cachedPluginChangelog = ''
  }
  return cachedPluginChangelog
}

/** Print the changelog span for a STALE item, right under its own status line — the
 *  payoff the card names: a reading session sees not just that a copy is behind, but
 *  what the intervening versions actually SHIPPED, in enough words to notice an overlap
 *  with its own local machinery. Never called for anything but a STALE item — an
 *  up-to-date or hand-authored file has no span to show. */
function printChangelogSpan(root, fromVersion, toVersion) {
  if (fromVersion === toVersion) {
    process.stdout.write(
      `    CHANGELOG v${fromVersion}: content changed without a version change; no version range to show.\n`,
    )
    return
  }
  const changelog = pluginChangelogText(root)
  if (!changelog) {
    process.stdout.write(
      `    CHANGELOG: plugin/CHANGELOG.md not found next to the plugin manifest — cannot show what shipped.\n`,
    )
    return
  }
  let span
  try {
    span = changelogSpan(changelog, fromVersion, toVersion)
  } catch (err) {
    process.stdout.write(`    CHANGELOG: could not compute the span (${err && err.message ? err.message : err}).\n`)
    return
  }
  if (!span.recorded) {
    process.stdout.write(
      `    CHANGELOG v${fromVersion} → v${toVersion}: NO RECORD for this range — v${fromVersion} predates ` +
        `every heading the changelog carries (oldest recorded: v${span.oldestRecordedVersion ?? 'none'}). ` +
        `This does NOT mean nothing changed; it means the changelog has no entry that far back.\n`,
    )
    return
  }
  // Coverage is a THIRD, independent signal from totalCount — a query can have entries
  // AND still be missing part of its own range (an interior gap the boundary check above
  // cannot see; see the CHANGELOG-SPAN CORE header comment). So it is always stated
  // explicitly, never left to be inferred from "did it print any warning": a reader must
  // not be able to mistake an incomplete span for a complete one just because neither
  // said so.
  const coverageLine =
    span.missingVersionCount === null
      ? '    COVERAGE: cannot determine — v' + fromVersion + ' and v' + toVersion + ' are different major versions.\n'
      : span.missingVersionCount === 0
        ? '    COVERAGE: complete — every version between v' + fromVersion + ' and v' + toVersion + ' has a changelog entry.\n'
        : `    COVERAGE: INCOMPLETE — approx. ${span.missingVersionCount} version(s) between v${fromVersion} ` +
          `and v${toVersion} have NO changelog entry at all. The entries below are everything recorded, ` +
          `not everything that shipped.\n`
  if (span.totalCount === 0) {
    process.stdout.write(`    CHANGELOG v${fromVersion} → v${toVersion}: no changes recorded in this range.\n`)
    process.stdout.write(coverageLine)
    return
  }
  process.stdout.write(
    `    CHANGELOG v${fromVersion} → v${toVersion} (${span.totalCount} entr${span.totalCount === 1 ? 'y' : 'ies'}` +
      (span.omittedCount > 0
        ? `, showing the ${span.entries.length} most recent, ${span.omittedCount} older omitted`
        : '') +
      `):\n`,
  )
  process.stdout.write(coverageLine)
  for (const entry of span.entries) {
    for (const line of entry.body.split('\n')) process.stdout.write(`    | ${line}\n`)
  }
}

const CLI_VALUE_OPTIONS = {
  '--dir': 'dir',
  '--set': 'set',
  '--user-dir': 'userDir',
  '--pairs-file': 'pairsFile',
  '--declarations-file': 'declarationsFile',
  '--secondary-dir': 'secondaryDir',
  '--file': 'file',
}

const CLI_BOOLEAN_OPTIONS = {
  '--force': 'force',
  '--replace-symlinks': 'replaceSymlinks',
  '--global': 'global',
  '--dry-run': 'dryRun',
  '--ignore-secondary': 'ignoreSecondary',
  '--execute': 'execute',
}

const CLI_MODE_OPTIONS = {
  '--install': 'install',
  '--check': 'check',
  '--audit-overlap': 'audit-overlap',
  '--migrate': 'migrate',
}

function defaultCliArgs() {
  return {
    mode: 'check',
    dir: null,
    global: false,
    force: false,
    set: 'rules',
    replaceSymlinks: false,
    userDir: null,
    pairsFile: null,
    declarationsFile: null,
    dryRun: false,
    secondaryDir: null,
    ignoreSecondary: false,
    execute: false,
    diffFile: null,
    file: null,
  }
}

function parseArgs(argv) {
  const args = defaultCliArgs()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (Object.hasOwn(CLI_MODE_OPTIONS, token)) args.mode = CLI_MODE_OPTIONS[token]
    else if (Object.hasOwn(CLI_BOOLEAN_OPTIONS, token)) args[CLI_BOOLEAN_OPTIONS[token]] = true
    else if (Object.hasOwn(CLI_VALUE_OPTIONS, token)) args[CLI_VALUE_OPTIONS[token]] = argv[++i]
    else if (token === '--diff') {
      args.mode = 'diff'
      args.diffFile = argv[++i]
    }
  }
  return args
}

// Which flags are actually READ by which mode's code path — the single source of truth
// this function's guard checks against. A flag absent from its own mode's list has NO
// EFFECT there: nothing downstream ever reads it. That must REFUSE, not silently accept —
// the original bug (measured): `--user-dir` was parsed and stored in every
// mode but read only inside auditOverlap(), so `--check --user-dir <x>` reported on the
// --dir/cwd fallback while looking like it had honoured the caller's target.
//
// Keep this table in sync with what each mode's branch in main()/auditOverlap() actually
// reads — that is the invariant being enforced ("no flag is accepted where it does nothing"),
// not an enumeration of today's specific flags. Adding a flag that is mode-scoped means
// adding one line here; forgetting to is exactly the class of bug this guard exists to catch
// in every OTHER flag, so it would still be caught the next time this list is audited against
// the parsing/reading sites.
// `modes` is the mode scope; the OPTIONAL `sets` narrows a flag further to the
// --set values that actually read it. A flag effective in a mode but only for
// SOME sets needs both, or it is accepted and silently ignored for the others —
// which is the same defect class as a mode-only flag accepted in every mode.
const FLAG_EFFECTIVE_MODES = {
  userDir: { cli: '--user-dir', modes: ['audit-overlap'] },
  pairsFile: { cli: '--pairs-file', modes: ['audit-overlap'] },
  declarationsFile: { cli: '--declarations-file', modes: ['audit-overlap'], sets: ['rules'] },
  dir: { cli: '--dir', modes: ['check', 'install', 'migrate', 'diff'] },
  global: { cli: '--global', modes: ['check', 'install', 'migrate', 'diff'] },
  force: { cli: '--force', modes: ['install'] },
  replaceSymlinks: { cli: '--replace-symlinks', modes: ['check', 'install'] },
  dryRun: { cli: '--dry-run', modes: ['migrate'] },
  secondaryDir: { cli: '--secondary-dir', modes: ['migrate'] },
  ignoreSecondary: { cli: '--ignore-secondary', modes: ['migrate'] },
  execute: { cli: '--execute', modes: ['migrate'] },
  diffFile: { cli: '--diff', modes: ['diff'] },
  file: { cli: '--file', modes: ['install'] },
}

/** Refuse any flag that was passed but has no effect in the resolved mode (or set). */
function checkFlagModeAsymmetry(args) {
  for (const [key, { cli, modes, sets }] of Object.entries(FLAG_EFFECTIVE_MODES)) {
    const passed = args[key] !== null && args[key] !== false
    if (!passed) continue
    if (!modes.includes(args.mode)) {
      const modeList = modes.map((m) => `--${m}`).join(' or ')
      const extra =
        key === 'userDir'
          ? ' — to target a directory under --check/--install, use --dir instead'
          : key === 'force'
            ? ' — pass --install --force to overwrite locally-edited copies'
            : ''
      fail(`${cli} has no effect with --${args.mode} (only honoured with ${modeList})${extra}`)
    }
    if (sets && !sets.includes(args.set)) {
      const setList = sets.map((s) => `--set ${s}`).join(' or ')
      fail(`${cli} has no effect with --set ${args.set} (only honoured with ${setList})`)
    }
  }
}

// Follows symlinks deliberately (unlike classify()'s lstat-first write-safety check): this
// mode never writes, and a VALID symlink still means the concern is genuinely loaded from
// this path — e.g. the exact pre-2026-07-23 work-side shape (a symlinked original alongside
// a newly-installed wt-* copy) must count as a real double-load, not read as absent. A
// dangling symlink throws in statSync and is correctly treated as absent.
function realFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function normalizedLines(text) {
  return text.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, ''))
}

// The two candidate locations for the RULES set during the flat-root → rules/wt/
// transition (card 1835727457): whichever of {userDir, its 'wt' opposite} the caller
// pointed at, plus the other one. Checking only `userDir` during the transition is exactly
// how a project that has genuinely adopted the rules (just not yet migrated, or already
// migrated and left an orphan behind) reads as "nothing adopted" or "everything drifted" —
// a false negative/positive that looks identical to a real one. Agents never moved, so this
// widening applies to the rules set only.
function rulesSearchDirs(userDir) {
  const alt = path.basename(userDir) === 'wt' ? path.dirname(userDir) : path.join(userDir, 'wt')
  return [userDir, alt]
}

/** The first candidate dir (in search order) actually holding `filename`, or null. */
function findFile(searchDirs, filename) {
  for (const dir of searchDirs) {
    const p = path.join(dir, filename)
    if (realFile(p)) return p
  }
  return null
}

function auditInventory(searchDirs) {
  const entries = []
  let found = false
  for (const dir of searchDirs) {
    try {
      entries.push(...fs.readdirSync(dir))
      found = true
    } catch {
      // A candidate may be absent during the flat-root transition.
    }
  }
  if (!found) fail(`user directory does not exist: ${searchDirs.join(' nor ')}`)
  return [...new Set(entries)]
}

function readShipDeclarations(declarationsFile, pairsPath, declaredUsers, declaredShipped) {
  const defaultPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ship-declarations.json')
  const declarationsPath = path.resolve(declarationsFile || defaultPath)
  let declarations
  try {
    declarations = JSON.parse(fs.readFileSync(declarationsPath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return new Map()
    if (error instanceof SyntaxError) fail(`invalid ship declarations file ${declarationsPath}: invalid JSON`)
    throw error
  }
  if (!Array.isArray(declarations)) fail(`invalid ship declarations file ${declarationsPath}: root must be a JSON array`)
  for (const [index, entry] of declarations.entries()) {
    validateShipDeclaration(entry, index, declarationsPath, pairsPath, declaredUsers, declaredShipped)
  }
  return new Map(declarations.map((entry) => [entry.user, entry]))
}

function validateShipDeclaration(entry, index, declarationsPath, pairsPath, declaredUsers, declaredShipped) {
  const prefix = `invalid ship declarations file ${declarationsPath}: entry ${index}`
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${prefix} must be an object`)
  if (typeof entry.user !== 'string' || entry.user.trim() === '') fail(`${prefix} field 'user' must be a non-empty string`)
  if (!['private', 'undecided', 'shipped-as'].includes(entry.status)) {
    fail(`${prefix} field 'status' must be one of private | undecided | shipped-as`)
  }
  const hasTarget = Object.prototype.hasOwnProperty.call(entry, 'target')
  if (entry.status === 'shipped-as' && (typeof entry.target !== 'string' || entry.target.trim() === '')) {
    fail(`${prefix} field 'target' must be a non-empty string when status is 'shipped-as'`)
  }
  if (entry.status !== 'shipped-as' && hasTarget) fail(`${prefix} field 'target' is allowed only when status is 'shipped-as'`)
  if (declaredUsers.has(entry.user) || declaredShipped.has(entry.user)) {
    fail(`${prefix} user '${entry.user}' collides with a declared pair (user or shipped side) in ${pairsPath}`)
  }
}

function emptyAuditCounts() {
  return {
    duplicate: 0, drift: 0, absent: 0, unpaired: 0, unmapped: 0,
    declaredPrivate: 0, undecided: 0, declaredPorted: 0, declarationError: 0,
    driftMissingFromShipped: 0, driftMissingFromProject: 0,
  }
}

function countUnpaired(setConfig, root, declaredShipped, pairsPath, set) {
  let count = 0
  for (const item of setConfig.resolveItems(root)) {
    if (declaredShipped.has(item.file)) continue
    count++
    process.stdout.write(
      `UNPAIRED ${item.file}: no pairing entry in ${pairsPath} — this shipped ${set === 'agents' ? 'agent' : 'rule'} is untracked by audit-overlap\n`,
    )
  }
  return count
}

function countLocationDuplicates(setConfig, root, searchDirs, set) {
  if (set !== 'rules' || searchDirs.length < 2 || searchDirs[0] === searchDirs[1]) return 0
  let count = 0
  for (const item of setConfig.resolveItems(root)) {
    const primaryPath = path.join(searchDirs[0], item.file)
    const otherPath = path.join(searchDirs[1], item.file)
    if (!realFile(primaryPath) || !realFile(otherPath)) continue
    count++
    process.stdout.write(
      `DUPLICATE-LOCATION ${item.file}: present at BOTH ${primaryPath} and ${otherPath} — loaded twice (pre-migration copy not yet removed)\n`,
    )
  }
  return count
}

function pairLocations(pair, userDir, searchDirs, shippedDir) {
  const foundUserPath = findFile(searchDirs, pair.user)
  const foundShippedPath = pair.shipped !== pair.user ? findFile(searchDirs, pair.shipped) : null
  return {
    userExists: foundUserPath !== null,
    adoptedDirectly: foundShippedPath !== null,
    declaredUserPath: foundUserPath || path.join(userDir, pair.user),
    adoptedPath: foundShippedPath || path.join(userDir, pair.shipped),
    shippedPath: path.join(shippedDir, pair.shipped),
  }
}

function pairLineDiff(pair, locations, set, setConfig, stripBanner) {
  const userPath = locations.userExists ? locations.declaredUserPath : locations.adoptedPath
  const userContent = fs.readFileSync(userPath, 'utf8')
  const userHasBanner = VERSION_RE.test(bannerLine(setConfig, userContent))
  const userLines = normalizedLines(userHasBanner ? stripBanner(userContent) : userContent)
  const shippedLines = new Set(normalizedLines(stripBanner(fs.readFileSync(locations.shippedPath, 'utf8'))))
  const allow = Array.isArray(pair.allowExtraPatterns) ? pair.allowExtraPatterns.map((pattern) => new RegExp(pattern)) : []
  const extras = [...new Set(userLines.filter((line) => line !== '' && !shippedLines.has(line)))].filter(
    (line) => !allow.some((pattern) => pattern.test(line)),
  )
  const userLineSet = new Set(userLines)
  const missing = set === 'agents'
    ? [...new Set([...shippedLines].filter((line) => line !== '' && !userLineSet.has(line)))]
    : []
  return { extras, missing }
}

function renderPairDrift(pair, locations, extras, missing) {
  const partial = pair.partial === true
  const label = partial ? 'DRIFT (partial, informational)' : 'DRIFT'
  process.stdout.write(
    locations.adoptedDirectly
      ? `${label} ${pair.user}: adopted under shipped name (${pair.shipped}), content diverges from the shipped source\n`
      : `${label} ${pair.user}\n`,
  )
  for (const line of extras.slice(0, 40)) process.stdout.write(`${label} ${pair.user} (${MISSING_FROM_SHIPPED}): ${line}\n`)
  if (extras.length > 40) process.stdout.write(`${label} ${pair.user} (${MISSING_FROM_SHIPPED}): +${extras.length - 40} more\n`)
  for (const line of missing.slice(0, 40)) process.stdout.write(`${label} ${pair.user} (${MISSING_FROM_PROJECT}): ${line}\n`)
  if (missing.length > 40) process.stdout.write(`${label} ${pair.user} (${MISSING_FROM_PROJECT}): +${missing.length - 40} more\n`)
  return {
    drift: partial ? 0 : 1,
    driftMissingFromShipped: !partial && extras.length > 0 ? 1 : 0,
    driftMissingFromProject: !partial && missing.length > 0 ? 1 : 0,
  }
}

function auditPair(pair, context) {
  const locations = pairLocations(pair, context.userDir, context.searchDirs, context.shippedDir)
  if (!locations.userExists && !locations.adoptedDirectly) {
    process.stdout.write(`ABSENT ${pair.user}: ABSENT (declared pair, no user file present)\n`)
    return { absent: context.set === 'agents' ? 1 : 0 }
  }
  if (locations.userExists && locations.adoptedDirectly) {
    const partial = pair.partial === true
    process.stdout.write(`${partial ? 'DUPLICATE (partial, informational)' : 'DUPLICATE'} ${locations.declaredUserPath} + ${locations.adoptedPath}\n`)
    return { duplicate: partial ? 0 : 1 }
  }
  if (!realFile(locations.shippedPath)) {
    process.stdout.write(`CLEAN ${pair.user}: no shipped comparison file\n`)
    return {}
  }
  const { extras, missing } = pairLineDiff(pair, locations, context.set, context.setConfig, context.stripBanner)
  if (extras.length === 0 && missing.length === 0) {
    process.stdout.write(
      locations.adoptedDirectly ? `CLEAN ${pair.user}: adopted under shipped name (${pair.shipped})\n` : `CLEAN ${pair.user}\n`,
    )
    return {}
  }
  return renderPairDrift(pair, locations, extras, missing)
}

function mergeAuditCounts(counts, addition) {
  for (const [key, value] of Object.entries(addition)) counts[key] += value
}

function auditUnmappedFile(file, foundPath, context) {
  if (context.set !== 'rules') {
    process.stdout.write(`UNMAPPED ${foundPath}\n`)
    return { unmapped: 1 }
  }
  const declaration = context.declaredStatus.get(file)
  if (!declaration) {
    process.stdout.write(`UNMAPPED ${foundPath}\n`)
    return { unmapped: 1 }
  }
  if (declaration.status === 'private') return { declaredPrivate: 1 }
  if (declaration.status === 'undecided') {
    process.stdout.write(`UNDECIDED ${foundPath}: ship/keep-private decision recorded as owed — resolve before the next release\n`)
    return { undecided: 1 }
  }
  const targetPath = path.join(context.shippedDir, declaration.target)
  if (realFile(targetPath)) return { declaredPorted: 1 }
  process.stdout.write(
    `DECLARATION-ERROR ${foundPath}: declared shipped-as '${declaration.target}', but no such shipped file exists at ${targetPath}\n`,
  )
  return { declarationError: 1 }
}

function auditUnmapped(entries, context, counts) {
  for (const file of entries.filter((entry) => entry.endsWith('.md')).sort()) {
    if (context.declaredUsers.has(file) || context.declaredShipped.has(file)) continue
    const foundPath = findFile(context.searchDirs, file)
    if (foundPath) mergeAuditCounts(counts, auditUnmappedFile(file, foundPath, context))
  }
}

function renderAuditSummary(set, counts) {
  if (set === 'agents') {
    process.stdout.write(
      `audit-overlap: ${counts.duplicate} duplicate, ${counts.drift} drift, ${counts.absent} absent, ${counts.unpaired} unpaired, ${counts.unmapped} unmapped\n`,
    )
  } else {
    process.stdout.write(
      `audit-overlap: ${counts.duplicate} duplicate, ${counts.drift} drift, ${counts.unpaired} unpaired, ${counts.unmapped} unmapped, ` +
        `${counts.declaredPrivate} declared-private (silent), ${counts.undecided} undecided, ${counts.declaredPorted} declared-ported (silent), ${counts.declarationError} declaration-error\n`,
    )
  }
  if (counts.driftMissingFromShipped > 0 || counts.driftMissingFromProject > 0) {
    process.stdout.write(
      `  ↳ drift direction: ${counts.driftMissingFromProject} pair(s) ${MISSING_FROM_PROJECT} (project is BEHIND the shipped template), ` +
        `${counts.driftMissingFromShipped} pair(s) ${MISSING_FROM_SHIPPED} (project has DIVERGED ahead of the shipped template)\n`,
    )
  }
  if (counts.duplicate || counts.drift || counts.unpaired || (set === 'agents' && counts.absent) || counts.declarationError) {
    process.exitCode = 1
  }
}

function auditOverlap(userDir, root, pairsFile, declarationsFile, set = 'rules') {
  const setConfig = SETS[set]
  if (!setConfig) fail(`unknown audit-overlap set '${set}' (expected rules | agents)`)
  const searchDirs = set === 'rules' ? rulesSearchDirs(userDir) : [userDir]
  process.stdout.write(`[audit-overlap:${set}] target=${userDir}\n`)
  if (searchDirs.length > 1) process.stdout.write(`  ↳ also searching ${searchDirs[1]} (flat-root/rules-wt transition, card 1835727457)\n`)
  const entries = auditInventory(searchDirs)
  const defaultPairsFile = set === 'agents' ? 'agent-pairs.json' : 'rule-pairs.json'
  const pairsPath = path.resolve(pairsFile || path.join(path.dirname(fileURLToPath(import.meta.url)), defaultPairsFile))
  const pairs = JSON.parse(fs.readFileSync(pairsPath, 'utf8'))
  const declaredUsers = new Set(pairs.map((pair) => pair.user))
  const declaredShipped = new Set(pairs.map((pair) => pair.shipped))
  const declaredStatus = set === 'rules'
    ? readShipDeclarations(declarationsFile, pairsPath, declaredUsers, declaredShipped)
    : new Map()
  const context = {
    set, setConfig, userDir, searchDirs, declaredUsers, declaredShipped, declaredStatus,
    shippedDir: path.join(root, setConfig.srcDir),
    stripBanner: set === 'agents' ? stripAgentBanner : stripRuleBanner,
  }
  const counts = emptyAuditCounts()
  counts.unpaired = countUnpaired(setConfig, root, declaredShipped, pairsPath, set)
  counts.duplicate = countLocationDuplicates(setConfig, root, searchDirs, set)
  for (const pair of pairs) mergeAuditCounts(counts, auditPair(pair, context))
  auditUnmapped(entries, context, counts)
  renderAuditSummary(set, counts)
}

/** Decide the status label and (for --install) whether to write. `force` only ever
 *  overrides a MANAGED file (edited / edited-unknown / clean); a hand-authored file
 *  with no toolbox banner is NEVER overwritten — we won't clobber a file we never
 *  stamped. A symlink is never written THROUGH: it writes only under `replaceSymlinks`
 *  (and then writeManagedItem atomically replaces the link, preserving its target). */
function plan({ classification: c, version, force, replaceSymlinks, shippedFp, currentContentFp = shippedFp }) {
  // CONTENT wins over banner metadata, including an old/ahead version or stale stored hash.
  // Comparison uses contentFingerprint's trailing-EOF-whitespace normalization.
  if (c.installedVer && shippedFp && c.contentFp === shippedFp) {
    return {
      status:
        cmp(c.installedVer, version) === 0
          ? `UP-TO-DATE (v${c.installedVer})`
          : `UP-TO-DATE (banner v${c.installedVer}; content identical to v${version})`,
      write: force,
    }
  }
  if (c.installedVer && cmp(c.installedVer, version) > 0) {
    return { status: `AHEAD/FORKED (installed v${c.installedVer} > v${version}; content differs)`, write: force }
  }
  switch (c.state) {
    case 'absent':
      return { status: 'ABSENT', write: true }
    case 'symlink':
      return {
        status:
          `SYMLINK (→ ${c.linkTarget || '?'})` +
          (replaceSymlinks
            ? ' — will be replaced with a managed copy in place'
            : ' — left untouched; pass --replace-symlinks to replace it with a managed copy'),
        write: replaceSymlinks,
        symlink: true,
      }
    case 'hand-authored':
      return { status: 'PRESENT (no toolbox banner — hand-authored; left untouched)', write: false }
    case 'edited':
      return {
        status: 'EDITED (managed, locally modified)' + (force ? '' : ' — re-run with --force to overwrite'),
        write: force,
      }
    case 'edited-unknown':
      return {
        status:
          'EDITED? (managed, pre-fingerprint banner — cannot verify; treated as edited)' +
          (force ? '' : ' — re-run with --force to overwrite'),
        write: force,
      }
    case 'clean': {
      const c2 = cmp(c.installedVer, version)
      if (c2 < 0) return { status: `STALE (installed v${c.installedVer} < v${version})`, write: true }
      if (c2 === 0 && currentContentFp && c.contentFp !== currentContentFp) {
        return { status: `STALE (content differs at v${version})`, write: true }
      }
      // A current-version clean agent may carry an installer-preserved local frontmatter field.
      return { status: `UP-TO-DATE (v${c.installedVer})`, write: force }
    }
    default:
      return { status: `UNKNOWN (${c.state})`, write: false }
  }
}

function legacyItemDecision(set, dir, item, classification) {
  if (classification.state !== 'absent' || set.kind !== 'rules') return null
  const legacyDir = legacyRulesDir(dir)
  if (!legacyDir) return null
  const legacy = classify(path.join(legacyDir, item.file), set)
  if (legacy.state === 'absent') return null
  const location = `${legacyDir}/${item.file}`
  const found = legacy.state === 'symlink' ? `found as a SYMLINK at the pre-migration location ${location}` : `found at the pre-migration location ${location}`
  return {
    status: `MIGRATION-PENDING (${found}; not yet migrated to ${dir}/ — run the adopt:migrate skill's --dry-run before --install here, or --install would write a fresh copy here and leave the old one in place, loading it twice)`,
    write: false,
  }
}

function siblingOnDemandDir(set, dir, args) {
  if (!args.dir || args.mode !== 'install' || set.kind !== 'rules') return null
  const resolved = path.resolve(dir)
  if (path.basename(resolved) === 'wt' && path.basename(path.dirname(resolved)) === 'rules') {
    return path.join(path.dirname(path.dirname(resolved)), 'rules-on-demand')
  }
  if (path.basename(resolved) === 'rules') return path.join(path.dirname(resolved), 'rules-on-demand')
  return null
}

function decideManagedItem(set, dir, item, args, version, root, alternateDirs) {
  const target = path.join(dir, item.file)
  const classification = classify(target, set)
  const shippedFp = shippedFingerprint(set, item, root)
  const currentContentFp = shippedFingerprint(set, item, root, classification.body, true)
  let decision = plan({
    classification,
    version,
    force: args.force,
    replaceSymlinks: args.replaceSymlinks,
    shippedFp,
    currentContentFp,
  })
  let duplicate = false
  if (alternateDirs.nested && hasAdoptionBanner(set, target) && hasAdoptionBanner(set, path.join(alternateDirs.nested, item.file))) {
    duplicate = true
    decision = { status: `DUPLICATE (also present in ${alternateDirs.nested}/${item.file})`, write: false }
  }
  if (alternateDirs.onDemand && hasAdoptionBanner(set, path.join(alternateDirs.onDemand, item.file))) {
    duplicate = true
    decision = { status: `DUPLICATE (adopted copy already present in ${path.join(alternateDirs.onDemand, item.file)})`, write: false }
  }
  const legacyDecision = legacyItemDecision(set, dir, item, classification)
  if (legacyDecision) decision = legacyDecision
  const stale =
    classification.state === 'clean' &&
    ((cmp(classification.installedVer, version) < 0 && shippedFp && classification.contentFp !== shippedFp) ||
      (cmp(classification.installedVer, version) === 0 && currentContentFp && classification.contentFp !== currentContentFp))
  return { target, classification, decision, stale, migrationPending: !!legacyDecision, duplicate }
}

function existingContentForRender(set, target, classification) {
  const preserveAgentFields = set.kind === 'agents' && ['edited', 'edited-unknown'].includes(classification.state)
  const preserveOnDemandFrontmatter = set.kind === 'rules' && classification.frontmatter
  if (!preserveAgentFields && !preserveOnDemandFrontmatter) return null
  try {
    return fs.readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

function managedWriteVerb(classification, force) {
  if (classification.state === 'absent') return 'WROTE'
  if (classification.state === 'symlink') return 'REPLACED symlink with'
  if (force && classification.state !== 'clean') return 'OVERWROTE (--force)'
  return 'REFRESHED'
}

function writeManagedFile(target, text, exclusive = false) {
  fs.writeFileSync(target, text, exclusive ? { flag: 'wx' } : undefined)
}

function replaceSymlinkAtomically(target, text) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.workflow-toolbox-${process.pid}.tmp`)
  let ownsTemp = false
  try {
    writeManagedFile(temp, text, true)
    ownsTemp = true
    moveFileVerified(temp, target)
  } finally {
    if (ownsTemp) fs.rmSync(temp, { force: true })
  }
}

function writeManagedItem(set, dir, item, args, version, root, planned) {
  const { target, classification } = planned
  const oldContent = existingContentForRender(set, target, classification)
  const { text: finalText, preserved } = renderItem(set, item, version, root, oldContent)
  if (preserved.length > 0) {
    process.stdout.write(
      `  ${item.file}: PRESERVING local frontmatter field(s) not defined by the shipped def: ${preserved.join(', ')}\n`,
    )
  }
  if (classification.state === 'symlink') replaceSymlinkAtomically(target, finalText)
  else writeManagedFile(target, finalText)
  const verb = managedWriteVerb(classification, args.force)
  appendAdoptionJournal(dir, {
    timestamp: new Date().toISOString(),
    file: item.file,
    directory: dir,
    action: verb,
    beforeVersion: classification.installedVer ?? null,
    afterVersion: version,
    adoptedText: stripBannerFor(set, finalText),
  })
  const versions = classification.installedVer ? `v${classification.installedVer} -> v${version}` : `none -> v${version}`
  process.stdout.write(`  ${item.file}: ${verb} ${versions} -> ${target} (journal ${journalPath(dir)})\n`)
}

function renderManagedItem(set, dir, item, args, version, root, alternateDirs) {
  const planned = decideManagedItem(set, dir, item, args, version, root, alternateDirs)
  const { classification, decision } = planned
  if (args.mode === 'install') {
    if (decision.write) writeManagedItem(set, dir, item, args, version, root, planned)
    else process.stdout.write(`  ${item.file}: SKIPPED — ${decision.status}\n`)
  } else {
    process.stdout.write(`  ${item.file}: ${decision.status}\n`)
    if (decision.status.startsWith('STALE') && classification.installedVer) {
      printChangelogSpan(root, classification.installedVer, version)
    }
  }
  return {
    anyAbsent: classification.state === 'absent',
    anyStale: planned.stale,
    anyEdited: ['edited', 'edited-unknown'].includes(classification.state),
    anySymlink: classification.state === 'symlink',
    anyMigrationPending: planned.migrationPending,
    anyDuplicate: planned.duplicate,
  }
}

/** Process one set into `dir`. Returns the aggregate flags for the check-mode hint. */
function processSet(set, dir, args, version, root, selectedItems = null) {
  if (args.mode === 'install') fs.mkdirSync(dir, { recursive: true })
  process.stdout.write(`[${set.kind}] target=${dir}\n`)
  const nestedDir = explicitNestedTarget(set, dir, args)
  const onDemandDir = siblingOnDemandDir(set, dir, args)
  const alternateDirs = { nested: nestedDir, onDemand: onDemandDir }
  const items = set.resolveItems(root)
  if (args.file && !items.some((item) => item.file === args.file)) {
    fail(`--file is not managed by --set ${set.kind}: ${args.file}`)
  }
  const state = {
    anyAbsent: false,
    anyStale: false,
    anyEdited: false,
    anySymlink: false,
    anyMigrationPending: false,
    anyDuplicate: false,
  }
  for (const item of items.filter((candidate) =>
    (!args.file || candidate.file === args.file) && (!selectedItems || selectedItems.has(candidate.file)))) {
    mergeSetState(state, renderManagedItem(set, dir, item, args, version, root, alternateDirs))
  }
  return state
}

// --- --migrate --dry-run --------------------------------------------------------------------
//
// Card 1835727457 scope split (Frederic, 06/08 evening): "if we're very careful, I can stop
// my sessions and run a batch. But we need a dry-run mode to really see what it's going to
// do." This is that mode, and ONLY that mode — the actual move is deliberately NOT
// implemented anywhere in this script. `--migrate` without `--dry-run` refuses outright
// (see main()) so the code cannot be run "because it's ready"; running the real migration
// needs a human decision this script does not make.
//
// What the dry-run must show, per Frederic's own second comment on the card, in this order:
//   1. every file it would move, source → destination, absolute paths
//   2. every file it would LEAVE at the root, WITH THE REASON
//   3. the set LOADED before/after, in file count AND bytes
//   4. what happens to the second config dir's per-file symlinks
//   5. locally-edited copies (which stay put — never silently overwritten/moved)
// and it must exit NON-ZERO when it would produce a duplicate (loaded twice) after migration —
// a dry-run that describes a dangerous state and exits 0 is a report, not a guard.

/** Recursively list every managed-looking `*.md` file under `dir` (excluding README.md at
 *  any depth, mirroring discoverRuleItems' own filter) — this is what a rules loader that
 *  recurses into subdirectories (measured fact, card 1835727457's own description) actually
 *  reads, so it is the right shape for a "what's loaded" count. Returns [] for a dir that
 *  does not exist (nothing loaded from there yet, not an error). */
function listMdFilesRecursive(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listMdFilesRecursive(p))
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      let bytes = 0
      try {
        bytes = fs.statSync(p).size
      } catch {
        /* file vanished between readdir and stat — count as 0, do not crash a read-only report */
      }
      out.push({ file: p, bytes })
    }
  }
  return out
}

function sumBytes(list) {
  return list.reduce((total, item) => total + item.bytes, 0)
}

/** Per-file plan for the flat-root → rules/wt/ migration. Read-only: classifies what is
 *  ALREADY on disk and reports what a future move would do; writes nothing. */
function planMigrationItems(flatDir, wtDir, set) {
  const moves = []
  const stays = []
  let entries
  try {
    entries = fs.readdirSync(flatDir, { withFileTypes: true })
  } catch {
    return { moves, stays } // nothing at the flat root — nothing to migrate (graceful)
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.toLowerCase() === 'readme.md') continue
    const file = entry.name
    const from = path.join(flatDir, file)
    const to = path.join(wtDir, file)
    // classify() reads the file (fs.readFileSync) after its own lstat — an existing-but-
    // unreadable source (permissions, a race that removed it after readdir) throws there.
    // That is a plan property, not a crash: an unreadable source is exactly the "unsafe
    // plan" case --migrate --execute must refuse on, so it is folded into `stays` with
    // duplicateRisk so BOTH modes treat it the same way dry-run's own exit-nonzero check and
    // execute's pre-flight refusal already read.
    let c
    try {
      c = classify(from, set)
    } catch (e) {
      stays.push({
        file,
        from,
        reason: `unreadable source — ${e instanceof Error ? e.message : String(e)}`,
        duplicateRisk: true,
      })
      continue
    }
    if (c.state === 'hand-authored') {
      stays.push({ file, from, reason: 'hand-authored — no workflow-toolbox banner; adopt never manages or moves it', duplicateRisk: false })
      continue
    }
    if (c.state === 'symlink') {
      stays.push({
        file,
        from,
        reason: `symlink → ${c.linkTarget || '?'} — migration does not follow or move symlinks; see the second-config-dir section`,
        duplicateRisk: false,
      })
      continue
    }
    if (c.state === 'edited' || c.state === 'edited-unknown') {
      // adopt NEVER overwrites or moves a locally-edited copy (the same rule --install
      // follows). It stays at the flat root. But a later bare `--install --set rules` targets
      // the NEW default (rules/wt/) and, finding this file ABSENT there, WOULD write a fresh
      // shipped copy — so the edited copy and the fresh copy both end up loaded. That is the
      // duplicate Frederic's comment names explicitly, and it exists independent of whether
      // rules/wt/<file> happens to already be there today.
      stays.push({
        file,
        from,
        reason:
          'locally edited — adopt never overwrites or moves an edited copy. Move it by hand once ' +
          'you are satisfied with the diff, or it stays loaded from BOTH locations the next time ' +
          '--install runs (it writes a fresh copy at the new default location, since this file is ' +
          'absent there)',
        duplicateRisk: true,
      })
      continue
    }
    // clean — the only state eligible for an actual move.
    if (realFile(to)) {
      stays.push({
        file,
        from,
        reason: `destination already exists at ${to} — migration never overwrites; resolve the duplicate by hand first`,
        duplicateRisk: true,
      })
      continue
    }
    moves.push({ file, from, to })
  }
  return { moves, stays }
}

/** Report what a `<secondary>/rules/<file>` per-file symlink (this machine's pre-migration
 *  arrangement — `~/.claude-work/rules/` symlinking each file individually into
 *  `~/.claude/rules/`) becomes after the flat→wt/ move. Generic: takes the secondary rules
 *  dir as an explicit argument rather than a hard-coded machine path, so the shipped script
 *  carries no account-specific path — only the caller (a human, or a project rule) knows
 *  which second config dir exists here. Silent (returns []) when `secondaryDir` is not given:
 *  the DESIGN DECISION is documented in the adopt SKILL.md regardless of whether this flag is
 *  passed on a given run. */
function planSecondaryDirSymlinks(secondaryDir, flatDir, wtDir, moves, stays) {
  if (!secondaryDir) return []
  const lines = []
  const allFiles = [...moves.map((m) => m.file), ...stays.map((s) => s.file)]
  for (const file of allFiles) {
    const secondaryPath = path.join(secondaryDir, file)
    let lst
    try {
      lst = fs.lstatSync(secondaryPath)
    } catch {
      continue // no symlink for this file at the secondary dir — nothing to report
    }
    if (!lst.isSymbolicLink()) continue
    let linkTarget = ''
    try {
      linkTarget = fs.readlinkSync(secondaryPath)
    } catch {
      /* unreadable link — still report its path */
    }
    const isMoved = moves.some((m) => m.file === file)
    lines.push(
      isMoved
        ? `${secondaryPath} (→ ${linkTarget || '?'}): STALE after migration — its target moved to ` +
          `${path.join(wtDir, file)}. Per-file symlinks do not follow a rename; replace this one ` +
          `(and every sibling) with a SINGLE directory symlink ${secondaryDir}/wt → ${wtDir} instead ` +
          `of re-linking file by file (see the design decision in the adopt SKILL.md).`
        : `${secondaryPath} (→ ${linkTarget || '?'}): unaffected by this migration (its target file ` +
          `is staying at the flat root) — still worth folding into the same directory-symlink ` +
          `cleanup once you decide to migrate hand-authored/edited files too.`,
    )
  }
  return lines
}

/** Resolve a symlink target without following the link itself. The migration is allowed to
 * remove only links whose resolved target is an exact file selected for this run's move. */
function resolvedLinkTarget(linkPath) {
  const target = fs.readlinkSync(linkPath)
  return path.resolve(path.dirname(linkPath), target)
}

/** Reconcile the explicit secondary rules dir after every planned move is confirmed. The
 * directory link is intentionally absolute: it matches the documented machine setup and
 * remains correct if the secondary config directory is reached through another cwd. */
function reconcileSecondaryDir(secondaryDir, wtDir, moves) {
  const movedSources = new Set(moves.map((move) => path.resolve(move.from)))
  const wtLink = path.join(secondaryDir, 'wt')
  let entries
  try {
    entries = fs.readdirSync(secondaryDir, { withFileTypes: true })
  } catch (error) {
    fail(`secondary reconciliation failed: cannot read ${secondaryDir} — ${error instanceof Error ? error.message : String(error)}`)
  }

  let removed = 0
  let left = 0
  for (const entry of entries) {
    const linkPath = path.join(secondaryDir, entry.name)
    let lst
    try {
      lst = fs.lstatSync(linkPath)
    } catch {
      continue
    }
    if (!lst.isSymbolicLink() || linkPath === wtLink) continue
    let target
    try {
      target = resolvedLinkTarget(linkPath)
    } catch {
      // An unreadable or already-dead unrelated link is never ours to remove.
      left++
      continue
    }
    if (movedSources.has(target)) {
      fs.unlinkSync(linkPath)
      removed++
    } else {
      left++
    }
  }

  let directoryState = 'created'
  try {
    const lst = fs.lstatSync(wtLink)
    if (!lst.isSymbolicLink()) {
      fail(`secondary reconciliation failed: ${wtLink} exists and is not a symlink; refusing to replace it`)
    }
    const target = resolvedLinkTarget(wtLink)
    if (target !== path.resolve(wtDir)) {
      fail(`secondary reconciliation failed: ${wtLink} points to ${target}, not ${wtDir}; refusing to replace it`)
    }
    directoryState = 'already correct'
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      try {
        fs.symlinkSync(wtDir, wtLink, 'dir')
      } catch (createError) {
        fail(
          `secondary reconciliation failed: could not create directory symlink ${wtLink} -> ${wtDir} — ` +
            `${createError instanceof Error ? createError.message : String(createError)}`,
        )
      }
    } else {
      throw error
    }
  }

  for (const move of moves) {
    const stalePath = path.join(secondaryDir, move.file)
    try {
      if (fs.lstatSync(stalePath).isSymbolicLink() && resolvedLinkTarget(stalePath) === path.resolve(move.from)) {
        fail(`secondary reconciliation failed: dead link remains at ${stalePath}`)
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') continue
      throw error
    }
  }
  process.stdout.write(
    `secondary reconciliation: ${removed} link(s) removed, directory link ${directoryState}, ${left} link(s) left.\n`,
  )
}

function migrateDryRun(dir, args) {
  const wtDir = dir
  const flatDir = legacyRulesDir(wtDir)
  if (!flatDir) {
    fail(
      `adopt:migrate expects a rules/wt/ target — resolved dir was ${wtDir}, whose basename is not ` +
        `'wt'. Pass --dir <…/rules/wt> or rely on the default (no --dir, no --global).`,
    )
  }
  process.stdout.write(`[migrate --dry-run] flat root=${flatDir}  →  new location=${wtDir}\n`)
  process.stdout.write('adopt:migrate NEVER writes to disk — this is a report, not an executor. ' + 'Nothing below has happened yet.\n\n')

  const set = SETS.rules
  const { moves, stays } = planMigrationItems(flatDir, wtDir, set)

  process.stdout.write(`1. Files that would MOVE (${moves.length}):\n`)
  if (moves.length === 0) process.stdout.write('  (none)\n')
  for (const m of moves) process.stdout.write(`  MOVE ${m.file}: ${m.from} -> ${m.to}\n`)

  process.stdout.write(`\n2. Files that would stay AT THE ROOT (${stays.length}):\n`)
  if (stays.length === 0) process.stdout.write('  (none)\n')
  for (const s of stays) process.stdout.write(`  STAY ${s.file}: ${s.from} — ${s.reason}\n`)

  const before = listMdFilesRecursive(flatDir)
  const afterList = before.map((entry) => {
    const move = moves.find((m) => m.from === entry.file)
    return move ? { file: move.to, bytes: entry.bytes } : entry
  })
  // Project the duplicate this migration would eventually cause: a stay with duplicateRisk
  // means a FUTURE bare --install would additionally write a fresh copy at the wt/ location,
  // so the projected "after" set counts that file twice — the number IS the intuition Frederic
  // asked this report to replace.
  const projectedExtra = stays.filter((s) => s.duplicateRisk).map((s) => {
    let bytes = 0
    try {
      bytes = fs.statSync(s.from).size
    } catch {
      /* best-effort projection only */
    }
    return { file: path.join(wtDir, s.file) + ' (projected — a later --install would write it here)', bytes }
  })
  const afterProjected = [...afterList, ...projectedExtra]

  process.stdout.write(
    `\n3. Set LOADED, before vs after (recursive under ${flatDir}):\n` +
      `  before: ${before.length} file(s), ${sumBytes(before)} byte(s)\n` +
      `  after (projected, incl. what a following --install would add): ${afterProjected.length} file(s), ` +
      `${sumBytes(afterProjected)} byte(s)\n`,
  )

  process.stdout.write('\n4. Second config dir (per-file symlinks):\n')
  if (args.secondaryDir) {
    const symlinkLines = planSecondaryDirSymlinks(args.secondaryDir, flatDir, wtDir, moves, stays)
    if (symlinkLines.length === 0) {
      process.stdout.write(`  no per-file symlink into ${flatDir} found under ${args.secondaryDir}\n`)
    } else {
      for (const line of symlinkLines) process.stdout.write(`  ${line}\n`)
    }
  } else {
    process.stdout.write(
      '  no --secondary-dir passed — nothing scanned. DESIGN DECISION (documented in the adopt ' +
        'SKILL.md, "Reconciling a second config dir"): replace any per-file symlink into the ' +
        'flat rules/ root with ONE directory symlink <secondary>/rules/wt -> <primary>/rules/wt. ' +
        'A per-file link needs re-doing by hand every time a rule is added or removed (a ' +
        'hand-placed mechanism that goes silently stale); a directory symlink covers the whole ' +
        'managed set at once and needs no maintenance as it grows or shrinks. Pass ' +
        '--secondary-dir <path-to-its-rules-dir> to have this report name each existing link and ' +
        'what becomes of it.\n',
    )
  }

  const wouldDuplicate = stays.some((s) => s.duplicateRisk)
  process.stdout.write(
    `\nadopt:migrate --dry-run: ${moves.length} move(s), ${stays.length} stay(s), ` +
      `duplicate-after-migration risk: ${wouldDuplicate ? 'YES' : 'no'}\n`,
  )
  if (wouldDuplicate) {
    process.stdout.write(
      'adopt:migrate: EXITING NON-ZERO — at least one file would be loaded from two locations ' +
        'after migration (see the STAY reasons marked above). Resolve those before running any ' +
        'real migration.\n',
    )
    process.exitCode = 1
  }
}

// --- --migrate --execute ----------------------------------------------------------------
//
// Consumes the SAME plan planMigrationItems() computes for --dry-run — that function is the
// single source of truth for "what would move and what stays, and why". Both modes call it;
// neither recomputes its own answer. That is the whole point of the split: a dry-run and an
// execute that disagree about the plan would mean the dry-run stopped predicting the real
// move, and a dry-run that does not predict is worse than none, because the user reads it
// and trusts it.

/** Move `from` to `to`, verifying byte-identity afterward. `fs.renameSync` is a
 *  directory-entry change on the same filesystem, not a content rewrite, so nothing should
 *  be able to alter the bytes — but the managed files carry a content-fingerprinted banner
 *  (see `classify()`/`fingerprint()`) that the installer uses to detect local edits, and a
 *  byte-changing "move" would silently opt every rule out of future updates. So this
 *  verifies rather than trusts the OS call. Falls back to copy+unlink on EXDEV (crossing a
 *  filesystem boundary, where rename cannot work atomically). Throws on any mismatch or
 *  filesystem error — the caller stops the whole run rather than continue past an unverified
 *  move. */
function moveFileVerified(from, to) {
  const before = fs.readFileSync(from) // Buffer — byte-exact, unlike classify()'s 'utf8' read
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(from, to)
      fs.unlinkSync(from)
    } else {
      throw e
    }
  }
  const after = fs.readFileSync(to)
  if (!before.equals(after)) {
    throw new Error(`byte mismatch after move: ${from} -> ${to} — moved content differs from the original`)
  }
  if (fs.existsSync(from)) {
    throw new Error(`source still present after move: ${from} — the move did not remove the origin`)
  }
}

function migrationPreflight(moves, stays, args) {
  const blockers = stays.filter((s) => s.duplicateRisk)
  if (blockers.length > 0) {
    process.stdout.write(
      `adopt:migrate --execute: REFUSING — the plan is not safe (${blockers.length} blocker(s)). ` +
        'Nothing has been moved.\n',
    )
    for (const b of blockers) process.stdout.write(`  REFUSE ${b.file}: ${b.from} — ${b.reason}\n`)
    process.stdout.write(
      '\nResolve every file named above by hand, then re-run --migrate --dry-run to confirm before ' +
        '--migrate --execute.\n',
    )
    process.exitCode = 1
    return false
  }
  if (moves.length > 0 && !args.secondaryDir && !args.ignoreSecondary) {
    process.stdout.write(
      'adopt:migrate --execute: REFUSING — a second config dir could hold per-file symlinks that this move would break. ' +
        'Pass --secondary-dir <path-to-its-rules-dir> to reconcile it, or --ignore-secondary to proceed with that risk explicitly. Nothing has been moved.\n',
    )
    process.exitCode = 1
    return false
  }
  return true
}

function renderEmptyMigration(wtDir, moves, stays, args) {
  if (moves.length === 0) {
    process.stdout.write(
      `adopt:migrate --execute: nothing to move — the plan is empty. No-op (not an error): either ` +
        `already migrated, or nothing was ever at the flat root.\n  ${stays.length} file(s) left in ` +
        `place by design (hand-authored — never managed).\n  destination: ${wtDir}\n`,
    )
    if (args.secondaryDir) reconcileSecondaryDir(args.secondaryDir, wtDir, moves)
    return true
  }
  return false
}

function executeMigrationMoves(moves) {
  let movedCount = 0
  let firstFailure = null
  for (const m of moves) {
    if (firstFailure) break // stop moving once one move is unverified — do not compound the doubt
    try {
      moveFileVerified(m.from, m.to)
      movedCount++
      process.stdout.write(`  MOVED ${m.file}: ${m.from} -> ${m.to}\n`)
    } catch (e) {
      firstFailure = { file: m.file, message: e instanceof Error ? e.message : String(e) }
      process.stdout.write(`  FAILED ${m.file}: ${firstFailure.message}\n`)
    }
  }
  return { movedCount, firstFailure }
}

function confirmedMigrationCount(moves) {
  return moves.filter((move) => !fs.existsSync(move.from) && realFile(move.to)).length
}

function renderMigrationResult(wtDir, moves, stays, result) {
  const plannedCount = moves.length
  const confirmed = confirmedMigrationCount(moves)
  const notReached = moves.slice(result.movedCount + (result.firstFailure ? 1 : 0))
  process.stdout.write(
    `\nadopt:migrate --execute: ${result.movedCount} of ${plannedCount} planned file(s) moved, ` +
      `${confirmed} of ${plannedCount} confirmed present at destination and absent from origin.\n`,
  )
  if (stays.length > 0) {
    process.stdout.write(`${stays.length} file(s) left in place by design:\n`)
    for (const s of stays) process.stdout.write(`  STAY ${s.file}: ${s.reason}\n`)
  }
  if (notReached.length > 0) {
    process.stdout.write(`${notReached.length} file(s) NOT REACHED (a prior move failed; stopped):\n`)
    for (const n of notReached) process.stdout.write(`  NOT REACHED ${n.file}\n`)
  }
  process.stdout.write(`destination: ${wtDir}\n`)
  if (result.firstFailure || confirmed !== plannedCount) {
    process.stdout.write('adopt:migrate --execute: EXITING NON-ZERO — not every planned move is confirmed.\n')
    process.exitCode = 1
    return false
  }
  return true
}

function executeMigration(dir, args) {
  const wtDir = dir
  const flatDir = legacyRulesDir(wtDir)
  if (!flatDir) {
    fail(
      `adopt:migrate expects a rules/wt/ target — resolved dir was ${wtDir}, whose basename is not ` +
        `'wt'. Pass --dir <…/rules/wt> or rely on the default (no --dir, no --global).`,
    )
  }
  process.stdout.write(`[migrate --execute] flat root=${flatDir}  →  new location=${wtDir}\n`)
  const { moves, stays } = planMigrationItems(flatDir, wtDir, SETS.rules)
  if (!migrationPreflight(moves, stays, args) || renderEmptyMigration(wtDir, moves, stays, args)) return
  const result = executeMigrationMoves(moves)
  if (!renderMigrationResult(wtDir, moves, stays, result)) return
  if (args.secondaryDir) reconcileSecondaryDir(args.secondaryDir, wtDir, moves)
}

function commandTargetDir(args, set, globalRoot) {
  return path.resolve(
    args.dir || (args.global ? path.join(globalRoot, set.globalSubdir) : path.join(process.cwd(), set.defaultDir)),
  )
}

function runMigrationCommand(args) {
  if (args.dryRun && args.execute) fail('adopt:migrate: pass exactly one of --dry-run or --execute, never both in the same run.')
  if (!args.dryRun && !args.execute) {
    fail(
      'adopt:migrate needs --dry-run (read-only preview) or --execute (perform the real move) — ' +
        'bare --migrate does nothing. Run --migrate --dry-run first and read its real output before ' +
        'ever passing --migrate --execute (card 1835727457, item 2): the real move is a deliberate, ' +
        'separate step this script does not take on its own.',
    )
  }
  if (args.set !== 'rules') fail(`adopt:migrate only applies to the rules set (got --set ${args.set})`)
  const dir = commandTargetDir(args, SETS.rules, resolvedConfigRoot())
  if (args.execute) executeMigration(dir, args)
  else migrateDryRun(dir, args)
}

function runAuditCommand(args) {
  if (!args.userDir) fail('--user-dir is required with --audit-overlap')
  if (!['rules', 'agents'].includes(args.set)) {
    fail(`unknown --set '${args.set}' for --audit-overlap (expected rules | agents)`)
  }
  auditOverlap(path.resolve(args.userDir), pluginRoot(), args.pairsFile, args.declarationsFile, args.set)
}

function standardCommandContext(args) {
  if (args.set === RETIRED_DOCS_SET) {
    fail(`the '${RETIRED_DOCS_SET}' set is retired: the shipped rules no longer point at rationale files, so nothing is installed. A docs/wt/ copy installed earlier is left untouched and may be deleted.`)
  }
  if (![...MANAGED_SET_NAMES, 'all'].includes(args.set)) {
    fail(`unknown --set '${args.set}' (expected ${MANAGED_SET_NAMES.join(' | ')} | all)`)
  }
  const root = pluginRoot()
  const version = currentVersion(root)
  const chosen = args.set === 'all' ? MANAGED_SET_NAMES : [args.set]
  if (args.dir && chosen.length > 1) {
    fail(`--dir requires a single --set (use one of: ${MANAGED_SET_NAMES.map((name) => `--set ${name}`).join(', ')}; with --set all each set uses its own default dir)`)
  }
  // Refuse rather than let one silently win: the two flags express DIFFERENT intents (an
  // explicit path vs "wherever this machine's config dir is"), and a caller who passed both
  // holds a belief about the target that one of them contradicts. Answering confidently
  // about a directory the caller did not mean is the failure this whole flag exists to end.
  if (args.dir && args.global) {
    fail('--global and --dir are mutually exclusive (--global resolves the config dir itself)')
  }
  // The SAME resolution the SessionStart hook uses — CLAUDE_CONFIG_DIR, else ~/.claude.
  // Deliberately one rule in two places rather than an import: these are a shipped hook and
  // a standalone script that must each run alone. They are locked in step by tests, not by
  // a shared module they cannot both reach.
  return { root, version, chosen, globalRoot: resolvedConfigRoot() }
}

function runDiffCommand(args, context) {
  if (context.chosen.length !== 1) fail('--diff requires a single --set')
  const set = SETS[context.chosen[0]]
  printThreeWayDiff(set, commandTargetDir(args, set, context.globalRoot), args.diffFile, context.version, context.root)
}

function renderCheckHints(args, state) {
  if (args.mode !== 'check') return
  if (state.anyAbsent) process.stdout.write('adopt: run with --install to write the ABSENT item(s).\n')
  else if (state.anyStale) process.stdout.write('adopt: run with --install to refresh the STALE item(s).\n')
  else if (state.anyEdited) process.stdout.write('adopt: locally-edited item(s) present — --install leaves them; --force overwrites.\n')
  else if (state.anySettingsProblem) process.stdout.write('adopt: account-level settings need manual attention before this tool can manage them safely.\n')
  else process.stdout.write('adopt: nothing to do.\n')
  if (state.anyMigrationPending) {
    process.stdout.write(
      'adopt: item(s) found only at the pre-migration rules/ location — run the adopt:migrate ' +
        'skill\'s --dry-run before --install here (a bare --install would write a fresh copy at ' +
        'the new location and leave the old one in place, loading it twice).\n',
    )
  }
  if (state.anySymlink && !args.replaceSymlinks) {
    process.stdout.write(
      'adopt: symlinked target(s) present — left untouched; pass --replace-symlinks to replace them with managed copies.\n',
    )
    process.stdout.write(
      '  ↳ A symlinked item is NOT checked for staleness here — its managed copy lives at the\n' +
        '    link target. Re-run --check/--install with --dir pointing at the target directory to\n' +
        '    refresh it; this directory then follows automatically through the links.\n',
    )
  }
}

function mergeSetState(state, result) {
  for (const key of ['anyAbsent', 'anyStale', 'anyEdited', 'anySymlink', 'anyMigrationPending', 'anyDuplicate']) {
    state[key] = state[key] || result[key]
  }
}

function managedSetGroups(set, fallbackDir, resolution, root) {
  if (!resolution) return new Map([[fallbackDir, null]])
  const defaultDir = resolution.defaultDir || fallbackDir
  const groups = new Map()
  for (const item of set.resolveItems(root)) {
    const dir = resolution.itemDirs.get(item.file) || defaultDir
    const files = groups.get(dir) ?? new Set()
    files.add(item.file)
    groups.set(dir, files)
  }
  return groups
}

function runManagedCommand(args, context) {
  const { root, version, chosen, globalRoot } = context
  const implicitInstallDirs = resolveImplicitInstallDirs(chosen, args, root)

  preflightAdoptedLauncherRuntime(chosen, root)

  process.stdout.write(
    `adopt: ${BANNER_TOOL} v${version} · mode=${args.mode}${args.force ? ' --force' : ''} · set=${args.set}\n`,
  )

  const state = {
    anyAbsent: false,
    anyStale: false,
    anyEdited: false,
    anySymlink: false,
    anySettingsProblem: false,
    anyMigrationPending: false,
    anyDuplicate: false,
  }
  for (const name of chosen) {
    const set = SETS[name]
    // `set.defaultDir` is project-relative ('.claude/rules/wt' | '.claude/agents'); under
    // --global the config dir IS the '.claude' layer already, so `globalSubdir` (its own
    // field, NOT derived from defaultDir's basename — see the SETS comment above) is
    // appended instead.
    const fallbackDir = path.resolve(
      args.dir || (args.global ? path.join(globalRoot, set.globalSubdir) : path.join(process.cwd(), set.defaultDir)),
    )
    for (const [dir, files] of managedSetGroups(set, fallbackDir, implicitInstallDirs.get(name), root)) {
      refuseExplicitRootInstall(set, dir, args, root)
      mergeSetState(state, processSet(set, dir, args, version, root, files))
    }
  }

  if (state.anyDuplicate) process.exitCode = 1

  const settingsResult = processSettings(globalRoot, chosen, args, version)
  state.anyAbsent = state.anyAbsent || settingsResult.anyAbsent
  state.anySettingsProblem = state.anySettingsProblem || settingsResult.anyProblem

  const untouchedLine = chosen.length === 1 ? untouchedSetLine(chosen[0], MANAGED_SET_NAMES) : null
  if (untouchedLine) process.stdout.write(untouchedLine)

  if (chosen.includes('agents')) printRegisteredAgentsNote(root, path.join(globalRoot, 'agents'))
  renderCheckHints(args, state)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  checkFlagModeAsymmetry(args)
  if (args.mode === 'migrate') return runMigrationCommand(args)
  if (args.mode === 'audit-overlap') return runAuditCommand(args)
  const context = standardCommandContext(args)
  if (args.mode === 'diff') return runDiffCommand(args, context)
  runManagedCommand(args, context)
}

try {
  main()
} catch (err) {
  fail(err && err.message ? err.message : String(err))
}
