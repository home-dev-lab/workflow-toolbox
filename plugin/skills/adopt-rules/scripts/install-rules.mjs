#!/usr/bin/env node
// install-rules.mjs — the deterministic engine behind the adopt-rules skill.
//
// Writes EDITABLE copies of workflow-toolbox's managed guardrails into the user's
// config, each stamped with a versioned banner AND a content fingerprint so a later
// run can tell (a) whether the copy is behind the plugin and (b) whether the USER has
// edited it. Two managed SETS share one engine:
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
//
// It is safe BY CONSTRUCTION: `--install` never overwrites a locally-edited (or
// hand-authored) file — that needs an explicit `--force`. `--check` is always
// read-only. The skill (and any first-run suggestion) may only SUGGEST adoption —
// never write silently.
//
// Usage (the skill orchestrates these; a human can run them directly too):
//   node install-rules.mjs [--set rules|agents|all] --check   [--dir <dir>]   # report, write nothing
//   node install-rules.mjs [--set rules|agents|all] --install [--dir <dir>]   # write absent + refresh UNEDITED
//   node install-rules.mjs [--set rules|agents|all] --install --force [--dir <dir>]  # also overwrite edited copies
//   node install-rules.mjs [--set …] --install --replace-symlinks [--dir <dir>]      # replace a SYMLINKED target with a managed copy in place
//   node install-rules.mjs [--set …] --check|--install --global                      # target the CONFIG dir instead of the project
//
// Default --set is `rules` (backward-compatible with the original rules-only tool).
// Each set targets its own default dir under <cwd>; `--dir` overrides the target and
// therefore requires a SINGLE --set (with `--set all` each set keeps its own default).
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
// unlinking the symlink and writing a regular managed file in its place (the former
// target is preserved). This is never silent: a plain --install SKIPS a symlink.

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

/** The two managed sets. `kind` drives banner placement; `srcDir` is the plugin bundle
 *  dir each set reads its files from; `resolveItems(root)` lists the managed files (the
 *  rules set discovers them from the bundle; the agents set is a fixed suite). */
const SETS = {
  rules: { kind: 'rules', srcDir: 'rules', defaultDir: '.claude/rules', resolveItems: discoverRuleItems },
  // srcDir is `agent-templates/`, NOT `agents/`: a plugin's agents/ dir is what REGISTERS an
  // agent type, and a registered pilot is a broken pilot — Claude Code ignores `observer:` on
  // plugin-installed agents, so `workflow-toolbox:pilot` spawns and runs with no watchdog and
  // no warning. Keeping the pilot defs outside agents/ means that unwatched path does not
  // exist to be taken; they reach a session only as project copies under their bare names,
  // which is the only form where the pairing attaches. The other shipped agents (leaf, lean,
  // …) stay in agents/ — they declare no observer, so registration serves them correctly.
  agents: { kind: 'agents', srcDir: 'agent-templates', defaultDir: '.claude/agents', resolveItems: () => MANAGED_AGENTS },
}

// Match only against the banner line, never the body — a body mention of the phrase
// must not be read as a banner.
const VERSION_RE = new RegExp(`installed from ${BANNER_TOOL} v(\\d+)\\.(\\d+)\\.(\\d+)`)
const FP_RE = /content sha256:([0-9a-f]{12})/
// The leading YAML frontmatter block of an agent def, incl. its trailing newline.
const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/

