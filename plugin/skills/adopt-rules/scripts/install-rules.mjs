#!/usr/bin/env node
// install-rules.mjs — the deterministic engine behind the adopt-rules skill.
//
// Writes EDITABLE copies of workflow-toolbox's cross-cutting guardrails into the
// user's config as rule files, each stamped with a versioned banner AND a content
// fingerprint so a later run can tell (a) whether the copy is behind the plugin and
// (b) whether the USER has edited it. It is safe BY CONSTRUCTION: `--install` never
// overwrites a locally-edited (or hand-authored) file — that needs an explicit
// `--force`. `--check` is always read-only. The skill (and any first-run suggestion)
// may only SUGGEST adoption — never write silently.
//
// Usage (the skill orchestrates these; a human can run them directly too):
//   node install-rules.mjs --check           [--dir <rulesDir>]   # report status, write nothing
//   node install-rules.mjs --install         [--dir <rulesDir>]   # write absent + refresh UNEDITED
//   node install-rules.mjs --install --force [--dir <rulesDir>]   # also overwrite locally-edited copies
//
// Default target dir: <cwd>/.claude/rules (project-scoped, least invasive). Pass
// --dir ~/.claude/rules (or $CLAUDE_CONFIG_DIR/rules) for a global install.

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

/** The guardrails this skill installs. Each is an editable rule file. Keep this the
 *  SINGLE source of the shipped rule text; the SessionStart hook injects the same
 *  PRINCIPLE ephemerally, but this is the persistent, user-editable copy. */
const MANAGED_RULES = [
  {
    file: 'wt-delegation-ladder.md',
    title: 'Delegation ladder (workflow-toolbox)',
    body: [
      'Route each task to the LOWEST rung that fits, and PIN model + effort at EVERY',
      'spawn — never let a delegate inherit the session model silently. Heavy mechanical',
      'work goes DOWN to a cheaper executor; judgment stays UP with you as the arbiter.',
      '',
      '- A question / analysis / arbitration → answer inline, no delegation.',
      '- One isolated mechanical chore → one throwaway sub-agent (cheap model).',
      '- One tracked card, full dev loop → a `workflow-toolbox:pilot`.',
      '- Several cards / a wave → a `workflow-toolbox:pilot-orchestrator` → pilots.',
      '- A heavy implementation increment of one card → the card’s executor lane.',
      '- Decorrelated verification of a checkable claim → a genuinely different model family.',
      '',
      'Compose a pilot/orchestrator spawn (environment brief + model elevation) via the',
      '`workflow-toolbox:pilot-wave` skill. The duties that stay non-delegable with your',
      'main session: owning wake-ups (a delegate’s background wait does not reliably',
      're-wake it — an inbound message does), user-gates (publish / deploy / destructive /',
      'business preference), memory writes, and the Workflow tool.',
      '',
      'This is a cost-model-neutral PRINCIPLE: which concrete model each rung maps to is',
      'your account’s business — pin it at spawn. Edit this file freely; it is yours.',
    ].join('\n'),
  },
]

// Match only against the banner (the file's first line), never the body — a body
// mention of the phrase must not be read as a banner.
const VERSION_RE = new RegExp(`installed from ${BANNER_TOOL} v(\\d+)\\.(\\d+)\\.(\\d+)`)
const FP_RE = /content sha256:([0-9a-f]{12})/

function fail(msg) {
  process.stdout.write(`adopt-rules: ${msg}\n`)
  process.exit(1)
}

/** Walk up from this script to the plugin manifest and read its version. */
function currentVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json')
    if (fs.existsSync(manifest)) {
      const v = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
      if (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) return v
      fail(`plugin.json version is missing or malformed at ${manifest}`)
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  fail('could not locate the plugin manifest (.claude-plugin/plugin.json) above this script')
}

/** The rule content BELOW the banner (title + body). The fingerprint is taken over
 *  exactly this, so an unedited installed file reproduces its stamped fingerprint. */
