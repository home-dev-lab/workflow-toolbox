// lane-consent-gate-core.mjs — the decision behind wt-lane-consent-gate-hook.mjs: does THIS
// Bash command actually invoke the external executor lane, and if so, is it consented?
//
// Why this exists, distinct from the sibling `lane-consent-check-core.mjs`: that module answers
// "do the auto-loaded RULES disagree with the switch" — a SessionStart advisory, silent unless a
// rule declares the lane a default. It never runs at the moment a lane call is about to execute,
// and nothing before this file did either: `opencode-verifier` and the pilot-wave SKILL prose
// both assume the switch was already checked by whoever composed the brief — an instruction a
// model can silently skip, exactly the class of thing a mechanical gate exists to replace. This
// module is the gate itself: it fires on the REAL command text, at the REAL PreToolUse(Bash)
// event, and its answer is binary — deny, or stay silent.
//
// ⚠ FAILS CLOSED — the deliberate exception on this machine, not the rule. Every other
// deny-capable guard in this directory (lane saturation, verifier-cli self-answer, …) fails OPEN
// on its own internal error, because those guards protect a command from being wrongly blocked
// and a broken entry path must never itself become a block. A CONSENT gate protects the exact
// opposite property: an unreadable or malformed settings file must never be read as "yes". So
// here, 'unknown' (unreadable/invalid settings) is treated exactly like "not consented" — see
// evaluateConsentGate below — and the hook wrapper extends the same discipline to its own
// top-level errors (see wt-lane-consent-gate-hook.mjs).

import { LANE_CONSENT_KEY, resolveConsent } from './lane-consent-check-core.mjs'
import { LANE_INVOCATIONS, stripNonExecutedText } from './wt-lane-saturation-core.mjs'

function isLaneInvocation(command) {
  return typeof command === 'string' && LANE_INVOCATIONS.some((re) => re.test(stripNonExecutedText(command)))
}

function describeState(state) {
  if (state === 'true') return 'permits the lane'
  if (state === 'missing') return 'absent (no consent declared)'
  if (state === 'not_true') return 'present but non-consenting'
  return 'unreadable or malformed'
}

function unknownMessage(consent) {
  return [
    `Refused: the external-lane consent switch (${LANE_CONSENT_KEY}) could not be resolved.`,
    `  ${consent.account.filePath}: ${describeState(consent.account.state)}`,
    `  ${consent.project.filePath}: ${describeState(consent.project.state)}`,
    '  This fails CLOSED, not open: a consent check that cannot read its own switch must never',
    '  silently read that as "yes" — an unreadable or malformed settings file blocks the call',
    '  rather than granting it by accident.',
    '  Fix: repair the settings file named above (valid JSON, an "env" object with a plain string',
    `  value for ${LANE_CONSENT_KEY}), then retry — or run \`wt-lane-consent\` to inspect the state.`,
  ].join('\n')
}

function refusedMessage(consent) {
  const accountOk = consent.account.state === 'true'
  const why = accountOk
    ? `this project narrows the account ceiling (${consent.project.filePath} sets ${LANE_CONSENT_KEY} to something other than "true")`
    : `the account has not opted in (${consent.account.filePath} does not set ${LANE_CONSENT_KEY} to "true")`
  return [
    `Refused: this command routes work to the external executor lane, and consent is not given —`,
    `  ${why}.`,
    '  Availability of a lane on this machine is never consent to use it, and a refusal at either',
    '  level (account ceiling or project narrowing) wins — this call would otherwise route past a',
    '  switch that was deliberately left off, silently, with nothing to say so.',
    '  Fix: `wt-lane-consent --on` (account) if the lane is wanted here, or keep this work in-house',
    '  — split instead of routing to the lane.',
  ].join('\n')
}

/**
 * Decide whether a Bash PreToolUse payload is a real external-lane invocation and, if so,
 * whether it is consented. Returns `{ silent: true }` for anything that is not a lane call
 * (the overwhelming majority of Bash commands never reach `resolveConsentImpl` at all) or is a
 * consented lane call; returns `{ silent: false, deny: true, message }` otherwise — there is no
 * non-denying non-silent state, unlike the saturation guard's advisory/deny split, because a
 * consent gate has nothing useful to SAY without also refusing: an unconsented call that is
 * merely warned about is the exact failure this card is about.
 */
export function evaluateConsentGate(payload, { resolveConsentImpl = resolveConsent, env = process.env } = {}) {
  const command = payload?.tool_input?.command
  if (!isLaneInvocation(command)) return { silent: true }

  const projectDir = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd()
  const consent = resolveConsentImpl(projectDir, env)

  if (consent.outcome === 'true') return { silent: true }
  if (consent.outcome === 'unknown') return { silent: false, deny: true, message: unknownMessage(consent) }
  return { silent: false, deny: true, message: refusedMessage(consent) }
}
