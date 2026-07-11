// phase-digest-integration.test.ts — the patterns→observe coupling guard.
//
// Each pattern emits a [wt:digest] line whose `stage` MUST equal the prefix of the
// agent labels it uses, or observe cannot attribute the digest to a phase. That
// coupling is otherwise enforced only by a comment (the shared per-pattern STAGE
// const keeps emit + labels in sync today). This test makes a future desync FAIL:
// it runs each pattern, rebuilds a journal from the SAME run's agent labels (rt.calls)
// + digest line (rt.logs), feeds it through observe's real ingest + fold, and asserts
// the digest resolved to a phase. If a pattern's STAGE drifts from its labels, the
// digest stops resolving and this test goes red.
//
// This is the only place both @workflow-toolbox/patterns and @workflow-toolbox/observe
// are imported together (examples is the sole package depending on both).
//
// SCOPE (honest): this guards the `digest.stage === agent-label prefix` coupling. It
// staples phaseIndex onto the labels rather than threading a real `phase:` opt, so it
// does NOT exercise the OTHER half of resolvePhaseIndex — that the agent labels carry
// their phaseIndex in a real journal. That half is the runtime's job (the sandbox
// assigns phaseIndex from the ambient phase, not the pattern) and is covered by the
// real demo-all-patterns e2e, where all 7 phases resolved from a genuine journal.
// The NEGATIVE test below proves this guard actually trips (it is not a tautology).

import { describe, it, expect } from 'vitest'
import { FakeRuntime, formatDigest } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import {
  classifyAndAct,
  generateAndFilter,
  fanOutAndSynthesize,
  tournament,
  adversarialVerification,
  loopUntilDone,
  planAndExecute,
} from '@workflow-toolbox/patterns'
import { journalToPatches, query } from '@workflow-toolbox/observe'
import type { Phase } from '@workflow-toolbox/observe'

const TT = 1_000_000

/** Rebuild a single-phase journal from a finished FakeRuntime run: every agent
 *  call becomes a phased agent (its real label), and the run's rt.log lines become
 *  the journal logs (carrying the digest). Then fold through observe and return the
 *  one phase. A resolved digest lands as phase.output and/or phase.choices. */
function resolvePhase(rt: FakeRuntime): Phase | undefined {
  const agents = rt.calls.map((c, i) => ({
    type: 'workflow_agent' as const,
    agentId: `a${i}`,
    label: c.opts?.label,
    phaseIndex: 1,
  }))
  const journal = {
    runId: 'r',
    status: 'completed',
    logs: [...rt.logs],
    workflowProgress: [{ type: 'workflow_phase' as const, index: 1 }, ...agents],
  }
  const model = query(journalToPatches(journal as Parameters<typeof journalToPatches>[0], TT), { runId: 'r' })
  return model.phases.get(1)
}

