import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'

const plan = readFileSync(new URL('./fixtures/mechanical-cycle-plan.md', import.meta.url), 'utf8')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.WT_EDGE_CONFIG
  delete process.env.WT_FULL_CALLS
  delete process.env.WT_FULL_COUNTS
})

describe('real SDK lifecycle server FULL sequence', () => {
  it('mechanically completes the full route through the registered handlers', async () => {
    const lifecycle = fullLifecycle()
    expect(await lifecycle.transition({ phase: 'discovery', tool_use_id: 'discovery' })).toBe('accepted phase=plan')
    expect(await lifecycle.artifact({ kind: 'plan', content: plan })).toBe('wrote plan')
    expect(await lifecycle.artifact({ kind: 'critic-brief', content: 'critic' })).toBe('wrote critic-brief')
    expect(await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan-1' })).toBe('accepted phase=critic')
    expect(await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 })).toBe('lane critic EXIT=0')
    expect(await lifecycle.transition({ phase: 'critic', outcome: 'changes-requested', findings: ['tighten the proof'], tool_use_id: 'critic-1' })).toBe('accepted phase=plan')
    expect(await lifecycle.artifact({ kind: 'plan', content: plan })).toBe('wrote plan')
    expect(await lifecycle.artifact({ kind: 'critic-brief', content: 'critic again' })).toBe('wrote critic-brief')
    expect(await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan-2' })).toBe('accepted phase=critic')
    await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 })
    expect(await lifecycle.transition({ phase: 'critic', outcome: 'approved', tool_use_id: 'critic-2' })).toBe('accepted phase=tdd')
    expect(await lifecycle.artifact({ kind: 'brief', content: plan })).toBe('wrote brief')
    expect(await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })).toBe('lane tdd EXIT=0')
    expect(await lifecycle.transition({ phase: 'tdd', tool_use_id: 'tdd' })).toBe('accepted phase=verify')
    await gates(lifecycle)
    expect(await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify-1' })).toBe('accepted phase=review')
    expect(await lifecycle.artifact({ kind: 'review-brief', content: 'review' })).toBe('wrote review-brief')
    await lifecycle.run({ kind: 'lane', phase: 'review', timeout: 1 })
    expect(await lifecycle.transition({ phase: 'review', outcome: 'changes-requested', findings: ['exercise harden'], tool_use_id: 'review-1' })).toBe('accepted phase=harden')
    expect(await lifecycle.artifact({ kind: 'harden-brief', content: 'harden' })).toBe('wrote harden-brief')
    await lifecycle.run({ kind: 'lane', phase: 'harden', timeout: 1 })
    expect(await lifecycle.transition({ phase: 'harden', tool_use_id: 'harden' })).toBe('accepted phase=verify')
    await gates(lifecycle)
    expect(await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify-2' })).toBe('accepted phase=review')
    await lifecycle.artifact({ kind: 'review-brief', content: 'review again' })
    await lifecycle.run({ kind: 'lane', phase: 'review', timeout: 1 })
    expect(await lifecycle.transition({ phase: 'review', outcome: 'clear', tool_use_id: 'review-2' })).toBe('accepted phase=refutation')
    await lifecycle.artifact({ kind: 'refutation-brief', content: 'refute' })
    await lifecycle.run({ kind: 'lane', phase: 'refutation', timeout: 1 })
    expect(await lifecycle.transition({ phase: 'refutation', outcome: 'clear', tool_use_id: 'refutation' })).toBe('accepted phase=report')
    expect(await lifecycle.artifact({ kind: 'pilot-report', content: '# completed full cycle\n' })).toBe('wrote pilot-report')
    expect(await lifecycle.transition({ phase: 'report', tool_use_id: 'report' })).toBe('accepted phase=awaiting_fidelity')

    const calls = readFileSync(lifecycle.calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(calls.filter((call) => ['critic', 'review', 'refutation'].includes(call.phase)).every((call) => call.model === 'openai/gpt-5.6-sol')).toBe(true)
    expect(calls.filter((call) => ['tdd', 'harden'].includes(call.phase)).every((call) => call.model === 'openai/gpt-5.6-terra')).toBe(true)
  })

  it.each([
    ['wrong phase for the event', async () => liteLifecycle().transition({ phase: 'tdd', tool_use_id: 'wrong' }), /current phase discovery/],
    ['missing receipt', async () => { const lifecycle = liteLifecycle(); await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' }); return lifecycle.transition({ phase: 'tdd', tool_use_id: 'missing' }) }, /lane receipt unchanged/],
    ['receipt with EXIT=124', async () => { const lifecycle = liteLifecycle(); edgeConfig({ tdd: { exit: 124 } }); await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' }); await lifecycle.artifact({ kind: 'brief', content: 'brief\n' }); await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }); return lifecycle.transition({ phase: 'tdd', tool_use_id: 'timeout' }) }, /lane receipt EXIT=124/],
    ['receipt EXIT=1 with VERDICT clear is refused', async () => reviewEdge('clear', 1, 'clear'), /lane receipt EXIT=1/],
    ['receipt EXIT=1 with VERDICT changes-requested reaches harden', async () => reviewEdge('changes-requested', 1, 'changes-requested'), /^accepted phase=harden$/],
    ['refutation changes-requested reaches harden', refutationChangesRequested, /^accepted phase=harden$/],
    ['critic receipt EXIT=1 with VERDICT approved is refused', criticApprovedFailedReceipt, /lane receipt EXIT=1/],
    ['harden receipt EXIT=1 is refused', async () => hardenReceipt(1), /lane receipt EXIT=1/],
    ['harden receipt missing is refused', async () => hardenReceipt(null), /lane receipt unchanged/],
    ['report edge with missing pilot-report is refused', async () => reportEdge(false, false), /missing pilot report/],
    ['report edge with a gate digest changed after verify is refused', async () => reportEdge(true, true), /gate digest changed/],
    ['planRound bound', criticBound, /admissible outcome/],
    ['reviewRound bound', reviewBound, /available review round/],
    ['verdict and outcome mismatch', async () => reviewEdge('clear', 0, 'changes-requested'), /outcome does not match the lane report/],
    ['findings mismatch', async () => reviewEdge('changes-requested', 0, 'changes-requested', ['wrong finding']), /findings do not match the lane report/],
    ['report without a VERDICT block', async () => reviewEdge('clear', 0, 'clear', undefined, true), /VERDICT block/],
    ['transition replay same shape is idempotent while a changed shape is refused', async () => { const lifecycle = liteLifecycle(); const event = { phase: 'discovery', tool_use_id: 'same' }; const first = await lifecycle.transition(event); const replay = await lifecycle.transition(event); const changed = await lifecycle.transition({ ...event, route: 'LITE' }); expect(replay).toBe(first); return `${replay}\n${changed}` }, /accepted phase=tdd[\s\S]*unique tool_use_id/],
    ['run inspect log name outside the allow-list', async () => liteLifecycle().run({ kind: 'inspect', what: 'log', name: 'outside.log' }), /log name/],
    ['write_artifact kind outside its phase', async () => liteLifecycle().artifact({ kind: 'pilot-report', content: 'nope' }), /pilot-report in phase report/],
  ])('%s', async (_name, exercise, expected) => {
    expect(await exercise()).toMatch(expected)
  })
})

function root() {
  const value = mkdtempSync(join(tmpdir(), 'wt-lifecycle-full-')); roots.push(value)
  mkdirSync(join(value, '.lane')); mkdirSync(join(value, '.claude', 'reports'), { recursive: true })
  writeFileSync(join(value, '.gitignore'), '.lane/\n.claude/reports/\n')
  spawnSync('git', ['init', '-q'], { cwd: value })
  return value
}
function handlers(server: { instance: { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> } }) {
  const tools = server.instance._registeredTools
  return {
    transition: (args: Record<string, unknown>) => tools.transition!.handler(args).then((result) => result.content[0]!.text),
    artifact: (args: Record<string, unknown>) => tools.write_artifact!.handler(args).then((result) => result.content[0]!.text),
    run: (args: Record<string, unknown>) => tools.run!.handler(args).then((result) => result.content[0]!.text),
  }
}
function laneLauncher() {
  const directory = mkdtempSync(join(tmpdir(), 'wt-lifecycle-full-launcher-')); roots.push(directory)
  const file = join(directory, 'launcher.mjs')
  writeFileSync(file, "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'; import { basename } from 'node:path'; const args = process.argv; const at = (name) => args[args.indexOf(name) + 1]; const log = at('--log'); const brief = at('--brief'); const phase = basename(brief).replace('-brief.md', ''); const key = `${phase}-count`; const counts = JSON.parse(readFileSync(process.env.WT_FULL_COUNTS, 'utf8')); counts[key] = (counts[key] ?? 0) + 1; writeFileSync(process.env.WT_FULL_COUNTS, JSON.stringify(counts)); appendFileSync(process.env.WT_FULL_CALLS, JSON.stringify({ phase, model: at('--model'), argv: args.slice(1) }) + '\\n'); const configured = JSON.parse(process.env.WT_EDGE_CONFIG || '{}')[phase] || {}; const defaults = phase === 'critic' ? (counts[key] === 1 ? { verdict: 'changes-requested', findings: ['tighten the proof'] } : { verdict: 'approved', findings: [] }) : phase === 'review' ? (counts[key] === 1 ? { verdict: 'changes-requested', findings: ['exercise harden'] } : { verdict: 'clear', findings: [] }) : phase === 'refutation' ? { verdict: 'clear', findings: [] } : {}; const verdict = configured.verdict ?? defaults.verdict; const findings = configured.findings ?? defaults.findings ?? []; let report = 'report\\n'; if (configured.noVerdict) report = 'report without contract\\n'; else if (verdict) { const digest = phase === 'critic' && verdict === 'approved' ? `${/plan sha256: ([a-f0-9]+)/.exec(readFileSync(brief, 'utf8'))[0]}\\n` : ''; report = `VERDICT: ${verdict}\\nFINDINGS:\\n${findings.map((finding) => `- ${finding}\\n`).join('')}${digest}`; } appendFileSync(log, `done\\nEXIT=${configured.exit ?? 0}\\n`); writeFileSync(brief.replace('-brief.md', '-report.md'), report)")
  return file
}
function fullLifecycle() {
  const worktree = root(); const calls = join(worktree, '.lane', 'calls.jsonl'); const counts = join(worktree, '.lane', 'counts.json')
  writeFileSync(calls, ''); writeFileSync(counts, '{}'); process.env.WT_FULL_CALLS = calls; process.env.WT_FULL_COUNTS = counts
  let heads = 0
  const server = createLifecycleServer({ worktree, route: 'FULL', models: { lane: 'openai/gpt-5.6-terra', review: 'openai/gpt-5.6-sol' }, cardId: 'full', sessionTag: 'test', laneLauncher: laneLauncher(), laneWaitMs: 100, gateRunner: ({ log }: { log: string }) => { writeFileSync(log, 'gate\n'); return 0 }, git: (_program: string, args: string[]) => args[0] === 'rev-parse' ? `${++heads === 1 ? 'base' : 'next'}\n` : '' })
  return { ...handlers(server), calls }
}
function liteLifecycle() {
  const worktree = root(); const calls = join(worktree, '.lane', 'calls.jsonl'); const counts = join(worktree, '.lane', 'counts.json')
  writeFileSync(calls, ''); writeFileSync(counts, '{}'); process.env.WT_FULL_CALLS = calls; process.env.WT_FULL_COUNTS = counts
  const server = createLifecycleServer({ worktree, route: 'LITE', models: { lane: 'lane', review: 'review' }, cardId: 'edge', sessionTag: 'test', laneLauncher: laneLauncher(), laneWaitMs: 100, gateRunner: ({ log }: { log: string }) => { writeFileSync(log, 'gate\n'); return 0 } })
  return { ...handlers(server), root: worktree }
}
async function gates(lifecycle: { run: (args: Record<string, unknown>) => Promise<string> }) { for (const name of ['typecheck', 'lint', 'test']) await lifecycle.run({ kind: 'gate', name }) }
function edgeConfig(config: Record<string, unknown>) { process.env.WT_EDGE_CONFIG = JSON.stringify(config) }
async function reachReview(lifecycle: ReturnType<typeof fullLifecycle>) {
  edgeConfig({ critic: { verdict: 'approved' } })
  await lifecycle.transition({ phase: 'discovery', tool_use_id: 'discovery' })
  await lifecycle.artifact({ kind: 'plan', content: plan }); await lifecycle.artifact({ kind: 'critic-brief', content: 'critic\n' }); await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' }); await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 }); await lifecycle.transition({ phase: 'critic', outcome: 'approved', tool_use_id: 'critic' })
  await lifecycle.artifact({ kind: 'brief', content: plan }); await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }); await lifecycle.transition({ phase: 'tdd', tool_use_id: 'tdd' })
  await gates(lifecycle); await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify' })
}
async function reviewEdge(verdict: string, exit: number, outcome: string, findings?: string[], noVerdict = false) {
  const lifecycle = fullLifecycle(); await reachReview(lifecycle)
  edgeConfig({ review: { verdict, exit, findings: verdict === 'changes-requested' ? ['finding'] : [], noVerdict } })
  await lifecycle.artifact({ kind: 'review-brief', content: 'review\n' }); await lifecycle.run({ kind: 'lane', phase: 'review', timeout: 1 })
  return lifecycle.transition({ phase: 'review', outcome, findings, tool_use_id: `review-${exit}-${verdict}` })
}
async function criticBound() {
  const lifecycle = fullLifecycle(); edgeConfig({ critic: { verdict: 'changes-requested', findings: ['tighten the proof'] } })
  for (let round = 1; round <= 4; round += 1) {
    await lifecycle.transition({ phase: round === 1 ? 'discovery' : 'plan', tool_use_id: `start-${round}` })
    await lifecycle.artifact({ kind: 'plan', content: plan }); await lifecycle.artifact({ kind: 'critic-brief', content: 'critic\n' }); await lifecycle.transition({ phase: 'plan', tool_use_id: `plan-${round}` }); await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 })
    const result = await lifecycle.transition({ phase: 'critic', outcome: 'changes-requested', findings: ['tighten the proof'], tool_use_id: `critic-${round}` })
    if (round === 4) return result
  }
  throw new Error('unreachable')
}
async function reviewBound() {
  const lifecycle = fullLifecycle(); await reachReview(lifecycle); edgeConfig({ review: { verdict: 'changes-requested', findings: ['finding'] } })
  for (let round = 1; round <= 4; round += 1) {
    await lifecycle.artifact({ kind: 'review-brief', content: 'review\n' }); await lifecycle.run({ kind: 'lane', phase: 'review', timeout: 1 })
    const result = await lifecycle.transition({ phase: 'review', outcome: 'changes-requested', findings: ['finding'], tool_use_id: `review-${round}` }); if (round === 4) return result
    await lifecycle.artifact({ kind: 'harden-brief', content: 'harden\n' }); await lifecycle.run({ kind: 'lane', phase: 'harden', timeout: 1 }); await lifecycle.transition({ phase: 'harden', tool_use_id: `harden-${round}` }); await gates(lifecycle); await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: `verify-${round}` })
  }
  throw new Error('unreachable')
}
async function refutationChangesRequested() {
  const lifecycle = fullLifecycle(); await reachReview(lifecycle)
  edgeConfig({ review: { verdict: 'clear' } })
  await lifecycle.artifact({ kind: 'review-brief', content: 'review\n' }); await lifecycle.run({ kind: 'lane', phase: 'review', timeout: 1 }); await lifecycle.transition({ phase: 'review', outcome: 'clear', tool_use_id: 'review-clear' })
  edgeConfig({ refutation: { verdict: 'changes-requested', findings: ['refute this'] } })
  await lifecycle.artifact({ kind: 'refutation-brief', content: 'refute\n' }); await lifecycle.run({ kind: 'lane', phase: 'refutation', timeout: 1 })
  return lifecycle.transition({ phase: 'refutation', outcome: 'changes-requested', findings: ['refute this'], tool_use_id: 'refutation-change' })
}
async function criticApprovedFailedReceipt() {
  const lifecycle = fullLifecycle(); edgeConfig({ critic: { verdict: 'approved', exit: 1 } })
  await lifecycle.transition({ phase: 'discovery', tool_use_id: 'discovery' })
  await lifecycle.artifact({ kind: 'plan', content: plan }); await lifecycle.artifact({ kind: 'critic-brief', content: 'critic\n' }); await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' }); await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 })
  return lifecycle.transition({ phase: 'critic', outcome: 'approved', tool_use_id: 'critic-failed' })
}
async function reachHarden() {
  const lifecycle = fullLifecycle(); await reachReview(lifecycle)
  edgeConfig({ review: { verdict: 'changes-requested', findings: ['harden this'] } })
  await lifecycle.artifact({ kind: 'review-brief', content: 'review\n' }); await lifecycle.run({ kind: 'lane', phase: 'review', timeout: 1 }); await lifecycle.transition({ phase: 'review', outcome: 'changes-requested', findings: ['harden this'], tool_use_id: 'review-change' })
  await lifecycle.artifact({ kind: 'harden-brief', content: 'harden\n' })
  return lifecycle
}
async function hardenReceipt(exit: number | null) {
  const lifecycle = await reachHarden()
  if (exit !== null) { edgeConfig({ harden: { exit } }); await lifecycle.run({ kind: 'lane', phase: 'harden', timeout: 1 }) }
  return lifecycle.transition({ phase: 'harden', tool_use_id: `harden-${exit ?? 'missing'}` })
}
async function reportEdge(writeReport: boolean, changeGate: boolean) {
  const lifecycle = liteLifecycle()
  await lifecycle.transition({ phase: 'discovery', tool_use_id: 'discovery' }); await lifecycle.artifact({ kind: 'brief', content: 'brief\n' }); await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }); await lifecycle.transition({ phase: 'tdd', tool_use_id: 'tdd' }); await gates(lifecycle); await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'verify' })
  if (writeReport) await lifecycle.artifact({ kind: 'pilot-report', content: '# report\n' })
  if (changeGate) writeFileSync(join(lifecycle.root, '.lane', 'test.log'), 'changed\nEXIT=0\n')
  return lifecycle.transition({ phase: 'report', tool_use_id: 'report' })
}
