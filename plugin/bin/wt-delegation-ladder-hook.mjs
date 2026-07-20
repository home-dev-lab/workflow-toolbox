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
// - Robust: any error is swallowed and the hook exits 0 emitting nothing — a
//   context hook must never disrupt session start.

import fs from 'node:fs'
import path from 'node:path'

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

/** Is an executable named `bin` reachable on PATH? (cross-platform, no spawn.) */
function onPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
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
    'One tracked card → a workflow-toolbox:pilot; several cards → a workflow-toolbox:pilot-orchestrator;',
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

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildLadder(),
      },
    }),
  )
}

try {
  main()
} catch {
  // A context hook must never disrupt session start: emit nothing, exit clean.
}
