// sdk-runner-consent.mjs — refuse the SDK pilot runner and the orchestrator BEFORE any agent starts
// when this profile has no external-lane consent.
//
// Why: the runner's tdd, harden and review phases always spawn wt-lane.mjs (lifecycle-launch.mjs);
// wt-lane refuses without consent, so an unconsented run spent its route and plan turns and then
// stopped at the first lane phase with refusal "launcher pid". Until a Claude-only executor exists
// (a Claude-only executor lane is planned), the honest behaviour on such a profile is to refuse up front.
// Same resolver and fail-closed wording as the PreToolUse consent gate and wt-lane itself.
import { evaluateConsentGate } from './lane-consent-gate-core.mjs'

export function sdkRunnerConsentRefusal(name, projectDir, env = process.env) {
  const gate = evaluateConsentGate({ tool_input: { command: 'opencode run' }, cwd: projectDir }, { env })
  if (gate.silent) return null
  return [
    `${name}: Refused before any agent starts: this runner hands tdd, harden and review to the external lane, and this profile has no lane consent.`,
    '  No Claude-only executor exists yet, so the run would stop at its first lane phase.',
    gate.message,
  ].join('\n')
}
