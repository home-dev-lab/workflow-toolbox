import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt-rules/scripts/install-rules.mjs')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function mkDir(): string { const r = mkdtempSync(join(tmpdir(), 'wt-audit-')); roots.push(r); return r }
function run(userDir: string) {
  const res = spawnSync(process.execPath, [SCRIPT, '--audit-overlap', '--user-dir', userDir], { encoding: 'utf8' })
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
    expect(res.status).toBe(0); expect(res.stdout).toContain('DRIFT (partial, informational) delegation-lanes.md')
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
  it('does NOT flag the shipped-side basename as UNMAPPED at the correct target end state (user file removed, shipped copy installed)', () => {
    const d = mkDir()
    writeFileSync(join(d, 'wt-step-back-architectural.md'), 'installed copy\n')
    const res = run(d)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('ABSENT step-back-architectural.md')
    expect(res.stdout).not.toContain('UNMAPPED')
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
