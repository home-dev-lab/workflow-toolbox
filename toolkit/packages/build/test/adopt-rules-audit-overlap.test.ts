import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt-rules/scripts/install-rules.mjs')
const RULE_PAIRS = join(REPO_ROOT, 'plugin/skills/adopt-rules/scripts/rule-pairs.json')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function mkDir(): string { const r = mkdtempSync(join(tmpdir(), 'wt-audit-')); roots.push(r); return r }
function run(userDir: string, extraArgs: string[] = [], script = SCRIPT) {
  const res = spawnSync(process.execPath, [script, '--audit-overlap', '--user-dir', userDir, ...extraArgs], { encoding: 'utf8' })
  return { ...res, stdout: (res.stdout ?? '') + (res.stderr ?? ''), error: res.error }
}

describe('adopt-rules audit-overlap', () => {
  it('reports CLEAN and ABSENT', () => {
    const d = mkDir()
    const shipped = readFileSync(join(REPO_ROOT, 'plugin/rules/wt-step-back-architectural.md'), 'utf8')
    writeFileSync(join(d, 'step-back-architectural.md'), shipped.split(/\r?\n/).slice(2, 3).join('\n') + '\n')
    const res = run(d)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN step-back-architectural.md')
    expect(res.stdout).toContain('ABSENT (declared pair, no user file present)')
  })
  it('reports substantive DRIFT and fails', () => {
    const d = mkDir(); writeFileSync(join(d, 'step-back-architectural.md'), '# extra\n')
    const res = run(d)
    expect(res.status).toBe(1); expect(res.stdout).toContain('DRIFT step-back-architectural.md')
    expect(res.stdout).toContain('DRIFT step-back-architectural.md: # extra')
  })
  it('reports DUPLICATE with both paths', () => {
    const d = mkDir(); writeFileSync(join(d, 'step-back-architectural.md'), 'x\n'); writeFileSync(join(d, 'wt-step-back-architectural.md'), 'y\n')
    const res = run(d)
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/DUPLICATE.*step-back-architectural\.md.*wt-step-back-architectural\.md/)
  })
  it('reports partial drift informationally, and UNMAPPED', () => {
    const d = mkDir(); writeFileSync(join(d, 'delegation-lanes.md'), '# unique partial edit\n'); writeFileSync(join(d, 'some-other-rule.md'), 'x\n')
    const res = run(d)
    // Any file present that maps to no declared pair now fails the exit code — the discriminant this card exists to fix, not just an informational print.
    expect(res.status).toBe(1); expect(res.stdout).toContain('DRIFT (partial, informational) delegation-lanes.md')
    // UNMAPPED prints the full joined path (consistent with DUPLICATE's own convention), not
    // the bare basename — an operator can act on the printed path directly.
    expect(res.stdout).toContain(`UNMAPPED ${join(d, 'some-other-rule.md')}`)
  })
  it('reports a partial pair with BOTH files present as informational DUPLICATE, not a failing one (the real deployed work-side shape: delegation-lanes.md + wt-delegation-ladder.md deliberately coexist)', () => {
    const d = mkDir()
    writeFileSync(join(d, 'delegation-lanes.md'), 'machine bindings\n')
    writeFileSync(join(d, 'wt-delegation-ladder.md'), 'generic ladder\n')
    const res = run(d)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(`DUPLICATE (partial, informational) ${join(d, 'delegation-lanes.md')} + ${join(d, 'wt-delegation-ladder.md')}`)
    expect(res.stdout).toContain('audit-overlap: 0 duplicate')
  })
  it('fails clearly when --user-dir is missing', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--audit-overlap'], { encoding: 'utf8' })
    expect(res.status).not.toBe(0); expect((res.stdout ?? '') + (res.stderr ?? '')).toContain('--user-dir is required')
  })
  it('reports CLEAN when the user file is removed and the shipped copy is installed directly', () => {
    const d = mkDir()
    writeFileSync(join(d, 'wt-step-back-architectural.md'), 'installed copy\n')
    const res = run(d)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN step-back-architectural.md: adopted under shipped name (wt-step-back-architectural.md)')
    expect(res.stdout).not.toContain('UNMAPPED')
  })
  it('accepts a declared pair adopted only under its shipped name', () => {
    const base = mkDir()
    const pluginRoot = join(base, 'plugin')
    const scriptsDir = join(pluginRoot, 'skills/adopt-rules/scripts')
    const rulesDir = join(pluginRoot, 'rules')
    const userDir = join(base, 'user')
    const pairsFile = join(base, 'pairs.json')
    const shippedFile = 'wt-step-back-architectural.md'
    const shipped = readFileSync(join(REPO_ROOT, 'plugin/rules', shippedFile), 'utf8')
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
    mkdirSync(scriptsDir, { recursive: true })
    mkdirSync(rulesDir)
    mkdirSync(userDir)
    writeFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
    writeFileSync(join(scriptsDir, 'install-rules.mjs'), readFileSync(SCRIPT, 'utf8'))
    writeFileSync(join(rulesDir, shippedFile), shipped)
    writeFileSync(join(userDir, shippedFile), shipped)
    writeFileSync(pairsFile, JSON.stringify([{ user: 'my-local-name.md', shipped: shippedFile, partial: false }]))

    const res = run(userDir, ['--pairs-file', pairsFile], join(scriptsDir, 'install-rules.mjs'))
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN my-local-name.md: adopted under shipped name (wt-step-back-architectural.md)')
    expect(res.stdout).not.toContain('ABSENT')
  })
  it('fails when a shipped rule has no pairing entry even with zero local files', () => {
    const d = mkDir()
    const pairsFile = join(d, 'pairs.json')
    const pairs = JSON.parse(readFileSync(RULE_PAIRS, 'utf8')) as Array<{ shipped: string }>
    writeFileSync(pairsFile, JSON.stringify(pairs.filter((pair) => pair.shipped !== 'wt-task-tracking.md')))

    // Coverage is structural: it must expose the pairing gap even when no local copy exists.
    const res = run(d, ['--pairs-file', pairsFile])
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('UNPAIRED wt-task-tracking.md: no pairing entry in')
  })
  it('makes every file with no declared pair visible and failing, while a clean directory passes', () => {
    const d = mkDir()
    const pairsFile = join(d, 'pairs.json')
    const strayPath = join(d, 'arbitrary-local-extension.md')
    writeFileSync(pairsFile, readFileSync(RULE_PAIRS, 'utf8'))
    writeFileSync(strayPath, 'local-only rule\n')

    const withStray = run(d, ['--pairs-file', pairsFile])
    expect(withStray.status).toBe(1)
    expect(withStray.stdout).toContain(`UNMAPPED ${strayPath}`)

    unlinkSync(strayPath)
    const withoutStray = run(d, ['--pairs-file', pairsFile])
    expect(withoutStray.status).toBe(0)
    expect(withoutStray.stdout).not.toContain('UNMAPPED')
  })
  it('detects DUPLICATE when the user-side file is a valid symlink, not just a plain file (the pre-2026-07-23 work-side shape)', () => {
    const d = mkDir()
    const target = join(d, 'real-original.md')
    writeFileSync(target, 'original content\n')
    symlinkSync(target, join(d, 'step-back-architectural.md'))
    writeFileSync(join(d, 'wt-step-back-architectural.md'), 'installed copy\n')
    const res = run(d)
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/DUPLICATE.*step-back-architectural\.md.*wt-step-back-architectural\.md/)
  })
})
