// Function Hooks run in the SDK sandbox: no Node globals or imports are available here.
const LANE_MODEL = 'openai/gpt-5.6-terra'
const TOOL = 'mcp__sdk-pilot-lifecycle__transition'
const WRITE_TOOL = 'mcp__sdk-pilot-lifecycle__write_artifact'
// Rounds count from 1 and the bound is THREE accepted revision rounds, the fourth refused.
// `>= 3` refused the THIRD, so every loop was one round shorter than the contract and the card said.
const initial = () => ({ route: null, phase: 'discovery', planRound: 0, reviewRound: 0, handled: {}, worktree: null })

function hasFindings(event) {
  return Array.isArray(event.findings) && event.findings.every((finding) => typeof finding === 'string' && finding.trim().length > 0)
}

// `clear` and `changes-requested` gate through DIFFERENT predicates, and collapsing them is the
// defect this pair exists to prevent in both directions. `[].every()` is true, so the shape check
// alone accepted a `changes-requested` naming NOTHING — a revision round that cannot be actioned,
// bounded or disputed, burning one of the three rounds while recording no reason. But a blanket
// non-empty rule would deny a `clear` review that legitimately found nothing, which is the healthy
// outcome: that would close one hole by breaking the case worth celebrating.
function hasActionableFindings(event) {
  return hasFindings(event) && event.findings.length > 0
}

function hasGateReceipts(event) {
  return Array.isArray(event.gate_receipts) && event.gate_receipts.length > 0 && event.gate_receipts.every((receipt) => receipt && typeof receipt.name === 'string' && receipt.name.length > 0 && receipt.exit === 0)
}

function nextState(state, event) {
  const phase = event.phase
  const outcome = event.outcome
  if (state.phase === 'discovery' && phase === 'discovery' && (event.route === 'LITE' || event.route === 'FULL')) return { ...state, route: event.route, phase: event.route === 'LITE' ? 'tdd' : 'plan', planRound: event.route === 'FULL' ? 1 : 0 }
  if (state.phase === 'plan' && phase === 'plan') return { ...state, phase: 'critic' }
  if (state.phase === 'critic' && phase === 'critic' && outcome === 'approved') return { ...state, phase: 'tdd' }
  if (state.phase === 'critic' && phase === 'critic' && outcome === 'changes-requested') {
    if (state.planRound >= 4) return null
    return { ...state, phase: 'plan', planRound: state.planRound + 1 }
  }
  if (state.phase === 'tdd' && phase === 'tdd') return { ...state, phase: 'verify' }
  // A verify after harden must CARRY the review round: resetting it to 1 each cycle made the
  // three-round bound unreachable, so the loop could run forever while reporting itself bounded.
  if (state.phase === 'verify' && phase === 'verify' && outcome === 'passed') return { ...state, phase: state.route === 'LITE' ? 'report' : 'review', reviewRound: state.route === 'FULL' ? (state.reviewRound || 1) : 0 }
  if (state.phase === 'review' && phase === 'review' && outcome === 'clear' && hasFindings(event)) return { ...state, phase: 'refutation' }
  if (state.phase === 'review' && phase === 'review' && outcome === 'changes-requested' && hasActionableFindings(event)) {
    if (state.reviewRound >= 4) return null
    return { ...state, phase: 'harden', reviewRound: state.reviewRound + 1 }
  }
  if (state.phase === 'refutation' && phase === 'refutation' && outcome === 'clear' && hasFindings(event)) return { ...state, phase: 'report' }
  if (state.phase === 'refutation' && phase === 'refutation' && outcome === 'changes-requested' && hasActionableFindings(event)) {
    if (state.reviewRound >= 4) return null
    return { ...state, phase: 'harden', reviewRound: state.reviewRound + 1 }
  }
  if (state.phase === 'harden' && phase === 'harden') return { ...state, phase: 'verify' }
  if (state.phase === 'report' && phase === 'report' && hasGateReceipts(event)) return { ...state, phase: 'awaiting_fidelity' }
  return undefined
}

