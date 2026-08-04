#!/usr/bin/env node
// wt-delegation-ladder-hook.mjs — a conditional SessionStart hook that injects
// the GENERIC delegation ladder as additionalContext, calibrated to the machine.
//
// Design contract:
// - Conditional: it injects ONLY when the project shows delegation/tracked-work
//   markers (a task tracker or user-authored agents). Otherwise it is a silent
//   no-op — no output, no clutter where the ladder is irrelevant.
// - Cost-model NEUTRAL: it carries the PRINCIPLE (route to the lowest rung; pin
//   model/effort per spawn; heavy work goes down, judgment stays up), never an
//   account-specific model/quota table. Which concrete model each rung maps to
//   is the operator's business, resolved at spawn.
// - Machine-calibrated: it probes PATH for cross-family bridges (codex/opencode)
//   and names the ones actually present, so the injected ladder reflects THIS
//   machine's real lanes and degrades cleanly when none is installed.
// - Robust: any internal error fails open and leaves one stderr trace — a
//   context hook must never disrupt session start.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

/** Read the hook's JSON payload from stdin (fd 0); tolerate an empty/absent one. */
function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Does this project do tracked/delegated work worth carrying the ladder for? */
function hasDelegationMarkers(root) {
  const claude = path.join(root, '.claude')
  for (const marker of ['planka.json', 'progress.md']) {
    try {
      if (fs.existsSync(path.join(claude, marker))) return true
    } catch {
      /* ignore */
    }
  }
  try {
    const agents = path.join(claude, 'agents')
    if (fs.existsSync(agents) && fs.readdirSync(agents).some((f) => f.endsWith('.md'))) return true
  } catch {
    /* ignore */
  }
  return false
}

/** Is an executable named `bin` reachable — on PATH, or in the common rc-file install
 *  dirs a non-login-shell PATH often misses? (Our own opencode-verifier documents this
 *  exact PATH-miss for rc-file installs, so we scan the usual homes after PATH.)
 *  cross-platform, no spawn. */
function onPath(bin) {
  const fallbacks = [
    path.join(os.homedir(), '.opencode', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...fallbacks]
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext)
      try {
        if (process.platform === 'win32') {
          if (fs.existsSync(candidate)) return true
        } else {
          fs.accessSync(candidate, fs.constants.X_OK)
          return true
        }
      } catch {
        /* not here — keep scanning */
      }
    }
  }
  return false
}

/** Has the user already adopted the ladder as an editable rule (project or global)?
 *  If so, we suppress the one-line adopt-rules suggestion (suggest until adopted,
 *  never nag past it). */
function ladderAdopted(root) {
  const rel = path.join('.claude', 'rules', 'wt-delegation-ladder.md')
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  for (const p of [path.join(root, rel), path.join(cfg, 'rules', 'wt-delegation-ladder.md')]) {
    try {
      if (fs.existsSync(p)) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

function buildLadder() {
  const bridges = ['codex', 'opencode'].filter(onPath)
  const laneLine =
    bridges.length > 0
      ? `Cross-family lanes detected on this machine: ${bridges.join(', ')} — use one as a ` +
        `cheaper executor for heavy increments and as a decorrelated verifier for checkable claims.`
      : `No cross-family bridge detected on PATH — executor and verifier lanes run inline ` +
        `(same-family); a genuinely different model family is the one real decorrelation lever, so ` +
        `install one (e.g. codex or opencode) if you want it.`

  return [
    'Delegation ladder (workflow-toolbox): route each task to the LOWEST rung that fits, and',
    'PIN model + effort at EVERY spawn — never let a delegate inherit the session model silently.',
    'Heavy mechanical work goes DOWN to a cheaper executor; judgment stays UP with you as arbiter.',
    'One tracked card → an adopted pilot; several cards → an adopted pilot-orchestrator;',
    'compose either (environment brief + model elevation) via the workflow-toolbox:pilot-wave skill.',
    laneLine,
  ].join('\n')
}

function main() {
  const input = readInput()
  // The session's project dir comes from the payload's `cwd` (a standard field on
  // every Claude Code hook event). If it is absent — empty/malformed stdin, or a
  // payload without cwd — we cannot know which project this is, so we FAIL SAFE and
  // stay silent rather than probe an arbitrary process.cwd() and inject into a
  // possibly-irrelevant session.
  const root = typeof input.cwd === 'string' && input.cwd ? input.cwd : null
  if (!root || !hasDelegationMarkers(root)) return // silent no-op where irrelevant

  let context = buildLadder()
  if (!ladderAdopted(root)) {
    context +=
      '\nPrefer editable copies of the workflow-toolbox rule set (this delegation ladder plus the ' +
      'other shipped guardrails)? Run the workflow-toolbox:adopt-rules skill with --set rules (it ' +
      'writes only on explicit request, never automatically).'
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    }),
  )
}

runFailOpenHook('wt-delegation-ladder-hook.mjs', main)