function fail(msg) {
  process.stdout.write(`adopt-rules: ${msg}\n`)
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

function banner(version, fp) {
  return (
    `<!-- installed from ${BANNER_TOOL} v${version} · content sha256:${fp} by the adopt-rules ` +
    `skill — editable copy. Re-run the ${BANNER_TOOL}:adopt-rules skill to check for updates; ` +
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
  return fs.readFileSync(src, 'utf8')
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
function shippedFingerprint(set, item, root) {
  try {
    return fingerprint(fs.readFileSync(path.join(root, set.srcDir, item.file), 'utf8'))
  } catch {
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

/** Recover the pre-banner content of an installed RULE (banner is line 1). */
function stripRuleBanner(text) {
  const nl = text.indexOf('\n')
  if (nl === -1) return ''
  return text.slice(nl + 1).replace(/^\n+/, '')
}

/** The full installed file: content + a banner stamped with content's fingerprint. */
function renderItem(set, item, version, root) {
  const content = itemContent(set, item, root)
  const b = banner(version, fingerprint(content))
  return set.kind === 'rules' ? `${b}\n\n${content}` : insertAgentBanner(content, b)
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
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function stripBannerFor(set, text) {
  return set.kind === 'agents' ? stripAgentBanner(text) : stripRuleBanner(text)
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
  if (!fpm) return { state: 'edited-unknown', installedVer }
  const clean = fingerprint(stripBannerFor(set, content)) === fpm[1]
  // installedFp = the fingerprint of the content this copy actually holds. Returned so the
  // planner can ask "is this the same text that ships today?" — the question the version
  // number cannot answer, and the one that decides whether STALE means anything.
  return { state: clean ? 'clean' : 'edited', installedVer, installedFp: fpm[1] }
}

function cmp(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

function parseArgs(argv) {
  const args = { mode: 'check', dir: null, global: false, force: false, set: 'rules', replaceSymlinks: false, userDir: null, pairsFile: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--install') args.mode = 'install'
    else if (argv[i] === '--check') args.mode = 'check'
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--replace-symlinks') args.replaceSymlinks = true
    else if (argv[i] === '--global') args.global = true
    else if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i] === '--set') args.set = argv[++i]
    else if (argv[i] === '--audit-overlap') args.mode = 'audit-overlap'
    else if (argv[i] === '--user-dir') args.userDir = argv[++i]
    else if (argv[i] === '--pairs-file') args.pairsFile = argv[++i]
  }
  return args
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

function auditOverlap(userDir, root, pairsFile, set = 'rules') {
  const setConfig = SETS[set]
  if (!setConfig) fail(`unknown audit-overlap set '${set}' (expected rules | agents)`)
  let entries
  try {
    entries = fs.readdirSync(userDir)
  } catch {
    fail(`user directory does not exist: ${userDir}`)
  }
  const defaultPairsFile = set === 'agents' ? 'agent-pairs.json' : 'rule-pairs.json'
  const pairsPath = path.resolve(pairsFile || path.join(path.dirname(fileURLToPath(import.meta.url)), defaultPairsFile))
  const pairs = JSON.parse(fs.readFileSync(pairsPath, 'utf8'))
  const shippedDir = path.join(root, setConfig.srcDir)
  const stripBanner = set === 'agents' ? stripAgentBanner : stripRuleBanner
  const declaredUsers = new Set(pairs.map((pair) => pair.user))
  // The shipped-side basename of a declared pair is never itself a candidate for UNMAPPED:
  // it is either explained by DUPLICATE (both present), ABSENT (only the user side missing —
  // the shipped-only file just isn't examined by that branch), or the correct target end
  // state (user side removed, shipped copy installed) — never "no known counterpart".
  const declaredShipped = new Set(pairs.map((pair) => pair.shipped))
  let duplicate = 0
  let drift = 0
  let absent = 0
  let unpaired = 0
  let unmapped = 0

  for (const item of setConfig.resolveItems(root)) {
    if (!declaredShipped.has(item.file)) {
      unpaired++
      process.stdout.write(
        `UNPAIRED ${item.file}: no pairing entry in ${pairsPath} — this shipped ${set === 'agents' ? 'agent' : 'rule'} is untracked by audit-overlap\n`,
      )
    }
  }

  for (const pair of pairs) {
    const userPath = path.join(userDir, pair.user)
    const shippedPath = path.join(shippedDir, pair.shipped)
    const userExists = realFile(userPath)
    const shippedInUserPath = path.join(userDir, pair.shipped)
    const shippedAdoptedDirectly = pair.shipped !== pair.user && realFile(shippedInUserPath)
    if (!userExists) {
      if (shippedAdoptedDirectly) {
        process.stdout.write(`CLEAN ${pair.user}: adopted under shipped name (${pair.shipped})\n`)
        continue
      }
      if (set === 'agents') absent++
      process.stdout.write(`ABSENT ${pair.user}: ABSENT (declared pair, no user file present)\n`)
      continue
    }
    if (shippedAdoptedDirectly) {
      // A `partial` pair (e.g. delegation-lanes.md / wt-delegation-ladder.md) is a DELIBERATE,
      // accepted, bounded coexistence — both files are MEANT to be present together. Flagging
      // it as a hard DUPLICATE would fail the guard on the documented target state itself.
      const partial = pair.partial === true
      if (!partial) duplicate++
      const label = partial ? 'DUPLICATE (partial, informational)' : 'DUPLICATE'
      process.stdout.write(`${label} ${userPath} + ${shippedInUserPath}\n`)
      continue
    }
    if (!realFile(shippedPath)) {
      process.stdout.write(`CLEAN ${pair.user}: no shipped comparison file\n`)
      continue
    }
    const allowExtraPatterns = Array.isArray(pair.allowExtraPatterns)
      ? pair.allowExtraPatterns.map((pattern) => new RegExp(pattern))
      : []
    // A correctly-adopted user copy carries the SAME banner line the shipped side never has
    // (stamped by --install) — comparing it unstripped against the stripped shipped content
    // would report the banner itself as permanent, undiscriminating drift (an adopted copy
    // could never go CLEAN). Strip it ONLY when the user file's own first-post-frontmatter
    // line actually IS a recognized banner (VERSION_RE) — a hand-authored file with no banner
    // must NOT have its real first line eaten.
    const userContent = fs.readFileSync(userPath, 'utf8')
    const userHasBanner = VERSION_RE.test(bannerLine(setConfig, userContent))
    const userLines = normalizedLines(userHasBanner ? stripBanner(userContent) : userContent)
    const shippedLines = new Set(normalizedLines(stripBanner(fs.readFileSync(shippedPath, 'utf8'))))
    const extras = [...new Set(userLines.filter((line) => line !== '' && !shippedLines.has(line)))].filter(
      (line) => !allowExtraPatterns.some((pattern) => pattern.test(line)),
    )
    // ADDITIONS-only was a real gap for the `agents` set (review finding, card
    // #1827047859321570464): a project copy that DELETES a shipped line (e.g. a safety
    // clause) adds no new line, so `extras` alone stays empty and the pair reports CLEAN —
    // exactly the class of silent drift this gate exists to catch, since our own design
    // decision is that an adopted agent copy = shipped body + ONE approved override line,
    // nothing else may differ in either direction.
    // Scoped to `agents` ONLY: `rules` copies are explicitly documented, in their own
    // banner, as an "editable copy" users may freely trim/adapt — a blanket deletion check
    // would fail every legitimately-edited rule and recreate the always-red trap this same
    // pass just removed in the other direction. Rules-set behavior is therefore UNCHANGED
    // (additions-only, as before).
    const userLineSet = new Set(userLines)
    const missing =
      set === 'agents'
        ? [...new Set([...shippedLines].filter((line) => line !== '' && !userLineSet.has(line)))]
        : []
    if (extras.length === 0 && missing.length === 0) {
      process.stdout.write(`CLEAN ${pair.user}\n`)
    } else {
      const partial = pair.partial === true
      if (!partial) drift++
      const label = partial ? 'DRIFT (partial, informational)' : 'DRIFT'
      process.stdout.write(`${label} ${pair.user}\n`)
      for (const line of extras.slice(0, 40)) process.stdout.write(`${label} ${pair.user}: ${line}\n`)
      if (extras.length > 40) process.stdout.write(`${label} ${pair.user}: +${extras.length - 40} more\n`)
      for (const line of missing.slice(0, 40)) process.stdout.write(`${label} ${pair.user} (missing): ${line}\n`)
      if (missing.length > 40) process.stdout.write(`${label} ${pair.user} (missing): +${missing.length - 40} more\n`)
    }
  }
  for (const file of entries.filter((f) => f.endsWith('.md')).sort()) {
    if (!declaredUsers.has(file) && !declaredShipped.has(file) && realFile(path.join(userDir, file))) {
      unmapped++
      process.stdout.write(`UNMAPPED ${path.join(userDir, file)}\n`)
    }
  }
  if (set === 'agents') {
    process.stdout.write(
      `audit-overlap: ${duplicate} duplicate, ${drift} drift, ${absent} absent, ${unpaired} unpaired, ${unmapped} unmapped\n`,
    )
  } else {
    process.stdout.write(`audit-overlap: ${duplicate} duplicate, ${drift} drift, ${unpaired} unpaired, ${unmapped} unmapped\n`)
  }
  if (duplicate || drift || unpaired || unmapped || (set === 'agents' && absent)) process.exitCode = 1
}

/** Decide the status label and (for --install) whether to write. `force` only ever
 *  overrides a MANAGED file (edited / edited-unknown / clean); a hand-authored file
 *  with no toolbox banner is NEVER overwritten — we won't clobber a file we never
 *  stamped. A symlink is never written THROUGH: it writes only under `replaceSymlinks`
 *  (and then processSet unlinks the link first, preserving its target). */
function plan(c, version, force, replaceSymlinks, shippedFp) {
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
      // AHEAD is decided FIRST and never short-circuited by matching content: a copy claiming
      // a version this plugin does not have means something is wrong with the INSTALL, not
      // with the text, and identical content does not make that anomaly go away. (Skipping
      // this ordering is exactly how an earlier attempt silently swallowed the AHEAD signal.)
      if (c2 > 0) return { status: `AHEAD (installed v${c.installedVer} > v${version})`, write: force }
      // Otherwise CONTENT decides, not the version number. Most releases touch a few files;
      // comparing versions alone marks every adopted copy stale on every release, identical
      // ones included — and a warning that cries wolf on each release is not read on the one
      // release that matters. The banner then honestly records the version at which THIS
      // exact text was installed.
      if (shippedFp && c.installedFp === shippedFp) {
        return {
          status:
            c2 === 0
              ? `UP-TO-DATE (v${c.installedVer})`
              : `UP-TO-DATE (banner v${c.installedVer}; content identical to v${version})`,
          write: force,
        }
      }
      if (c2 < 0) return { status: `STALE (installed v${c.installedVer} < v${version})`, write: true }
      return { status: `UP-TO-DATE (v${c.installedVer})`, write: force }
    }
    default:
      return { status: `UNKNOWN (${c.state})`, write: false }
  }
}

/** Process one set into `dir`. Returns the aggregate flags for the check-mode hint. */
function processSet(set, dir, args, version, root) {
  if (args.mode === 'install') fs.mkdirSync(dir, { recursive: true })
  process.stdout.write(`[${set.kind}] target=${dir}\n`)

  let anyAbsent = false
  let anyStale = false
  let anyEdited = false
  let anySymlink = false
  for (const item of set.resolveItems(root)) {
    const target = path.join(dir, item.file)
    const c = classify(target, set)
    const shippedFp = shippedFingerprint(set, item, root)
    const p = plan(c, version, args.force, args.replaceSymlinks, shippedFp)
    if (c.state === 'absent') anyAbsent = true
    // Mirrors plan()'s own condition exactly, so the per-file lines and the closing hint can
    // never disagree — a summary that says "refresh the STALE item(s)" above a list with no
    // STALE line sends the reader looking for something that isn't there.
    if (
      c.state === 'clean' &&
      cmp(c.installedVer, version) < 0 &&
      !(shippedFp && c.installedFp === shippedFp)
    )
      anyStale = true
    if (c.state === 'edited' || c.state === 'edited-unknown') anyEdited = true
    if (c.state === 'symlink') anySymlink = true

    if (args.mode === 'install') {
      if (p.write) {
        // A symlink is REPLACED, never written THROUGH: unlink the link first (its real
        // target is left untouched), then write a regular managed file in its place.
        if (c.state === 'symlink') fs.rmSync(target, { force: true })
        fs.writeFileSync(target, renderItem(set, item, version, root))
        const verb =
          c.state === 'absent'
            ? 'WROTE'
            : c.state === 'symlink'
              ? 'REPLACED symlink with'
              : args.force && c.state !== 'clean'
                ? 'OVERWROTE (--force)'
                : 'REFRESHED'
        process.stdout.write(`  ${item.file}: ${verb} v${version} → ${target}\n`)
      } else {
        process.stdout.write(`  ${item.file}: SKIPPED — ${p.status}\n`)
      }
    } else {
      process.stdout.write(`  ${item.file}: ${p.status}\n`)
    }
  }
  return { anyAbsent, anyStale, anyEdited, anySymlink }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'audit-overlap') {
    if (!args.userDir) fail('--user-dir is required with --audit-overlap')
    if (!['rules', 'agents'].includes(args.set)) {
      fail(`unknown --set '${args.set}' for --audit-overlap (expected rules | agents)`)
    }
    const root = pluginRoot()
    auditOverlap(path.resolve(args.userDir), root, args.pairsFile, args.set)
    return
  }
  if (!['rules', 'agents', 'all'].includes(args.set)) {
    fail(`unknown --set '${args.set}' (expected rules | agents | all)`)
  }
  const root = pluginRoot()
  const version = currentVersion(root)
  const chosen = args.set === 'all' ? ['rules', 'agents'] : [args.set]
  if (args.dir && chosen.length > 1) {
    fail('--dir requires a single --set (use --set rules or --set agents; with --set all each set uses its own default dir)')
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
  const globalRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

  process.stdout.write(
    `adopt-rules: ${BANNER_TOOL} v${version} · mode=${args.mode}${args.force ? ' --force' : ''} · set=${args.set}\n`,
  )

  let anyAbsent = false
  let anyStale = false
  let anyEdited = false
  let anySymlink = false
  for (const name of chosen) {
    const set = SETS[name]
    // `set.defaultDir` is '.claude/rules' | '.claude/agents'; under --global the config dir
    // IS the '.claude' layer already, so only its LAST segment is appended.
    const dir = path.resolve(
      args.dir ||
        (args.global
          ? path.join(globalRoot, path.basename(set.defaultDir))
          : path.join(process.cwd(), set.defaultDir)),
    )
    const r = processSet(set, dir, args, version, root)
    anyAbsent = anyAbsent || r.anyAbsent
    anyStale = anyStale || r.anyStale
    anyEdited = anyEdited || r.anyEdited
    anySymlink = anySymlink || r.anySymlink
  }

  if (args.mode === 'check') {
    if (anyAbsent) process.stdout.write('adopt-rules: run with --install to write the ABSENT item(s).\n')
    else if (anyStale) process.stdout.write('adopt-rules: run with --install to refresh the STALE item(s).\n')
    else if (anyEdited) process.stdout.write('adopt-rules: locally-edited item(s) present — --install leaves them; --force overwrites.\n')
    else process.stdout.write('adopt-rules: nothing to do.\n')
    // Symlinks are an independent advisory (they can coexist with absent/stale items).
    // Suppressed when --replace-symlinks is already set — no point telling the user to
    // pass a flag they passed (the per-item line then previews the replacement).
    if (anySymlink && !args.replaceSymlinks) {
      process.stdout.write(
        'adopt-rules: symlinked target(s) present — left untouched; pass --replace-symlinks to replace them with managed copies.\n',
      )
      // The operative half. Without it, a "nothing to do." on a fully-symlinked dir reads as
      // "this dir is up to date", and a later --install here would silently refresh NOTHING —
      // every item is skipped as a symlink. The managed copies live at the link TARGETS, so
      // that is where a version bump must be applied; the links then serve it to this dir for
      // free. Two config dirs sharing one rule set is a deliberate, supported setup.
      process.stdout.write(
        '  ↳ A symlinked item is NOT checked for staleness here — its managed copy lives at the\n' +
        '    link target. Re-run --check/--install with --dir pointing at the target directory to\n' +
        '    refresh it; this directory then follows automatically through the links.\n',
      )
    }
  }
}

try {
  main()
} catch (err) {
  fail(err && err.message ? err.message : String(err))
}