export const register = (on) => {
  const serial = new Map()
  on('session.start', async ($, event, next) => {
    await $.tool.register({ name: 'transition', description: 'Record one ordered SDK pilot lifecycle transition.', inputSchema: { type: 'object', additionalProperties: false, properties: { phase: { type: 'string', enum: ['discovery', 'plan', 'critic', 'tdd', 'verify', 'review', 'refutation', 'harden', 'report'] }, route: { type: 'string', enum: ['LITE', 'FULL'] }, outcome: { type: 'string', enum: ['approved', 'changes-requested', 'clear', 'passed'] }, findings: { type: 'array', items: { type: 'string' } }, gate_receipts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'exit'], properties: { name: { type: 'string' }, exit: { type: 'number' } } } }, tool_use_id: { type: 'string' } }, required: ['phase'] } })
    await $.tool.register({ name: 'write_artifact', description: 'Write one SDK pilot lane artifact at its fixed worktree path.', inputSchema: { type: 'object', additionalProperties: false, required: ['kind', 'content'], properties: { kind: { type: 'string', enum: ['brief', 'pilot-report'] }, content: { type: 'string' } } } })
    const key = `sdk-pilot-lifecycle.${await $.session.id()}`
    const state = await $.store.get(key) ?? initial()
    if (typeof event.cwd === 'string' && event.cwd.startsWith('/')) await $.store.set(key, { ...state, worktree: event.cwd })
    return next(event)
  })
  on('tool.call', { tool: TOOL }, async ($, event) => {
    const id = event.tool_use_id ?? event.toolUseId
    if (typeof id !== 'string' || !id) return { deny: 'wt-sdk-pilot-lifecycle: tool_use_id is required' }
    const key = `sdk-pilot-lifecycle.${await $.session.id()}`
    const prior = serial.get(key) ?? Promise.resolve()
    let release
    const queued = new Promise((done) => { release = done })
    serial.set(key, prior.then(() => queued))
    await prior
    try {
    const state = await $.store.get(key) ?? initial()
    const previous = state.handled[id]
    const shape = JSON.stringify({ phase: event.phase, route: event.route, outcome: event.outcome, findings: event.findings, gate_receipts: event.gate_receipts })
    if (previous) return previous.shape === shape ? previous.idempotentResult : { deny: 'wt-sdk-pilot-lifecycle: conflicting tool_use_id reuse' }
    const next = nextState(state, event)
    if (next === null) return { deny: 'wt-sdk-pilot-lifecycle: round limit reached; escalate to the arbiter' }
    if (!next) return { deny: `wt-sdk-pilot-lifecycle: required=${state.phase} requested=${event.phase}` }
    const result = { result: `wt-sdk-pilot-lifecycle: accepted phase=${next.phase}` }
    next.handled = { ...state.handled, [id]: { shape, result, idempotentResult: { result: `wt-sdk-pilot-lifecycle: idempotent phase=${next.phase}` } } }
    await $.store.set(key, next)
    return result
    } finally {
      release()
      if (serial.get(key) === queued) serial.delete(key)
    }
  })
  on('tool.call', { tool: WRITE_TOOL }, async ($, event) => {
    const key = `sdk-pilot-lifecycle.${await $.session.id()}`
    const state = await $.store.get(key) ?? initial()
    const paths = state.worktree ? { brief: `${state.worktree}/.lane/brief.md`, 'pilot-report': `${state.worktree}/.lane/pilot-report.md` } : null
    if (!paths || typeof event.content !== 'string' || !Object.hasOwn(paths, event.kind)) return { deny: 'wt-sdk-pilot-lifecycle: invalid artifact request' }
    if ((event.kind === 'brief' && state.phase !== 'tdd') || (event.kind === 'pilot-report' && state.phase !== 'awaiting_fidelity')) {
      return { deny: `wt-sdk-pilot-lifecycle: ${event.kind} is unavailable in phase=${state.phase}` }
    }
    await $.fs.writeFile(paths[event.kind], event.content)
    return { result: `wt-sdk-pilot-lifecycle: wrote ${event.kind}` }
  })
  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const key = `sdk-pilot-lifecycle.${await $.session.id()}`
    const state = await $.store.get(key) ?? initial()
    const command = typeof event.command === 'string' ? event.command.trim() : ''
    const root = state.worktree
    // STOPGAP — a follow-up safety increment replaces this shape. A blacklist of shell metacharacters
    // leaked three times; the third leak was a CONTROL character: an allowed `git ... commit -m ok`
    // followed by a newline is simply a second command. Until a dedicated spawn tool with
    // structured argv replaces raw Bash, accept only printable ASCII and reject the metacharacters,
    // so nothing can append a command to an allowed one.
    if (!root || /[^\x20-\x7e]/.test(command) || /[|&;`$<>(){}[\]\\!*?~]/.test(command)) {
      return { deny: 'wt-sdk-pilot-lifecycle: Bash command is outside the runner allow-list' }
    }
    const readOnly = [
      `git -C ${root} diff --stat`,
      `git -C ${root} status --short`,
      `tail -n 1 ${root}/.lane/typecheck.log ${root}/.lane/lint.log ${root}/.lane/test.log`,
      `head -40 ${root}/.lane/report.md`,
    ]
    // The runner's standing prompt emits an ABSOLUTE launcher path (pilot-runner-core.mjs) while the
    // contract writes it relatively, so the bundled suffix is matched rather than one literal string:
    // an exact-string fence here denies the one launch it exists to permit. Everything that carries a
    // boundary stays pinned — the bundled launcher, this worktree, its own brief, and the consented
    // lane model (routing to an unconsented model is a consent decision, not the pilot's to make).
    // Only --timeout is free: a continuation legitimately needs a longer one.
    const launched = /^node (?:\S*\/)?plugin\/bin\/wt-lane\.mjs --dir (\S+) --model (\S+) --brief (\S+) --timeout ([1-9]\d*)$/.exec(command)
    const launch = Boolean(launched) && launched[1] === root && launched[2] === LANE_MODEL && launched[3] === `${root}/.lane/brief.md`
    // -C must name THIS worktree: every other rule pins it, and an unpinned -C let the pilot commit
    // in any repository on the machine while still reading as a phase-gated commit.
    const commitPrefix = `git -C ${root} commit -m `
    const commit = command.startsWith(commitPrefix) && command.slice(commitPrefix.length).trim().length > 0
    if (readOnly.includes(command)) return next(event)
    if (launch && state.phase === 'tdd') return next(event)
    if (commit && state.phase === 'report') return next(event)
    return { deny: `wt-sdk-pilot-lifecycle: Bash command is unavailable in phase=${state.phase}` }
  })
}

// The engine resolves the `register` export itself: an ALIASED export (`export const register =
// createLifecycle`) loads the plugin but registers no hooks and no tools, so the SDK pilot ran with
// no lifecycle at all while every unit test stayed green — the tests import this binding directly and
// never exercise the engine's resolution. Declare `register` inline; `createLifecycle` is the alias.
export const createLifecycle = register
