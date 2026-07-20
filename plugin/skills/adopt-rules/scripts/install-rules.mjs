#!/usr/bin/env node
// install-rules.mjs — the deterministic engine behind the adopt-rules skill.
//
// Writes EDITABLE copies of workflow-toolbox's cross-cutting guardrails into the
// user's config as rule files, each stamped with a versioned banner so a later
// re-invoke can detect a stale copy and offer a refresh. It writes ONLY when
// asked (`--install`); the default `--check` mode is read-only. The skill (and any
// first-run suggestion) may only SUGGEST adoption — never write silently.
//
// Usage (the skill orchestrates these; a human can run them directly too):
//   node install-rules.mjs --check   [--dir <rulesDir>]   # report status, write nothing
//   node install-rules.mjs --install [--dir <rulesDir>]   # write/refresh the rule files
//
// Default target dir: <cwd>/.claude/rules (project-scoped, least invasive). Pass
// --dir ~/.claude/rules (or $CLAUDE_CONFIG_DIR/rules) for a global install.

import fs from 'node:fs'
import path from 'node:path'
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

const BANNER_RE = new RegExp(`installed from ${BANNER_TOOL} v(\\d+)\\.(\\d+)\\.(\\d+)`)

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

function banner(version) {
  return (
    `<!-- installed from ${BANNER_TOOL} v${version} by the adopt-rules skill — editable copy. ` +
    `Re-run the workflow-toolbox:adopt-rules skill to check for updates; your edits are ` +
    `preserved unless you choose to overwrite on refresh. -->`
  )
}

function renderRule(rule, version) {
  return `${banner(version)}\n\n# ${rule.title}\n\n${rule.body}\n`
}

/** Parse the installed version from an existing rule file's banner. */
function installedVersion(filePath) {
  if (!fs.existsSync(filePath)) return null
  const m = fs.readFileSync(filePath, 'utf8').match(BANNER_RE)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : 'unmanaged'
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
  const args = { mode: 'check', dir: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--install') args.mode = 'install'
    else if (argv[i] === '--check') args.mode = 'check'
    else if (argv[i] === '--dir') args.dir = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = currentVersion()
  const rulesDir = path.resolve(args.dir || path.join(process.cwd(), '.claude', 'rules'))

  process.stdout.write(
    `adopt-rules: ${BANNER_TOOL} v${version} · mode=${args.mode} · target=${rulesDir}\n`,
  )

  if (args.mode === 'install') fs.mkdirSync(rulesDir, { recursive: true })

  let anyStale = false
  let anyMissing = false
  for (const rule of MANAGED_RULES) {
    const target = path.join(rulesDir, rule.file)
    const inst = installedVersion(target)
    let status
    if (inst === null) {
      status = 'ABSENT'
      anyMissing = true
    } else if (inst === 'unmanaged') {
      status = 'PRESENT (no toolbox banner — hand-authored; left untouched)'
    } else {
      const c = cmp(inst, version)
      status = c < 0 ? `STALE (installed v${inst} < v${version})` : c > 0 ? `AHEAD (v${inst})` : `UP-TO-DATE (v${inst})`
      if (c < 0) anyStale = true
    }

    if (args.mode === 'install') {
      if (inst === 'unmanaged') {
        process.stdout.write(`  ${rule.file}: SKIPPED — ${status}\n`)
      } else {
        fs.writeFileSync(target, renderRule(rule, version))
        process.stdout.write(`  ${rule.file}: WROTE v${version} → ${target}\n`)
      }
    } else {
      process.stdout.write(`  ${rule.file}: ${status}\n`)
    }
  }

  if (args.mode === 'check') {
    if (anyMissing) process.stdout.write('adopt-rules: run with --install to write the ABSENT rule(s).\n')
    else if (anyStale) process.stdout.write('adopt-rules: run with --install to refresh the STALE rule(s).\n')
    else process.stdout.write('adopt-rules: nothing to do.\n')
  }
}

try {
  main()
} catch (err) {
  fail(err && err.message ? err.message : String(err))
}