describe('patterns → observe: every pattern emits a digest that resolves to its phase', () => {
  it('classifyAndAct (ghost branches)', async () => {
    const rt = new FakeRuntime({ onAgent: ({ opts }) => (opts?.schema !== undefined ? { category: 'a' } : 'r') })
    await classifyAndAct(rt, {
      items: ['x'],
      categories: ['a', 'b'],
      classifyPrompt: (i) => `classify ${i}`,
      actions: { a: { prompt: (i) => `a ${i}` }, b: { prompt: (i) => `b ${i}` } },
    })
    const phase = resolvePhase(rt)
    expect(phase?.choices?.value).toEqual({ taken: ['a'], notTaken: ['b'], counts: { in: 1, out: 1 } })
  })

  it('generateAndFilter (reject counts)', async () => {
    const rt = new FakeRuntime({ onAgent: ({ opts }) => (opts?.schema !== undefined ? { pass: true, reason: 'ok' } : 'c') })
    await generateAndFilter(rt, { count: 2, generatePrompt: (i) => `gen ${i}`, filterPrompt: (c) => `filter ${c}` })
    const phase = resolvePhase(rt)
    expect(phase?.choices?.value.counts).toEqual({ requested: 2, kept: 2, rejected: 0, failed: 0 })
  })

  it('fanOutAndSynthesize (handoff)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'p' })
    await fanOutAndSynthesize(rt, {
      tasks: ['t'],
      taskPrompt: (t, i) => `task ${i}: ${t}`,
      synthesisPrompt: (parts) => `synth: ${parts.join(',')}`,
    })
    const phase = resolvePhase(rt)
    expect(phase?.output?.value).toBe('synthesis from 1/1 tasks')
  })

  it('tournament (winner vs losers)', async () => {
    const rt = new FakeRuntime({ onAgent: ({ opts }) => (opts?.schema !== undefined ? { score: 1, reason: 'ok' } : 'att') })
    await tournament(rt, {
      angles: ['a', 'b'],
      attemptPrompt: (angle, i) => `attempt ${i}: ${angle}`,
      judgePrompt: (att) => `judge ${att}`,
      synthesisPrompt: (ranked) => `synth ${ranked.length}`,
    })
    const phase = resolvePhase(rt)
    expect(phase?.choices?.value.counts).toEqual({ attempts: 2 })
  })

  it('adversarialVerification (verdict tally)', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ verdict: 'confirmed', reason: 'ok' }) })
    await adversarialVerification(rt, { claims: ['c'], renderClaim: (c) => c, votes: 1, refuteThreshold: 1 })
    const phase = resolvePhase(rt)
    expect(phase?.choices?.value.counts).toEqual({
      claims: 1,
      confirmed: 1,
      refuted: 0,
      partiallyConfirmed: 0,
      unverifiable: 0,
      unverifiedByCap: 0,
    })
  })

  it('loopUntilDone (default label resolves)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'tick' })
    await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 1,
      body: async (loopRt: WorkflowRuntime, state: number) => {
        await loopRt.agent('tick') // no custom label → default loopUntilDone:iter:N
        return { state: state + 1, done: true, progressed: true }
      },
    })
    const phase = resolvePhase(rt)
    expect(phase?.output?.value).toBe('done')
    expect(phase?.choices?.value.counts).toEqual({ iterations: 1 })
  })

  it('loopUntilDone (CUSTOM body label resolves via the ⟲ iteration-marker fallback)', async () => {
    // The flagship dev-* workflows pass their own label into the loop body (e.g.
    // 'dev-implement:green:...'), so the body agents become '<label> ⟲<n>' — they LOSE the
    // 'loopUntilDone:' prefix and the loop's own digest can no longer prefix-resolve. observe
    // attributes it via isLoopIterLabel (the marker fallback). Without that fallback this
    // digest is orphaned (the pre-fix bug). No nested-pattern digest competes for the phase.
    const rt = new FakeRuntime({ onAgent: () => 'fix' })
    await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 1,
      body: async (loopRt: WorkflowRuntime, state: number) => {
        await loopRt.agent('apply fix', { label: 'dev-implement:green:task-1' }) // custom → '... ⟲1'
        return { state: state + 1, done: true, progressed: true }
      },
    })
    const phase = resolvePhase(rt)
    expect(phase?.output?.value).toBe('done')
    expect(phase?.choices?.value.counts).toEqual({ iterations: 1 })
  })

  it('loopUntilDone wrapping a NESTED pattern: the nested digest keeps precedence (no clobber)', async () => {
    // Case 2: the body IS a pattern (generateAndFilter). Its agents keep their
    // 'generateAndFilter:' prefix (the ⟲ marker is appended at the END), so the nested
    // digest prefix-resolves to the phase. The loop's own digest also targets this phase
    // via the marker fallback — but the fallback SKIPS a phase another digest already
    // claimed, so the nested digest wins and is never collide-dropped. The phase must show
    // generateAndFilter's counts, NOT the loop's { iterations }.
    const rt = new FakeRuntime({ onAgent: ({ opts }) => (opts?.schema !== undefined ? { pass: true, reason: 'ok' } : 'c') })
    await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 1,
      body: async (loopRt: WorkflowRuntime, state: number) => {
        await generateAndFilter(loopRt, { count: 1, generatePrompt: (i) => `gen ${i}`, filterPrompt: (c) => `filter ${c}` })
        return { state: state + 1, done: true, progressed: true }
      },
    })
    const phase = resolvePhase(rt)
    expect(phase?.choices?.value.counts).toEqual({ requested: 1, kept: 1, rejected: 0, failed: 0 })
  })

  it('planAndExecute (planned vs executed)', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (opts?.schema !== undefined ? { subtasks: [{ description: 's' }] } : 'w'),
    })
    await planAndExecute(rt, {
      planPrompt: 'plan it',
      workerPrompt: (s, i) => `work ${i}: ${s.description}`,
      synthesisPrompt: (r) => `synth ${r.join(',')}`,
    })
    const phase = resolvePhase(rt)
    expect(phase?.choices?.value.counts).toEqual({ planned: 1, executed: 1, dropped: 0, truncated: 0 })
  })

  it('NEGATIVE: a digest whose stage matches no agent label does NOT resolve (guard trips)', () => {
    // Simulate a STAGE↔label desync: the digest claims stage 'classifyAndAct' but the
    // only agent is labelled 'somethingElse:...'. resolvePhaseIndex must find no match,
    // so NO phase.output/phase.choices is produced — exactly what goes red if a future
    // rename desyncs a pattern's STAGE from its labels.
    const journal = {
      runId: 'r',
      status: 'completed',
      logs: [formatDigest({ stage: 'classifyAndAct', taken: ['a'], notTaken: ['b'] })],
      workflowProgress: [
        { type: 'workflow_phase' as const, index: 1 },
        { type: 'workflow_agent' as const, agentId: 'a0', label: 'somethingElse:classify:0', phaseIndex: 1 },
      ],
    }
    const model = query(journalToPatches(journal as Parameters<typeof journalToPatches>[0], TT), { runId: 'r' })
    expect(model.phases.get(1)?.choices).toBeUndefined()
    expect(model.phases.get(1)?.output).toBeUndefined()
  })
})
