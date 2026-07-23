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
//              A project copy of pilot.md + pilot-watchdog.md (+ pilot-orchestrator.md)
//              is what lets the watchdog `observer:` pairing attach (plugin-installed
//              agents do not honor it), and the fingerprint is what makes a stale copy
//              DETECTABLE after a plugin bump — the hazard a raw manual copy has no
//              defence against.
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
//
// Default --set is `rules` (backward-compatible with the original rules-only tool).
// Each set targets its own default dir under <cwd>; `--dir` overrides the target and
// therefore requires a SINGLE --set (with `--set all` each set keeps its own default).
//
// SYMLINK SAFETY: if a target file is a symlink (e.g. a config dir whose rules are
// symlinked from another one), the engine NEVER writes through it — it reports the
// symlink and leaves it (and its target) untouched. `--replace-symlinks` opts in to
// unlinking the symlink and writing a regular managed file in its place (the former
// target is preserved). This is never silent: a plain --install SKIPS a symlink.

import fs from 'node:fs'
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
const MANAGED_AGENTS = [{ file: 'pilot.md' }, { file: 'pilot-watchdog.md' }, { file: 'pilot-orchestrator.md' }]

/** The two managed sets. `kind` drives banner placement; `srcDir` is the plugin bundle
 *  dir each set reads its files from; `resolveItems(root)` lists the managed files (the
 *  rules set discovers them from the bundle; the agents set is a fixed suite). */
const SETS = {
  rules: { kind: 'rules', srcDir: 'rules', defaultDir: '.claude/rules', resolveItems: discoverRuleItems },
  agents: { kind: 'agents', srcDir: 'agents', defaultDir: '.claude/agents', resolveItems: () => MANAGED_AGENTS },
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
  return { state: clean ? 'clean' : 'edited', installedVer }
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
  const args = { mode: 'check', dir: null, force: false, set: 'rules', replaceSymlinks: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--install') args.mode = 'install'
    else if (argv[i] === '--check') args.mode = 'check'
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--replace-symlinks') args.replaceSymlinks = true
    else if (argv[i] === '--dir') args.dir = argv[++i]
    else if (argv[i] === '--set') args.set = argv[++i]
  }
  return args
}

/** Decide the status label and (for --install) whether to write. `force` only ever
 *  overrides a MANAGED file (edited / edited-unknown / clean); a hand-authored file
 *  with no toolbox banner is NEVER overwritten — we won't clobber a file we never
 *  stamped. A symlink is never written THROUGH: it writes only under `replaceSymlinks`
 *  (and then processSet unlinks the link first, preserving its target). */
function plan(c, version, force, replaceSymlinks) {
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
      if (c2 > 0) return { status: `AHEAD (installed v${c.installedVer} > v${version})`, write: force }
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
    const p = plan(c, version, args.force, args.replaceSymlinks)
    if (c.state === 'absent') anyAbsent = true
    if (c.state === 'clean' && cmp(c.installedVer, version) < 0) anyStale = true
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
  if (!['rules', 'agents', 'all'].includes(args.set)) {
    fail(`unknown --set '${args.set}' (expected rules | agents | all)`)
  }
  const root = pluginRoot()
  const version = currentVersion(root)
  const chosen = args.set === 'all' ? ['rules', 'agents'] : [args.set]
  if (args.dir && chosen.length > 1) {
    fail('--dir requires a single --set (use --set rules or --set agents; with --set all each set uses its own default dir)')
  }

  process.stdout.write(
    `adopt-rules: ${BANNER_TOOL} v${version} · mode=${args.mode}${args.force ? ' --force' : ''} · set=${args.set}\n`,
  )

  let anyAbsent = false
  let anyStale = false
  let anyEdited = false
  let anySymlink = false
  for (const name of chosen) {
    const set = SETS[name]
    const dir = path.resolve(args.dir || path.join(process.cwd(), set.defaultDir))
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
    if (anySymlink && !args.replaceSymlinks)
      process.stdout.write(
        'adopt-rules: symlinked target(s) present — left untouched; pass --replace-symlinks to replace them with managed copies.\n',
      )
  }
}

try {
  main()
} catch (err) {
  fail(err && err.message ? err.message : String(err))
}
