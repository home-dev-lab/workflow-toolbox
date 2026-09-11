import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(Object.isFrozen(server.lifecycle.route)).toBe(true)
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
    expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'verify' }))).toMatch(/^edge refused: tdd->next; missing lane receipt EXIT=missing: /)
  })

  it('refuses a lane receipt with an empty report', async () => {
    const lifecycle = testLifecycle('LITE', [], logOnlyLauncher(), 100)
    await lifecycle.transition({ phase: 'discovery', tool_use_id: 'start' })
    writeFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'brief\n')
    await lifecycle.run({ kind: 'lane', phase: 'tdd', timeout: 1 })
    expect(await text(lifecycle.transition({ phase: 'tdd', tool_use_id: 'verify' }))).toMatch(/^edge refused: tdd->next; missing non-empty lane report: /)
  })

  it.each(['typecheck', 'lint', 'test'])('refuses verify when %s has EXIT=1', async (name) => {
    const lifecycle = await lifecycleAtVerify()
    writeGates(lifecycle.root, { [name]: { exit: '1' } })
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: name }))).toMatch(/^edge refused: verify->next; missing gate receipt EXIT=1: /)
  })

  it('refuses verify with a gate older than the lane receipt', async () => {
    const lifecycle = await lifecycleAtVerify()
    writeGates(lifecycle.root, { test: { mtime: 0 } })
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'old' }))).toMatch(/^edge refused: verify->next; missing gate newer than lane receipt: /)
  })

  it('refuses verify after the working tree signature changes', async () => {
    const lifecycle = await lifecycleAtVerify()
    writeGates(lifecycle.root)
    writeFileSync(join(lifecycle.root, 'changed.txt'), 'changed\n')
    expect(await text(lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'changed' }))).toMatch(/^edge refused: verify->next; missing current tree signature: /)
  })

  it('persists verify digests and refuses a report edge when a gate changes afterward', async () => {
    const lifecycle = await lifecycleAtVerify()
    writeGates(lifecycle.root)
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

  it('records the commit, archive manifest digest, and lifecycle implementation', async () => {
    let revisions = 0
    const git = (_program: string, call: string[]) => call[0] === 'rev-parse' ? `${++revisions === 1 ? 'base' : 'next'}\n` : ''
    const lifecycle = await lifecycleReadyForReport({ git })
    expect(await text(lifecycle.transition({ phase: 'report', tool_use_id: 'report' }))).toBe('accepted phase=awaiting_fidelity')
    const summary = JSON.parse(readFileSync(join(lifecycle.root, '.lane', 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({ commit: 'next', lifecycle_implementation: { name: 'sdk-pilot-lifecycle', version: '1.0.0' } })
    expect(summary.archive).toMatchObject({ path: expect.stringContaining('.claude/reports/1-'), manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function testLifecycle(route: 'LITE' | 'FULL', reasons: string[] = [], launcher: string | null = null, laneWaitMs: number | null = null, options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lifecycle-')); roots.push(root)
  mkdirSync(join(root, '.lane'))
  writeFileSync(join(root, '.gitignore'), '.lane/\n')
  spawnSync('git', ['init', '-q'], { cwd: root })
  const server = createLifecycleServer({ worktree: root, route, reasons, models: { lane: 'test', review: 'test' }, cardId: '1', sessionTag: 'test', laneLauncher: launcher, laneWaitMs, ...options })
  const tools = server.instance._registeredTools as Record<string, { handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>
  return { root, transition: tools.transition!.handler, artifact: tools.write_artifact!.handler, run: tools.run!.handler }
}
function text(result: Promise<{ content: Array<{ text: string }> }>) { return result.then((value) => value.content[0]!.text) }
function launcher(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lifecycle-launcher-')); roots.push(root)
  const file = join(root, 'launcher.mjs'); writeFileSync(file, source)
  return file
}
function delayedLauncher() {
  return launcher("import { spawn } from 'node:child_process'; const log = process.argv[process.argv.indexOf('--log') + 1]; const report = log.replace('-run.log', '-report.md'); const code = \"const fs=require('fs'); setTimeout(() => { fs.writeFileSync(process.argv[1], 'done\\\\nEXIT=0\\\\n'); fs.writeFileSync(process.argv[2], 'report\\\\n') }, 50)\"; const child = spawn(process.execPath, ['-e', code, log, report], { detached: true, stdio: 'ignore' }); child.unref()")
}
function emptyLauncher() { return launcher('process.exit(0)') }
function logOnlyLauncher() { return launcher("import { writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; writeFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), '')") }
function successLauncher() { return launcher("import { writeFileSync } from 'node:fs'; const log = process.argv[process.argv.indexOf('--log') + 1]; writeFileSync(log, 'done\\nEXIT=0\\n'); writeFileSync(log.replace('-run.log', '-report.md'), 'report\\n')") }
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
  writeGates(lifecycle.root)
  await lifecycle.transition({ phase: 'verify', outcome: 'passed', tool_use_id: 'passed' })
  writeFileSync(join(lifecycle.root, '.lane', 'pilot-report.md'), '# report\n')
  return lifecycle
}
function writeGates(root: string, overrides: Record<string, { exit?: string, mtime?: number }> = {}) {
  const evidence = JSON.parse(readFileSync(join(root, '.lane', 'evidence.json'), 'utf8'))
  for (const name of ['typecheck', 'lint', 'test']) {
    const file = join(root, '.lane', `${name}.log`)
    const content = `gate\nEXIT=${overrides[name]?.exit ?? '0'}\n`
    writeFileSync(file, content)
    const mtime = overrides[name]?.mtime ?? Date.now()
    evidence.entries[file] = { path: file, size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), mtime, exit: overrides[name]?.exit ?? '0', tree: treeSignature(root) }
  }
  writeFileSync(join(root, '.lane', 'evidence.json'), `${JSON.stringify(evidence)}\n`)
}
