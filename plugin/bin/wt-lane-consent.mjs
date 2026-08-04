#!/usr/bin/env node
// Read and change the executor-lane consent switch.
//
// Why this exists as its own CLI: the sibling `wt-lane-consent-check` is a DISAGREEMENT
// detector — it speaks only when the auto-loaded rules route work to the lane by default
// while consent is off, and stays silent in every other state. That is correct for a hook
// and useless for a person, who needs two things it deliberately does not offer:
//
//   1. "what is the state right now?"  — answered in every state, including the silent ones
//   2. "change it"                     — no writer existed at all; the switch could only be
//                                        flipped by hand-editing JSON, which is exactly the
//                                        "here is a variable name, good luck" failure this
//                                        tool removes.
//
// Consent composes two levels and a refusal at either one wins:
//   - ACCOUNT  (<config dir>/settings.json)              the ceiling; opt-in, default OFF
//   - PROJECT  (<project>/.claude/settings.local.json)   may only NARROW, never widen
//
// ⚠ Two different readers, two different latencies — stated in the output because getting
// it wrong makes a correct write look like it did nothing:
//   - anything reading the FILE (this CLI, the check hook, the pilot-wave skill) sees a
//     change immediately;
//   - anything reading the ENVIRONMENT VARIABLE sees it only in a session started after the
//     write, because the settings `env` block is applied at session start.
//
// This never prints the raw stored value — the state is reported in words. The sibling
// check's own no-value lock is about ITS output, but the same discipline is cheap here and
// keeps a settings value out of transcripts.
import fs from 'node:fs'
import path from 'node:path'
import {
  LANE_CONSENT_KEY as KEY,
  resolveConfigDir,
  resolveConsent,
} from './lib/lane-consent-check-core.mjs'

const CONSENTED = 'true'
const REFUSED = 'false'

function usage() {
  return [
    'wt-lane-consent — show or change the external executor-lane consent switch',
    '',
    'Usage:',
    '  wt-lane-consent                     show the current state (account + project + effective)',
    '  wt-lane-consent --on                allow the lane for this account',
    '  wt-lane-consent --off               refuse the lane for this account',
    '  wt-lane-consent --project [dir] --on|--off   narrow (or re-open) it for one project only',
    '',
    'Options:',
    '  --project [dir]   act on the project settings instead of the account settings',
    '                    (defaults to the current directory)',
    '  --json            machine-readable state; implies no write unless --on/--off is given',
    '',
    'A project may only NARROW the account ceiling. Turning a project ON while the account',
    'is OFF changes nothing — the account refusal still wins, and this tool says so.',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = { mode: 'show', scope: 'account', projectDir: process.cwd(), json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--on') opts.mode = 'on'
    else if (arg === '--off') opts.mode = 'off'
    else if (arg === '--json') opts.json = true
    else if (arg === '--help' || arg === '-h') opts.mode = 'help'
    else if (arg === '--project') {
      opts.scope = 'project'
      const next = argv[i + 1]
      if (typeof next === 'string' && !next.startsWith('-')) {
        opts.projectDir = path.resolve(next)
        i += 1
      }
    } else return { error: `unknown argument: ${arg}` }
  }
  return opts
}

function describe(state) {
  if (state === 'true') return 'ALLOWED'
  if (state === 'not_true') return 'REFUSED'
  if (state === 'missing') return 'not set'
  return 'UNKNOWN (unreadable or malformed settings)'
}

// Read-modify-write of ONE key, preserving everything else byte-for-byte where JSON allows.
// A backup is written first: this file carries unrelated settings a user cares about, and a
// crash between read and write must not be the reason they are lost.
function writeConsent(filePath, value) {
  let json = {}
  let existed = false
  if (fs.existsSync(filePath)) {
    existed = true
    fs.copyFileSync(filePath, `${filePath}.bak-lane-consent`)
    json = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error(`${filePath} does not contain a JSON object`)
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }
  const rootKeysBefore = Object.keys(json).length
  if (!json.env || typeof json.env !== 'object' || Array.isArray(json.env)) json.env = {}
  const envKeysBefore = Object.keys(json.env).length
  const previous = Object.prototype.hasOwnProperty.call(json.env, KEY) ? json.env[KEY] : undefined
  json.env[KEY] = value
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`)
  return {
    existed,
    previous,
    rootKeysBefore,
    rootKeysAfter: Object.keys(json).length,
    envKeysBefore,
    envKeysAfter: Object.keys(json.env).length,
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    process.stderr.write(`${opts.error}\n\n${usage()}\n`)
    process.exitCode = 2
    return
  }
  if (opts.mode === 'help') {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const configDir = resolveConfigDir(process.env)
  const accountFile = path.join(configDir, 'settings.json')
  const projectFile = path.join(opts.projectDir, '.claude', 'settings.local.json')

  const written = []
  if (opts.mode === 'on' || opts.mode === 'off') {
    const target = opts.scope === 'project' ? projectFile : accountFile
    const value = opts.mode === 'on' ? CONSENTED : REFUSED
    const result = writeConsent(target, value)
    written.push({ file: target, scope: opts.scope, mode: opts.mode, ...result })
  }

  const consent = resolveConsent(opts.projectDir, process.env)

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          key: KEY,
          effective: consent.outcome === 'true' ? 'allowed' : consent.outcome,
          account: { file: accountFile, state: consent.account.state },
          project: { file: projectFile, state: consent.project.state },
          written,
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  const lines = []
  for (const w of written) {
    lines.push(
      `Wrote ${w.scope} settings: ${w.file}` +
        (w.existed ? ` (backup: ${path.basename(w.file)}.bak-lane-consent)` : ' (file created)'),
    )
    lines.push(
      `  keys preserved: ${w.rootKeysBefore} -> ${w.rootKeysAfter} at the root, ` +
        `${w.envKeysBefore} -> ${w.envKeysAfter} under env`,
    )
    lines.push('')
  }

  lines.push(`External executor lane (${KEY}):`)
  lines.push(`  account  ${accountFile}`)
  lines.push(`           ${describe(consent.account.state)}`)
  lines.push(`  project  ${projectFile}`)
  lines.push(`           ${describe(consent.project.state)}`)
  lines.push('')
  if (consent.outcome === 'unknown') {
    lines.push('  EFFECTIVE: UNKNOWN — one of the files above could not be read or parsed.')
    lines.push('  Nothing routes to the lane while this is unresolved; fix the file named above.')
  } else if (consent.outcome === 'true') {
    lines.push('  EFFECTIVE: ALLOWED — heavy increments may be routed to the external lane here.')
  } else {
    const why =
      consent.account.state !== 'true'
        ? 'the account has not opted in'
        : 'this project narrows the account ceiling'
    lines.push(`  EFFECTIVE: REFUSED — ${why}.`)
    lines.push('  Work stays in-house: coordinators split instead, spawning a cheaper sub-agent.')
  }

  if (written.length > 0) {
    lines.push('')
    lines.push('Takes effect: immediately for anything that reads the settings file (this tool,')
    lines.push('the consent check, the pilot-wave skill). A session already running keeps the')
    lines.push('environment variable it was started with — restart it if something reads that.')
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