function renderedBody(rule) {
  return `# ${rule.title}\n\n${rule.body}\n`
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

function renderRule(rule, version) {
  const body = renderedBody(rule)
  return `${banner(version, fingerprint(body))}\n\n${body}`
}

/** Everything after the banner (first line), with the leading blank line removed —
 *  reproduces `renderedBody` for an unedited file. */
function stripBanner(text) {
  const nl = text.indexOf('\n')
  if (nl === -1) return ''
  return text.slice(nl + 1).replace(/^\n+/, '')
}

/** Classify an installed file against the plugin: absent | hand-authored (no toolbox
 *  banner) | edited-unknown (managed, pre-fingerprint banner — cannot verify) |
 *  edited (managed, locally modified) | clean (managed, matches its fingerprint). */
function classify(target, rule) {
  if (!fs.existsSync(target)) return { state: 'absent' }
  const content = fs.readFileSync(target, 'utf8')
  const nl = content.indexOf('\n')
  const firstLine = nl === -1 ? content : content.slice(0, nl)
  const vm = VERSION_RE.exec(firstLine)
  if (!vm) return { state: 'hand-authored' }
  const installedVer = `${vm[1]}.${vm[2]}.${vm[3]}`
  const fpm = FP_RE.exec(firstLine)
  if (!fpm) return { state: 'edited-unknown', installedVer }
  const clean = fingerprint(stripBanner(content)) === fpm[1]
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
  const args = { mode: 'check', dir: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--install') args.mode = 'install'
    else if (argv[i] === '--check') args.mode = 'check'
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--dir') args.dir = argv[++i]
  }
  return args
}

/** Decide the status label and (for --install) whether to write. `force` only ever
 *  overrides a MANAGED file (edited / edited-unknown / clean); a hand-authored file
 *  with no toolbox banner is NEVER overwritten — we won't clobber a file we never
 *  stamped. */
function plan(c, version, force) {
  switch (c.state) {
    case 'absent':
      return { status: 'ABSENT', write: true }
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = currentVersion()
  const rulesDir = path.resolve(args.dir || path.join(process.cwd(), '.claude', 'rules'))

  process.stdout.write(
    `adopt-rules: ${BANNER_TOOL} v${version} · mode=${args.mode}` +
      `${args.force ? ' --force' : ''} · target=${rulesDir}\n`,
  )

  if (args.mode === 'install') fs.mkdirSync(rulesDir, { recursive: true })

  let anyAbsent = false
  let anyStale = false
  let anyEdited = false
  for (const rule of MANAGED_RULES) {
    const target = path.join(rulesDir, rule.file)
    const c = classify(target, rule)
    const p = plan(c, version, args.force)
    if (c.state === 'absent') anyAbsent = true
    if (c.state === 'clean' && cmp(c.installedVer, version) < 0) anyStale = true
    if (c.state === 'edited' || c.state === 'edited-unknown') anyEdited = true

    if (args.mode === 'install') {
      if (p.write) {
        fs.writeFileSync(target, renderRule(rule, version))
        const verb = c.state === 'absent' ? 'WROTE' : args.force && c.state !== 'clean' ? 'OVERWROTE (--force)' : 'REFRESHED'
        process.stdout.write(`  ${rule.file}: ${verb} v${version} → ${target}\n`)
      } else {
        process.stdout.write(`  ${rule.file}: SKIPPED — ${p.status}\n`)
      }
    } else {
      process.stdout.write(`  ${rule.file}: ${p.status}\n`)
    }
  }

  if (args.mode === 'check') {
    if (anyAbsent) process.stdout.write('adopt-rules: run with --install to write the ABSENT rule(s).\n')
    else if (anyStale) process.stdout.write('adopt-rules: run with --install to refresh the STALE rule(s).\n')
    else if (anyEdited) process.stdout.write('adopt-rules: locally-edited rule(s) present — --install leaves them; --force overwrites.\n')
    else process.stdout.write('adopt-rules: nothing to do.\n')
  }
}

try {
  main()
} catch (err) {
  fail(err && err.message ? err.message : String(err))
}
