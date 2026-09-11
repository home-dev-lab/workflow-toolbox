import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { deriveRoute } from '../../../../plugin/bin/lib/route-from-card.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { treeSignature } from '../../../../plugin/bin/lib/gate-evidence.mjs'

describe('runner-hosted SDK pilot lifecycle', () => {
  it.each([
    ['human lite wins', 'Route: LITE\nType: feature\nRisk: guard', 'LITE'],
    ['human full wins', 'Route: FULL\nType: chore\nDoD: green', 'FULL'],
    ['medium effort', 'Effort: M\nDoD: green', 'FULL'],
    ['large effort', 'Effort: L\nDoD: green', 'FULL'],
    ['extra large effort', 'Effort: XL\nDoD: green', 'FULL'],
    ['feature type', 'Type: feature\nDoD: green', 'FULL'],
    ['risk signal', 'Risk: guard\nDoD: green', 'FULL'],
    ['security signal', 'Risk: security\nDoD: green', 'FULL'],
    ['public surface signal', 'Risk: public surface\nDoD: green', 'FULL'],
    ['migration signal', 'Risk: migration\nDoD: green', 'FULL'],
    ['destructive signal', 'Risk: destructive\nDoD: green', 'FULL'],
    ['unsafe signal', 'Risk: unsafe\nDoD: green', 'FULL'],
    ['four named files', 'Files: a.mjs, b.mjs, c.mjs, d.mjs\nDoD: green', 'FULL'],
    ['no DoD is doubt', 'Type: chore\nEffort: S', 'FULL'],
    ['clear small chore', 'Type: chore\nEffort: S\nFiles: a.mjs\nDoD: green', 'LITE'],
    ['clear small docs', 'Type: docs\nEffort: S\nFiles: readme.md\nDoD: green', 'LITE'],
    ['case insensitive route', 'route: full\nDoD: green', 'FULL'],
    ['case insensitive feature', 'type: FEATURE\nDoD: green', 'FULL'],
    ['risk word in prose', 'This carries a guard change.\nDoD: green', 'FULL'],
    ['three files remain lite', 'Files: a.mjs, b.mjs, c.mjs\nDoD: green', 'LITE'],
    ['missing card is doubt', '', 'FULL'],
    ['route line whitespace', '  Route: LITE  \nDoD: green', 'LITE'],
    ['explicit route beats no DoD', 'Route: LITE', 'LITE'],
    ['explicit route beats file count', 'Route: LITE\nFiles: a.mjs, b.mjs, c.mjs, d.mjs', 'LITE'],
  ])('routes %s', (_name, card, expected) => {
    expect(deriveRoute(card).route).toBe(expected)
  })

  it('routes card signals mechanically, with a human override first', () => {
    expect(deriveRoute('Route: LITE\nType: feature\nRisk: guard')).toMatchObject({ route: 'LITE', reasons: ['human Route: LITE'] })
    expect(deriveRoute('Type: feature')).toMatchObject({ route: 'FULL' })
    expect(deriveRoute('Effort: M')).toMatchObject({ route: 'FULL' })
    expect(deriveRoute('Risk: guard')).toMatchObject({ route: 'FULL' })
    expect(deriveRoute('Files: a.mjs, b.mjs, c.mjs, d.mjs')).toMatchObject({ route: 'FULL' })
    expect(deriveRoute('Type: chore\nEffort: S\nFiles: a.mjs\nDoD: green')).toMatchObject({ route: 'LITE' })
  })

  it('routes the two archived real cards from their copied fixtures', () => {
    expect(deriveRoute(readFileSync(new URL('./fixtures/typescript-lsp-card.md', import.meta.url), 'utf8')).route).toBe('LITE')
    expect(deriveRoute(readFileSync(new URL('./fixtures/intake-triage-card.md', import.meta.url), 'utf8')).route).toBe('FULL')
  })

  it('builds the immutable three-tool MCP server', () => {
    const worktree = new URL('../../../..', import.meta.url).pathname
    rmSync(`${worktree}/.lane/route.json`, { force: true })
    const server = createLifecycleServer({ worktree, route: 'LITE', models: { lane: 'sonnet' }, cardId: '123', sessionTag: 's' })
    expect(server.type).toBe('sdk')
    expect(server.name).toBe('sdk-pilot-lifecycle')
    expect(Object.isFrozen(server.lifecycle)).toBe(true)
    expect(server.lifecycle.route).toBe('LITE')
    expect(Object.keys(server.instance._registeredTools).sort()).toEqual(['run', 'transition', 'write_artifact'])
  })

  it.each(['plan', 'critic-brief', 'brief', 'review-brief', 'refutation-brief', 'harden-brief', 'pilot-report'])('refuses artifact %s outside its sole phase', async (kind) => {
    const lifecycle = testLifecycle('LITE')
    expect(await text(lifecycle.artifact({ kind, content: 'content' }))).toMatch(/^edge refused: discovery->next; missing .*: /)
  })

  it.each(['bogus', 'gate', 'inspect'])('refuses run kind %s with a named missing item and path', async (kind) => {
    const lifecycle = testLifecycle('LITE')
    expect(await text(lifecycle.run({ kind }))).toMatch(/^edge refused: discovery->next; missing .*: /)
  })

  it.each(['format', 'build', ''])('refuses a gate outside typecheck, lint, and test', async (name) => {
    const lifecycle = testLifecycle('LITE')
    expect(await text(lifecycle.run({ kind: 'gate', name }))).toMatch(/^edge refused: discovery->next; missing gate typecheck\|lint\|test: /)
  })

  it.each(['tree', 'tail', ''])('refuses an inspect target outside the fixed table', async (what) => {
    const lifecycle = testLifecycle('LITE')
    expect(await text(lifecycle.run({ kind: 'inspect', what }))).toMatch(/^edge refused: discovery->next; missing inspect diff\|status\|log: /)
  })

  it('refuses a discovery route that conflicts with runner evidence', async () => {
    const lifecycle = testLifecycle('LITE', ['all LITE signals clear'])
    expect(await text(lifecycle.transition({ phase: 'discovery', route: 'FULL', tool_use_id: 'route' })))
      .toContain('missing runner route LITE (all LITE signals clear):')
  })

  it('waits for a detached launcher to write its terminal marker before attesting', async () => {
    const lifecycle = testLifecycle('LITE', [], delayedLauncher(), 250)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
    const started = Date.now()
    expect(await text(lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }))).toBe('lane tdd EXIT=0')
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
    const evidence = JSON.parse(readFileSync(join(lifecycle.root, '.lane', 'evidence.json'), 'utf8'))
    expect(evidence.entries[join(lifecycle.root, '.lane', 'tdd-run.log')].exit).toBe('0')
  })

  it('attests a missing terminal marker and refuses the corresponding edge', async () => {
    const lifecycle = testLifecycle('LITE', [], emptyLauncher(), 30)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
    expect(await text(lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }))).toBe('lane tdd EXIT=missing')
    expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'verify' }))).toMatch(/^edge refused: tdd->next; missing lane receipt unchanged: /)
  })

  it('refuses a lane receipt with an empty report', async () => {
    const lifecycle = testLifecycle('LITE', [], logOnlyLauncher(), 100)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
    await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
    expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'verify' }))).toMatch(/^edge refused: tdd->next; missing non-empty unchanged lane report: /)
  })

  it.each(['typecheck', 'lint', 'test'])('refuses verify when %s has EXIT=1', async (name) => {
    const lifecycle = await lifecycleAtVerify()
    await writeGates(lifecycle, { [name]: { exit: '1' } })
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: name }))).toMatch(/^edge refused: verify->next; missing gate receipt EXIT=1: /)
  })

  it('refuses verify with a gate older than the lane receipt', async () => {
    const lifecycle = await lifecycleAtVerify()
    await writeGates(lifecycle, { test: { mtime: 0 } })
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'old' }))).toMatch(/^edge refused: verify->next; missing unchanged gate receipt: /)
  })

  it('refuses verify after the working tree signature changes', async () => {
    const lifecycle = await lifecycleAtVerify()
    await writeGates(lifecycle)
    writeFileSync(join(lifecycle.root, 'changed.txt'), 'changed\n')
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'changed' }))).toMatch(/^edge refused: verify->next; missing current tree signature: /)
  })

  it('persists verify digests and refuses a report edge when a gate changes afterward', async () => {
    const lifecycle = await lifecycleAtVerify()
    await writeGates(lifecycle)
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'passed' }))).toBe('accepted phase=report')
    const evidence = JSON.parse(readFileSync(join(lifecycle.root, '.lane', 'evidence.json'), 'utf8'))
    expect(evidence.verify_snapshot).toMatchObject({ tree: treeSignature(lifecycle.root) })
    writeFileSync(join(lifecycle.root, '.lane', 'test.log'), 'gate\nEXIT=0\nchanged\n')
    writeFileSync(join(lifecycle.root, '.lane', 'pilot-report.md'), '# report\n')
    await expect(text(lifecycle.transition({ phase: 'report', tool_use_id: 'report' })))
      .resolves.toMatch(/missing gate digest changed .*?[a-f0-9]{64}.*[a-f0-9]{64}.*test\.log/)
  })

  it.each([
    ['failed commit', () => (_program: string, call: string[]) => { if (call[0] === 'commit') throw new Error('commit failed'); return call[0] === 'rev-parse' ? 'base\n' : '' }, /missing commit \(commit failed\)/],
    ['unchanged HEAD', () => (_program: string, call: string[]) => call[0] === 'rev-parse' ? 'base\n' : '', /missing changed HEAD/],
    ['dirty tree', () => { let revisions = 0; return (_program: string, call: string[]) => call[0] === 'status' ? ' M changed.txt\n' : call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : '' }, /missing clean tree/],
  ])('refuses report->awaiting_fidelity on %s', async (_name, makeGit, expected) => {
    const lifecycle = await lifecycleReadyForReport({ git: makeGit() })
    await expect(text(lifecycle.transition({ phase: 'report', tool_use_id: 'report' }))).resolves.toMatch(expected)
  })

  it('refuses report->awaiting_fidelity when the archive copy fails', async () => {
    let revisions = 0
    const git = (_program: string, call: string[]) => call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : ''
    const lifecycle = await lifecycleReadyForReport({ git, copy: () => { throw new Error('destination not writable') } })
    await expect(text(lifecycle.transition({ phase: 'report', tool_use_id: 'report' })))
      .resolves.toMatch(/missing archive \(destination not writable\)/)
  })

  it('retries an archive failure without making a second commit', async () => {
    let revisions = 0; let commits = 0; let copies = 0
    const git = (_program: string, call: string[]) => {
      if (call[0] === 'commit') commits += 1
      return call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : ''
    }
    const copy = (...args: Parameters<typeof cpSync>) => { copies += 1; if (copies === 1) throw new Error('temporary archive failure'); return cpSync(...args) }
    const lifecycle = await lifecycleReadyForReport({ git, copy })
    expect(await text(lifecycle.transition({ phase: 'report', tool_use_id: 'first' }))).toContain('missing archive')
    expect(await text(lifecycle.transition({ phase: 'report', tool_use_id: 'retry' }))).toBe('accepted phase=awaiting_fidelity')
    expect(commits).toBe(1)
  })

  it('records the commit, archive manifest digest, and lifecycle implementation', async () => {
    let revisions = 0
    const git = (_program: string, call: string[]) => call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : ''
    const lifecycle = await lifecycleReadyForReport({ git })
    expect(await text(lifecycle.transition({ phase: 'report', tool_use_id: 'report' }))).toBe('accepted phase=awaiting_fidelity')
    const summary = JSON.parse(readFileSync(join(lifecycle.root, '.lane', 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({ commit: 'next', lifecycle_implementation: { name: 'sdk-pilot-lifecycle', version: '1.0.0' } })
    expect(summary.archive).toMatchObject({ path: expect.stringContaining('.claude/reports/1-'), manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('maps the real tdd brief artifact to the real lane launch argument', async () => {
    const recorded = launcher("import { appendFileSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; appendFileSync(process.env.CALLS, process.argv.join(' ') + '\\n'); appendFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), 'report\\n')")
    const lifecycle = testLifecycle('LITE', [], recorded, 100)
    process.env.CALLS = join(lifecycle.root, 'calls')
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'brief', content: 'brief\n' })
    await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
    expect(readFileSync(join(lifecycle.root, 'calls'), 'utf8')).toContain(`--brief ${join(lifecycle.root, '.lane', 'tdd-brief.md')}`)
  })

  it('refuses traversal and absolute inspect log names', async () => {
    const lifecycle = testLifecycle('LITE')
    for (const name of ['../../x', '/tmp/x']) expect(await text(lifecycle.run({ kind: 'inspect', what: 'log', name }))).toContain('missing log name')
  })

  it('requires a DoD for every plan task and injects the plan digest into the critic brief', async () => {
    const lifecycle = testLifecycle('FULL')
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    const incomplete = '## ADR\nDecision: x\nRejected: y\n## Tasks\n- one\nDoD: first\n- two\n## Gates\n- test\n'
    await lifecycle.artifact({ kind: 'plan', content: incomplete })
    expect(await text(lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' }))).toContain('missing valid plan artifact')
    const plan = incomplete.replace('- two\n', '- two\nDoD: second\n')
    await lifecycle.artifact({ kind: 'plan', content: plan })
    await lifecycle.artifact({ kind: 'critic-brief', content: 'review this\n' })
    expect(readFileSync(join(lifecycle.root, '.lane', 'critic-brief.md'), 'utf8')).toContain(`plan sha256: ${createHash('sha256').update(plan).digest('hex')}`)
  })

  it('derives the critic verdict from its attested report and rejects a pilot mismatch', async () => {
    const lifecycle = testLifecycle('FULL', [], verdictLauncher(), 100)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'plan', content: '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task. DoD: green\n## Gates\n- test\n' })
    await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' })
    await lifecycle.artifact({ kind: 'critic-brief', content: 'review\n' })
    await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 })
    expect(await text(lifecycle.transition({ phase: 'critic', outcome: 'approved', tool_use_id: 'mismatch' })))
      .toContain('outcome does not match the lane report')
    expect(await text(lifecycle.transition({ phase: 'critic', outcome: 'changes-requested', findings: ['blocker'], tool_use_id: 'matching' })))
      .toBe('accepted phase=plan')
  })

  it('requires every form of the attested verdict contract and appends it to review briefs', async () => {
    const lifecycle = testLifecycle('FULL', [], verdictLauncher(), 100)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'plan', content: '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task. DoD: green\n## Gates\n- test\n' })
    await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' })
    await lifecycle.artifact({ kind: 'critic-brief', content: 'review\n' })
    await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 1 })
    expect(await text(lifecycle.transition({ phase: 'critic', outcome: 'approved', tool_use_id: 'wrong' }))).toContain('outcome does not match the lane report')

    const missing = testLifecycle('FULL', [], successLauncher(), 100)
    await missing.transition({ phase: 'discovery', tool_use_id: 'start' })
    await missing.artifact({ kind: 'plan', content: '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task. DoD: green\n## Gates\n- test\n' })
    await missing.transition({ phase: 'plan', tool_use_id: 'plan' })
    await missing.artifact({ kind: 'critic-brief', content: 'review\n' })
    await missing.run({ kind: 'lane', phase: 'critic', timeout: 1 })
    expect(await text(missing.transition({ phase: 'critic', tool_use_id: 'missing' }))).toContain('VERDICT block')

    const empty = testLifecycle('FULL', [], launcher("import { appendFileSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; appendFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), 'VERDICT: changes-requested\\nFINDINGS:\\n')"), 100)
    await empty.transition({ phase: 'discovery', tool_use_id: 'start' })
    await empty.artifact({ kind: 'plan', content: '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task. DoD: green\n## Gates\n- test\n' })
    await empty.transition({ phase: 'plan', tool_use_id: 'plan' })
    await empty.artifact({ kind: 'critic-brief', content: 'review\n' })
    await empty.run({ kind: 'lane', phase: 'critic', timeout: 1 })
    expect(await text(empty.transition({ phase: 'critic', tool_use_id: 'empty' }))).toContain('VERDICT block')
  })

  it('refuses a symlinked lane report and a symlinked .lane directory', async () => {
    const lifecycle = testLifecycle('LITE', [], successLauncher(), 100)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'brief', content: 'brief\n' })
    await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
    rmSync(join(lifecycle.root, '.lane', 'tdd-report.md'))
    symlinkSync(join(lifecycle.root, '.gitignore'), join(lifecycle.root, '.lane', 'tdd-report.md'))
    expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'symlink' }))).toContain('non-empty unchanged lane report')

    const root = mkdtempSync(join(tmpdir(), 'wt-lifecycle-link-')); roots.push(root)
    mkdirSync(join(root, 'actual'))
    symlinkSync(join(root, 'actual'), join(root, '.lane'))
    writeFileSync(join(root, '.gitignore'), '.lane/\n.claude/reports/\n')
    spawnSync('git', ['init', '-q'], { cwd: root })
    expect(() => createLifecycleServer({ worktree: root, route: 'LITE', models: {}, cardId: '1', sessionTag: 'x' }))
      .toThrow(/\.lane must be a real directory/)
  })

  it('refuses symlinked gate and inspect receipts without following them', async () => {
    const lifecycle = testLifecycle('LITE')
    symlinkSync(join(lifecycle.root, '.gitignore'), join(lifecycle.root, '.lane', 'test.log'))
    expect(await text(lifecycle.run({ kind: 'gate', name: 'test' }))).toContain('regular gate receipt')
    rmSync(join(lifecycle.root, '.lane', 'test.log'))
    symlinkSync(join(lifecycle.root, '.gitignore'), join(lifecycle.root, '.lane', 'lint.log'))
    expect(await text(lifecycle.run({ kind: 'inspect', what: 'log', name: 'lint.log' }))).toContain('regular inspect log')
  })

  it('does not trust tampered audit evidence or a changed lane report', async () => {
    const lifecycle = testLifecycle('LITE', [], successLauncher(), 100)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'brief', content: 'brief\n' })
    await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-report.md'), 'tampered\n')
    expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'tampered' }))).toContain('non-empty unchanged lane report')
    const clean = testLifecycle('LITE', [], successLauncher(), 100)
    await clean.transition({ phase: 'discovery', tool_use_id: 'start' }); await clean.artifact({ kind: 'brief', content: 'brief\n' }); await clean.run({ kind: 'lane', phase: 'tdd', timeout: 1 }); await clean.transition({ phase: 'tdd', tool_use_id: 'tdd' })
    await writeGates(clean)
    writeFileSync(join(clean.root, '.lane', 'evidence.json'), '{"entries":{}}\n')
    expect(await text(clean.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'audit' }))).toBe('accepted phase=report')
  })

  it('removes stale receipts before launch and refuses to attest them', async () => {
    const lifecycle = testLifecycle('LITE', [], emptyLauncher(), 30)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-run.log'), 'old\nEXIT=0\n')
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-report.md'), 'old\n')
    expect(await text(lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }))).toBe('lane tdd EXIT=missing')
  })

  it('does not attest a foreign receipt without the launch nonce', async () => {
    const lifecycle = testLifecycle('LITE', [], foreignThenGenuineLauncher(), 250)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'brief', content: 'brief\n' })
    expect(await text(lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }))).toBe('lane tdd EXIT=0')
    const evidence = JSON.parse(readFileSync(join(lifecycle.root, '.lane', 'evidence.json'), 'utf8'))
    expect(evidence.entries[join(lifecycle.root, '.lane', 'tdd-run.log')].exit).toBe('0')
  })

  it('does not attest a receipt from another launch nonce', async () => {
    const lifecycle = testLifecycle('LITE', [], launcher("import { writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; writeFileSync(log, 'LANE_NONCE=other\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), 'report\\n')"), 30)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    await lifecycle.artifact({ kind: 'brief', content: 'brief\n' })
    expect(await text(lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 }))).toBe('lane tdd EXIT=missing')
  })

  it('resets a failed pre-commit index and removes failed archive temporary directories', async () => {
    const calls: string[] = []
    const git = (_program: string, call: string[]) => {
      calls.push(call[0]!)
      if (call[0] === 'commit') throw new Error('commit failed')
      return call[0] === 'rev-parse' ? 'base\n' : ''
    }
    const failed = await lifecycleReadyForReport({ git })
    await failed.transition({ phase: 'report', tool_use_id: 'report' })
    expect(calls).toContain('reset')

    let revisions = 0
    const archive = await lifecycleReadyForReport({ git: (_program: string, call: string[]) => call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : '', copy: () => { throw new Error('copy failed') } })
    await archive.transition({ phase: 'report', tool_use_id: 'report' })
    expect(readdirSync(join(archive.root, '.claude', 'reports')).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('does not commit again after post-commit status throws', async () => {
    let revisions = 0; let commits = 0; let statusReads = 0
    const git = (_program: string, call: string[]) => {
      if (call[0] === 'commit') commits += 1
      if (call[0] === 'status' && ++statusReads === 1) throw new Error('status unavailable')
      return call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : ''
    }
    const lifecycle = await lifecycleReadyForReport({ git })
    expect(await text(lifecycle.transition({ phase: 'report', tool_use_id: 'first' }))).toContain('missing archive')
    expect(await text(lifecycle.transition({ phase: 'report', tool_use_id: 'retry' }))).toBe('accepted phase=awaiting_fidelity')
    expect(commits).toBe(1)
  })

  it('accepts the card plan grammar and distinguishes top-level tasks from nested bullets', async () => {
    const lifecycle = testLifecycle('FULL')
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    expect(await text(lifecycle.artifact({ kind: 'plan', content: readFileSync(new URL('./fixtures/mechanical-cycle-plan.md', import.meta.url), 'utf8') }))).toBe('wrote plan')
    expect(await text(lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' }))).toBe('accepted phase=critic')
    const nested = testLifecycle('FULL')
    await nested.transition({ phase: 'discovery', tool_use_id: 'start' })
    await nested.artifact({ kind: 'plan', content: '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task\n  DoD: green\n  - nested detail\n## Gates\n- test\n' })
    expect(await text(nested.transition({ phase: 'plan', tool_use_id: 'plan' }))).toBe('accepted phase=critic')
  })

  it('refuses an unsafe card id at server construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lifecycle-card-')); roots.push(root); mkdirSync(join(root, '.lane'))
    expect(() => createLifecycleServer({ worktree: root, route: 'LITE', models: {}, cardId: '../bad', sessionTag: 'x' })).toThrow(/cardId/)
  })

  it('serializes concurrent transitions and rejects a changed idempotency shape', async () => {
    const lifecycle = testLifecycle('LITE')
    const [first, second] = await Promise.all([text(lifecycle.transition({ phase: 'discovery', tool_use_id: 'one' })), text(lifecycle.transition({ phase: 'discovery', tool_use_id: 'two' }))])
    expect([first, second]).toContain('accepted phase=tdd')
    expect([first, second].join('\n')).toContain('current phase tdd')
    expect(await text(lifecycle.transition({ phase: 'discovery', tool_use_id: 'one', route: 'LITE' }))).toContain('unique tool_use_id')
  })
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function testLifecycle(route: 'LITE' | 'FULL', reasons: string[] = [], launcher: string | null = null, laneWaitMs: number | null = null, options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lifecycle-')); roots.push(root)
  mkdirSync(join(root, '.lane'))
  writeFileSync(join(root, '.gitignore'), '.lane/\n.claude/reports/\n')
  spawnSync('git', ['init', '-q'], { cwd: root })
  const gateResults: Record<string, { exit?: string, mtime?: number }> = {}
  const gateRunner = ({ name, log }: { name: string, log: string }) => { writeFileSync(log, 'gate\n'); return Number(gateResults[name]?.exit ?? '0') }
  const server = createLifecycleServer({ worktree: root, route, reasons, models: { lane: 'test', review: 'test' }, cardId: '1', sessionTag: 'test', laneLauncher: launcher, laneWaitMs, gateRunner, ...options })
  const tools = server.instance._registeredTools as Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>
  return { root, gateResults, transition: tools.transition!.handler, artifact: tools.write_artifact!.handler, run: tools.run!.handler }
}
function text(result: Promise<{ content: Array<{ text: string }> }>) { return result.then((value) => value.content[0]!.text) }
function launcher(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lifecycle-launcher-')); roots.push(root)
  const file = join(root, 'launcher.mjs'); writeFileSync(file, source)
  return file
}
function delayedLauncher() {
  return launcher("import { spawn } from 'node:child_process'; const log = process.argv[process.argv.indexOf('--log') + 1]; const report = log.replace('-run.log', '-report.md'); const code = \"const fs=require('fs'); setTimeout(() => { fs.appendFileSync(process.argv[1], 'done\\\\nEXIT=0\\\\n'); fs.writeFileSync(process.argv[2], 'report\\\\n') }, 50)\"; const child = spawn(process.execPath, ['-e', code, log, report], { detached: true, stdio: 'ignore' }); child.unref()")
}
function emptyLauncher() { return launcher('process.exit(0)') }
function logOnlyLauncher() { return launcher("import { appendFileSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; appendFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), '')") }
function successLauncher() { return launcher("import { appendFileSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; appendFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), 'report\\n')") }
function verdictLauncher() { return launcher("import { appendFileSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; appendFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), 'VERDICT: changes-requested\\nFINDINGS:\\n- blocker\\n')") }
function foreignThenGenuineLauncher() { return launcher("import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; const report = log.replace('-run.log', '-report.md'); const nonce = readFileSync(log, 'utf8'); rmSync(log); writeFileSync(log, 'foreign\\nEXIT=0\\n'); setTimeout(() => { writeFileSync(log, nonce); appendFileSync(log, 'genuine\\nEXIT=0\\n'); writeFileSync(report, 'report\\n') }, 40)") }
async function lifecycleAtVerify() {
  const lifecycle = testLifecycle('LITE', [], successLauncher(), 100)
  await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
  writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
  await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
  expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'verify' }))).toBe('accepted phase=verify')
  return lifecycle
}
async function lifecycleReadyForReport(options: Record<string, unknown> = {}) {
  const lifecycle = testLifecycle('LITE', [], successLauncher(), 100, options)
  await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
  writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
  await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
  await lifecycle.transition({ phase: 'tdd', tool_use_id: 'verify' })
  await writeGates(lifecycle)
  await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'passed' })
  writeFileSync(join(lifecycle.root, '.lane', 'pilot-report.md'), '# report\n')
  return lifecycle
}
async function writeGates(lifecycle: ReturnType<typeof testLifecycle>, overrides: Record<string, { exit?: string, mtime?: number }> = {}) {
  for (const name of ['typecheck', 'lint', 'test']) {
    lifecycle.gateResults[name] = overrides[name] ?? {}
    await lifecycle.run({ kind: 'gate', name })
    if (overrides[name]?.mtime === 0) utimesSync(join(lifecycle.root, '.lane', `${name}.log`), 0, 0)
  }
}
