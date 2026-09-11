import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error shipped Function Hook module
import { createLifecycle } from '../../../../plugin/hooks-modules/sdk-pilot-lifecycle/hooks/hooks.js'

async function lifecycle() {
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler>()
  const store = new Map<string, unknown>()
  createLifecycle((event: string, filter: unknown, handler?: Handler) => handlers.set(event === 'tool.call' ? `${event}:${(filter as { tool: string }).tool}` : event, handler ?? filter as Handler))
  const writes = new Map<string, string>()
  const $ = { session: { id: async () => 'session-1' }, store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => store.set(key, value) }, fs: { writeFile: async (file: string, content: string) => writes.set(file, content) } }
  const start = handlers.get('session.start')!
  await start({ ...$, tool: { register: async () => {} } }, { cwd: '/worktree' }, (value: unknown) => value)
  const transition = handlers.get('tool.call:mcp__sdk-pilot-lifecycle__transition')!
  const write = handlers.get('tool.call:mcp__sdk-pilot-lifecycle__write_artifact')!
  const bash = handlers.get('tool.call:Bash')!
  return { transition, write, bash, $, writes }
}

describe('sdk pilot lifecycle', () => {
  it('refuses a phase skip, preserves duplicate idempotency, and reaches awaiting_fidelity on LITE', async () => {
    const { transition, $ } = await lifecycle()
    expect(await transition($, { phase: 'plan', tool_use_id: 'skip' })).toMatchObject({ deny: expect.stringContaining('required=discovery') })
    expect(await transition($, { phase: 'discovery', route: 'LITE', tool_use_id: 'd' })).toMatchObject({ result: expect.stringContaining('accepted') })
    expect(await transition($, { phase: 'discovery', route: 'LITE', tool_use_id: 'd' })).toMatchObject({ result: expect.stringContaining('idempotent') })
    expect(await transition($, { phase: 'tdd', tool_use_id: 't' })).toMatchObject({ result: expect.stringContaining('accepted') })
    expect(await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' })).toMatchObject({ result: expect.stringContaining('accepted') })
    expect(await transition($, { phase: 'report', gate_receipts: [{ name: 'test', exit: 0 }], tool_use_id: 'r' })).toMatchObject({ result: expect.stringContaining('awaiting_fidelity') })
  })

  it('requires the full plan/critic loop and rejects a fourth requested revision', async () => {
    const { transition, $ } = await lifecycle()
    await transition($, { phase: 'discovery', route: 'FULL', tool_use_id: 'd' })
    for (let round = 1; round <= 2; round += 1) {
      await transition($, { phase: 'plan', tool_use_id: `p${round}` })
      const result = await transition($, { phase: 'critic', outcome: 'changes-requested', tool_use_id: `c${round}` })
      expect(result).toMatchObject({ result: expect.stringContaining('accepted') })
    }
    // three revision rounds are accepted; the FOURTH is refused
    await transition($, { phase: 'plan', tool_use_id: 'p3' })
    expect(await transition($, { phase: 'critic', outcome: 'changes-requested', tool_use_id: 'c3' })).toMatchObject({ result: expect.stringContaining('accepted') })
    await transition($, { phase: 'plan', tool_use_id: 'p4' })
    expect(await transition($, { phase: 'critic', outcome: 'changes-requested', tool_use_id: 'c4' })).toMatchObject({ deny: expect.stringContaining('round limit') })
  })

  it('requires review findings, refutation, and real green gate receipts on FULL', async () => {
    const { transition, $ } = await lifecycle()
    await transition($, { phase: 'discovery', route: 'FULL', tool_use_id: 'd' })
    await transition($, { phase: 'plan', tool_use_id: 'p' })
    await transition($, { phase: 'critic', outcome: 'approved', tool_use_id: 'c' })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' })
    expect(await transition($, { phase: 'review', outcome: 'clear', tool_use_id: 'r' })).toMatchObject({ deny: expect.stringContaining('required=review') })
    await transition($, { phase: 'review', outcome: 'clear', findings: [], tool_use_id: 'r2' })
    expect(await transition($, { phase: 'report', gate_receipts: [{ name: 'test', exit: 0 }], tool_use_id: 'skip' })).toMatchObject({ deny: expect.stringContaining('required=refutation') })
    await transition($, { phase: 'refutation', outcome: 'clear', findings: [], tool_use_id: 'f' })
    expect(await transition($, { phase: 'report', gate_receipts: [{ name: 'test', exit: 1 }], tool_use_id: 'bad-gate' })).toMatchObject({ deny: expect.stringContaining('required=report') })
    expect(await transition($, { phase: 'report', gate_receipts: [{ name: 'test', exit: 0 }], tool_use_id: 'good-gate' })).toMatchObject({ result: expect.stringContaining('awaiting_fidelity') })
  })

  it('permits only fixed lifecycle artifacts and the phase-specific Bash allow-list', async () => {
    const { transition, write, bash, $, writes } = await lifecycle()
    const next = (value: unknown) => ({ allowed: value })
    expect(await write($, { kind: 'pilot-report', content: 'forged' })).toMatchObject({ deny: expect.stringContaining('phase=discovery') })
    expect(await bash($, { command: 'node -e fs.writeFileSync' }, next)).toMatchObject({ deny: expect.stringContaining('unavailable') })
    expect(await bash($, { command: 'git -C /worktree commit -m early' }, next)).toMatchObject({ deny: expect.stringContaining('phase=discovery') })
    await transition($, { phase: 'discovery', route: 'LITE', tool_use_id: 'd' })
    expect(await write($, { kind: 'brief', content: '# brief' })).toMatchObject({ result: expect.stringContaining('wrote brief') })
    expect(writes.get('/worktree/.lane/brief.md')).toBe('# brief')
    expect(await bash($, { command: 'node plugin/bin/wt-lane.mjs --dir /elsewhere --model openai/gpt-5.6-terra --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ deny: expect.stringContaining('phase=tdd') })
    expect(await bash($, { command: 'node plugin/bin/wt-lane.mjs --dir /worktree --model other --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ deny: expect.stringContaining('phase=tdd') })
    expect(await bash($, { command: 'node plugin/bin/wt-lane.mjs --dir /worktree --model openai/gpt-5.6-terra --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ allowed: expect.anything() })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' })
    expect(await write($, { kind: 'pilot-report', content: 'early' })).toMatchObject({ deny: expect.stringContaining('phase=report') })
    await transition($, { phase: 'report', gate_receipts: [{ name: 'test', exit: 0 }], tool_use_id: 'r' })
    expect(await write($, { kind: 'pilot-report', content: '# final' })).toMatchObject({ result: expect.stringContaining('wrote pilot-report') })
    expect(await bash($, { command: 'echo pid=1 log=.lane/fake.log' }, next)).toMatchObject({ deny: expect.stringContaining('unavailable') })
  })

  it('refuses control characters in an otherwise-allowed Bash command', async () => {
    const { transition, bash, $ } = await lifecycle()
    const next = (value: unknown) => ({ allowed: value })
    await transition($, { phase: 'discovery', route: 'LITE', tool_use_id: 'd' })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' })
    // an allowed prefix followed by a newline is simply a second command to the shell
    expect(await bash($, { command: 'git -C /worktree commit -m ok\nnode -e "x"' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'git -C /worktree commit -m ok\tnode evil.mjs' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'git -C /worktree commit -m real work' }, next)).toMatchObject({ allowed: expect.anything() })
  })

  it('bounds review rounds across harden, which must not reset the counter', async () => {
    const { transition, $ } = await lifecycle()
    await transition($, { phase: 'discovery', route: 'FULL', tool_use_id: 'd' })
    await transition($, { phase: 'plan', tool_use_id: 'p' })
    await transition($, { phase: 'critic', outcome: 'approved', tool_use_id: 'c' })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v0' })
    let last: unknown = null
    for (let round = 1; round <= 4; round += 1) {
      last = await transition($, { phase: 'review', outcome: 'changes-requested', findings: ['f'], tool_use_id: 'r' + round })
      if (round === 3) expect(last).toMatchObject({ result: expect.stringContaining('accepted') })
      if (round < 4) {
        await transition($, { phase: 'refutation', outcome: 'changes-requested', findings: ['f'], tool_use_id: 'x' + round })
        await transition($, { phase: 'harden', tool_use_id: 'h' + round })
        await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' + round })
      }
    }
    expect(last).toMatchObject({ deny: expect.stringContaining('round limit') })
  })

  // `[].every()` is TRUE, so the bare shape check accepted a `changes-requested` naming NOTHING:
  // a revision round that cannot be actioned, bounded or disputed, consuming one of the three
  // rounds while recording no reason. These three cases are separate tests ON PURPOSE — a red run
  // stops at its first failing assertion, so locking them together would prove only the first.
  const toReview = async () => {
    const { transition, $ } = await lifecycle()
    await transition($, { phase: 'discovery', route: 'FULL', tool_use_id: 'd' })
    await transition($, { phase: 'plan', tool_use_id: 'p' })
    await transition($, { phase: 'critic', outcome: 'approved', tool_use_id: 'c' })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v0' })
    return { transition, $ }
  }

  it('denies a changes-requested review that names no findings at all', async () => {
    const { transition, $ } = await toReview()
    expect(await transition($, { phase: 'review', outcome: 'changes-requested', findings: [], tool_use_id: 'r1' }))
      .toMatchObject({ deny: expect.stringContaining('required=review') })
  })

  it('denies a changes-requested review whose only finding is whitespace', async () => {
    const { transition, $ } = await toReview()
    expect(await transition($, { phase: 'review', outcome: 'changes-requested', findings: ['   '], tool_use_id: 'r1' }))
      .toMatchObject({ deny: expect.stringContaining('required=review') })
  })

  // The REGRESSION half, and the reason the fix is outcome-aware rather than a blanket non-empty
  // check: `clear` gates through the same predicate, and a clean review that found nothing is the
  // healthy outcome. Requiring findings everywhere would deny exactly the case worth celebrating.
  it('still accepts a clear review that legitimately found nothing', async () => {
    const { transition, $ } = await toReview()
    expect(await transition($, { phase: 'review', outcome: 'clear', findings: [], tool_use_id: 'r1' }))
      .toMatchObject({ result: expect.stringContaining('accepted phase=refutation') })
  })

  it('declares the engine entry point inline, because an aliased register export silently registers nothing', () => {
    // The engine resolves the `register` export itself. `export const register = createLifecycle`
    // loaded the plugin and registered no hooks and no tools, while every test here stayed green:
    // these tests import the binding directly and never exercise the loader. This lock cannot reach
    // the loader either — it refuses the regression at the only place a unit test can see it.
    const source = readFileSync(new URL('../../../../plugin/hooks-modules/sdk-pilot-lifecycle/hooks/hooks.js', import.meta.url), 'utf8')
    expect(source).toMatch(/export const register = \(on\) =>/)
    expect(source).not.toMatch(/export const register = [A-Za-z_$][\w$]*\s*$/m)
  })

  it('pins the commit repository and accepts the launcher path the runner actually emits', async () => {
    const { transition, bash, $ } = await lifecycle()
    const next = (value: unknown) => ({ allowed: value })
    await transition($, { phase: 'discovery', route: 'LITE', tool_use_id: 'd' })
    // pilot-runner-core.mjs:129 tells the pilot to launch with an ABSOLUTE launcher path.
    expect(await bash($, { command: 'node /opt/wt/plugin/bin/wt-lane.mjs --dir /worktree --model openai/gpt-5.6-terra --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ allowed: expect.anything() })
    // the safety-relevant arguments stay pinned to this worktree whatever the launcher path
    expect(await bash($, { command: 'node /opt/wt/plugin/bin/wt-lane.mjs --dir /elsewhere --model openai/gpt-5.6-terra --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'node /opt/wt/plugin/bin/wt-lane.mjs --dir /worktree --model openai/gpt-5.6-terra --brief /elsewhere/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'node /opt/wt/plugin/bin/evil.mjs --dir /worktree --model openai/gpt-5.6-terra --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'node /opt/wt/plugin/bin/wt-lane.mjs --dir /worktree --model openai/gpt-5.6-sol --brief /worktree/.lane/brief.md --timeout 5400' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'node /opt/wt/plugin/bin/wt-lane.mjs --dir /worktree --model openai/gpt-5.6-terra --brief /worktree/.lane/brief.md --timeout 10800' }, next)).toMatchObject({ allowed: expect.anything() })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' })
    expect(await bash($, { command: 'git -C /elsewhere commit -m sneak' }, next)).toMatchObject({ deny: expect.any(String) })
    expect(await bash($, { command: 'git -C /worktree commit -m real' }, next)).toMatchObject({ allowed: expect.anything() })
  })

  it('denies source writes before Discovery approval, Critic approval, Refutation, and fidelity', async () => {
    const { transition, bash, $ } = await lifecycle()
    const next = (value: unknown) => ({ allowed: value })
    const sourceWrite = { command: 'node -e process.exit' }
    expect(await bash($, sourceWrite, next)).toMatchObject({ deny: expect.any(String) })
    await transition($, { phase: 'discovery', route: 'FULL', tool_use_id: 'd' })
    await transition($, { phase: 'plan', tool_use_id: 'p' })
    expect(await bash($, sourceWrite, next)).toMatchObject({ deny: expect.stringContaining('phase=critic') })
    await transition($, { phase: 'critic', outcome: 'approved', tool_use_id: 'c' })
    await transition($, { phase: 'tdd', tool_use_id: 't' })
    await transition($, { phase: 'verify', outcome: 'passed', tool_use_id: 'v' })
    expect(await bash($, sourceWrite, next)).toMatchObject({ deny: expect.stringContaining('phase=review') })
    await transition($, { phase: 'review', outcome: 'clear', findings: [], tool_use_id: 'r' })
    await transition($, { phase: 'refutation', outcome: 'clear', findings: [], tool_use_id: 'f' })
    await transition($, { phase: 'report', gate_receipts: [{ name: 'test', exit: 0 }], tool_use_id: 'g' })
    expect(await bash($, sourceWrite, next)).toMatchObject({ deny: expect.stringContaining('phase=awaiting_fidelity') })
  })
})
