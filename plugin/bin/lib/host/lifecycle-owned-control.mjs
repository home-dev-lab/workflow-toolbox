// A submitted decision resumes the owned wait; the supervisor determines its outcome.
import { execFileSync } from 'node:child_process'
import { readCurrentSupervision } from '../lane-supervisor-core.mjs'

function selectOwned(context, args) {
  const records = [...context.state.ownedLanes.values()].filter((record) => record.phase === context.state.phase)
  if (args.criticLane) return records.find((record) => record.criticLane === args.criticLane) ?? null
  if (records.length > 1) return 'criticLane A|B for owned critic lane'
  return records[0] ?? null
}

function submit(context, record, args) {
  const command = [context.controlPath, '--dir', context.root, '--decision', args.decision, '--owner-token', record.nonce]
  if (record.slot !== null) command.push('--slot', record.slot)
  if (args.decision === 'extend' && args.extendSeconds !== undefined) command.push('--extend', String(args.extendSeconds))
  execFileSync(process.execPath, command, { cwd: context.root, encoding: 'utf8', env: { ...process.env, WT_LANE_SUPERVISION_SLOT: undefined } })
}

function controlCode(context, record, error) {
  if (error?.status !== 1) return 'other'
  const current = readCurrentSupervision(context.root, record.slot)
  if (!current || !['session', 'pilot'].includes(current.owner)) return 'ownership'
  const owns = current.owner === 'pilot'
    ? Boolean(current.ownerToken && current.ownerToken === record.nonce)
    : Boolean(current.ownerSessionId && process.env.CLAUDE_CODE_SESSION_ID === current.ownerSessionId)
  return owns ? 'other' : 'ownership'
}

async function decide(context, record, args, observation, finish) {
  const { owned, refusal, state, laneDir } = context
  try { submit(context, record, args) } catch (error) {
    if ((await owned.reconcile(record)).terminal) return finish()
    const detail = error?.stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))
    return refusal(`${state.phase}->next`, `control ${args.decision} (${detail})`, laneDir, controlCode(context, record, error))
  }
  record.answeredAt = observation.saved?.timeoutAt ?? null
  return `control ${args.decision} submitted; ${await finish()}`
}

export async function runOwnedControl(context, args) {
  const { state, refusal, laneDir, owned, aggregate } = context
  const edge = `${state.phase}->next`
  if (!['abandon', 'extend'].includes(args.decision)) return refusal(edge, 'control decision abandon|extend', laneDir)
  const record = selectOwned(context, args)
  if (typeof record === 'string') return refusal(edge, record, laneDir)
  if (!record) return refusal(edge, 'timed-out lane owned by this lifecycle', laneDir, 'ownership')
  record.waitMs = 0
  const observation = await owned.reconcile(record)
  const finish = async () => {
    const result = await owned.awaitOwnedLane(record)
    return record.criticLane ? aggregate([result]) : result
  }
  // The control CLI admits a decision only at a decision point, or an abandon of an orphaned child.
  const admitted = observation.verdict.status === 'decision-needed'
    || (observation.verdict.status === 'worker-gone-child-alive' && args.decision === 'abandon')
  if (observation.terminal || !admitted) return finish()
  return decide(context, record, args, observation, finish)
}
