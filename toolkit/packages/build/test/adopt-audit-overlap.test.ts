import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULE_PAIRS = join(REPO_ROOT, 'plugin/skills/adopt/scripts/rule-pairs.json')
const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function mkDir(): string { const r = mkdtempSync(join(tmpdir(), 'wt-audit-')); roots.push(r); return r }
function run(userDir: string, extraArgs: string[] = [], script = SCRIPT) {
  const res = spawnSync(process.execPath, [script, '--audit-overlap', '--user-dir', userDir, ...extraArgs], { encoding: 'utf8' })
  return { ...res, stdout: (res.stdout ?? '') + (res.stderr ?? ''), error: res.error }
}

describe('adopt audit-overlap', () => {
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
    expect(res.stdout).toContain('DRIFT step-back-architectural.md (missing from shipped template): # extra')
  })
  it('names the drift DIRECTION on the summary line too, not just per-line (card #1832961693500573565)', () => {
    // The rules set only ever produces the "extras" direction (additions-only contract), so
    // this pins that the summary breakdown reads as "diverged ahead of the shipped template" —
    // never "behind" — for a case that could only ever be an addition.
    const d = mkDir(); writeFileSync(join(d, 'step-back-architectural.md'), '# extra\n')
    const res = run(d)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('1 pair(s) missing from shipped template (project has DIVERGED ahead of the shipped template)')
    expect(res.stdout).toContain('0 pair(s) missing from project copy (project is BEHIND the shipped template)')
  })
  it('reports DUPLICATE with both paths', () => {
    const d = mkDir(); writeFileSync(join(d, 'step-back-architectural.md'), 'x\n'); writeFileSync(join(d, 'wt-step-back-architectural.md'), 'y\n')
    const res = run(d)
    expect(res.status).toBe(1); expect(res.stdout).toMatch(/DUPLICATE.*step-back-architectural\.md.*wt-step-back-architectural\.md/)
  })
  it('reports partial drift informationally, and UNMAPPED — neither blocks the exit code (card #1828669977687753994)', () => {
    const d = mkDir(); writeFileSync(join(d, 'delegation-lanes.md'), '# unique partial edit\n'); writeFileSync(join(d, 'some-other-rule.md'), 'x\n')
    const res = run(d)
    // Neither a PARTIAL drift nor an UNMAPPED file fails the exit code: `unmapped` decides
    // nothing (card #1828669977687753994 — an always-red gate is bypassed by reflex), and
    // `partial` drift was already informational before that fix. Both stay fully visible.
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
  // Both tests below build a self-contained fixture plugin root and go through the REAL
  // `--install` path so the resulting userDir file carries a genuine adopt banner —
  // the actual shape a directly-adopted (no local rename) shipped-name file has in
  // production (verified against the real ~/.claude/rules). A raw byte-copy with no banner
  // is NOT that shape (stripBanner treats the shipped source's own first line as disposable
  // framing unconditionally, but only strips the user side's first line when it recognizes
  // an install banner there — an asymmetry that predates this fix and is out of scope here;
  // going through --install sidesteps it exactly the way a real install does).
  function mkPairsFixture(shippedFile: string, shippedContent: string, pair: { user: string; shipped: string; partial: boolean }) {
    const base = mkDir()
    const pluginRoot = join(base, 'plugin')
    const scriptsDir = join(pluginRoot, 'skills/adopt/scripts')
    const rulesDir = join(pluginRoot, 'rules')
    const userDir = join(base, 'user')
    const pairsFile = join(base, 'pairs.json')
    mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
    mkdirSync(scriptsDir, { recursive: true })
    mkdirSync(rulesDir)
    mkdirSync(userDir)
    writeFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
    const script = join(scriptsDir, 'install.mjs')
    writeFileSync(script, readFileSync(SCRIPT, 'utf8'))
    writeFileSync(join(rulesDir, shippedFile), shippedContent)
    writeFileSync(pairsFile, JSON.stringify([pair]))
    const installRes = spawnSync(process.execPath, [script, '--set', 'rules', '--install', '--dir', userDir], { encoding: 'utf8' })
    if (installRes.status !== 0) throw new Error(`fixture --install failed: ${installRes.stdout}${installRes.stderr}`)
    return { script, userDir, pairsFile, installedPath: join(userDir, shippedFile) }
  }
  it('reports CLEAN for a declared pair adopted only under its shipped, --install-ed name', () => {
    const shippedFile = 'wt-step-back-architectural.md'
    const shippedContent = readFileSync(join(REPO_ROOT, 'plugin/rules', shippedFile), 'utf8')
    const fixture = mkPairsFixture(shippedFile, shippedContent, { user: 'my-local-name.md', shipped: shippedFile, partial: false })

    const res = run(fixture.userDir, ['--pairs-file', fixture.pairsFile], fixture.script)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN my-local-name.md: adopted under shipped name (wt-step-back-architectural.md)')
    expect(res.stdout).not.toContain('ABSENT')
  })
  it('reports DRIFT for a directly-adopted (shipped-name) file whose content was edited after install — content IS checked, not just existence', () => {
    // Regression lock for the review finding on card #1827841682423416647: an earlier
    // version of the ABSENT fix declared this case CLEAN on existence alone, without ever
    // reading the file, so a locally-edited shipped-name-adopted copy passed silently —
    // and `--audit-overlap` is a standalone mode (nothing else in the same invocation would
    // have caught the edit; --check/--install run only as a SEPARATE command).
    const shippedFile = 'wt-step-back-architectural.md'
    const shippedContent = readFileSync(join(REPO_ROOT, 'plugin/rules', shippedFile), 'utf8')
    const fixture = mkPairsFixture(shippedFile, shippedContent, { user: 'my-local-name.md', shipped: shippedFile, partial: false })
    const installed = readFileSync(fixture.installedPath, 'utf8')
    writeFileSync(fixture.installedPath, installed + '\nlocally added divergent line\n')

    const res = run(fixture.userDir, ['--pairs-file', fixture.pairsFile], fixture.script)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('DRIFT my-local-name.md: adopted under shipped name (wt-step-back-architectural.md), content diverges from the shipped source')
    expect(res.stdout).toContain('DRIFT my-local-name.md (missing from shipped template): locally added divergent line')
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
  it('makes every file with no declared pair visible, but NEVER failing on its own — a project-local file (e.g. wt-check.md) must not block the gate forever (card #1828669977687753994)', () => {
    const d = mkDir()
    const pairsFile = join(d, 'pairs.json')
    const strayPath = join(d, 'arbitrary-local-extension.md')
    writeFileSync(pairsFile, readFileSync(RULE_PAIRS, 'utf8'))
    writeFileSync(strayPath, 'local-only rule\n')

    const withStray = run(d, ['--pairs-file', pairsFile])
    // UNMAPPED stays fully visible and NAMED (an unmapped file may equally be a symptom of an
    // incomplete adoption, not just a deliberate local file — the tool cannot tell intent from
    // omission, so it never hides it) but it must never, on its own, fail the exit code: a
    // gate that can never go green on a project carrying legitimate local-only files is
    // bypassed by reflex the day it also carries a real drift.
    expect(withStray.status).toBe(0)
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

  describe('ship declarations', () => {
    it('keeps declared private files silent', () => {
      const d = mkDir()
      const declarationsFile = join(d, 'declarations.json')
      writeFileSync(join(d, 'quiet.md'), 'private calibration\n')
      writeFileSync(declarationsFile, JSON.stringify([{ user: 'quiet.md', status: 'private' }]))

      const res = run(d, ['--declarations-file', declarationsFile])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('1 declared-private')
      expect(res.stdout).not.toMatch(/^UNMAPPED .*quiet\.md$/m)
      expect(res.stdout).not.toMatch(/^UNDECIDED .*quiet\.md/m)
    })

    it('reports declared undecided files without gating', () => {
      const d = mkDir()
      const declarationsFile = join(d, 'declarations.json')
      const todoPath = join(d, 'todo.md')
      writeFileSync(todoPath, 'decide me\n')
      writeFileSync(declarationsFile, JSON.stringify([{ user: 'todo.md', status: 'undecided' }]))

      const res = run(d, ['--declarations-file', declarationsFile])
      expect(res.status).toBe(0)
      expect(res.stdout).toContain(`UNDECIDED ${todoPath}`)
    })

    it('keeps declared shipped-as files silent when the target exists', () => {
      const fixture = mkPairsFixture(
        'wt-target.md',
        '# target\n',
        { user: 'paired-user.md', shipped: 'wt-target.md', partial: false },
      )
      const declarationsFile = join(fixture.userDir, 'declarations.json')
      writeFileSync(join(fixture.userDir, 'ported.md'), 'ported rationale\n')
      writeFileSync(
        declarationsFile,
        JSON.stringify([{ user: 'ported.md', status: 'shipped-as', target: 'wt-target.md' }]),
      )

      const res = run(fixture.userDir, ['--pairs-file', fixture.pairsFile, '--declarations-file', declarationsFile], fixture.script)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('1 declared-ported')
      expect(res.stdout).not.toMatch(/^UNMAPPED .*ported\.md$/m)
      expect(res.stdout).not.toMatch(/^UNDECIDED .*ported\.md/m)
      expect(res.stdout).not.toMatch(/^DECLARATION-ERROR .*ported\.md/m)
    })

    it('fails when declared shipped-as points at a missing target', () => {
      const d = mkDir()
      const declarationsFile = join(d, 'declarations.json')
      const brokenPath = join(d, 'broken.md')
      writeFileSync(brokenPath, 'broken port claim\n')
      writeFileSync(
        declarationsFile,
        JSON.stringify([{ user: 'broken.md', status: 'shipped-as', target: 'does-not-exist.md' }]),
      )

      const res = run(d, ['--declarations-file', declarationsFile])
      expect(res.status).toBe(1)
      expect(res.stdout).toContain('DECLARATION-ERROR')
      expect(res.stdout).toContain(brokenPath)
      expect(res.stdout).toContain('does-not-exist.md')
    })

    it('keeps undeclared files as unchanged UNMAPPED findings', () => {
      const d = mkDir()
      const strayPath = join(d, 'fresh-undeclared-local-only.md')
      writeFileSync(strayPath, 'still local only\n')

      const res = run(d)
      expect(res.status).toBe(0)
      expect(res.stdout).toContain(`UNMAPPED ${strayPath}`)
    })

    it('refuses declarations that collide with a declared pair user', () => {
      const fixture = mkPairsFixture(
        'wt-target.md',
        '# target\n',
        { user: 'collision.md', shipped: 'wt-target.md', partial: false },
      )
      const declarationsFile = join(fixture.userDir, 'declarations.json')
      writeFileSync(declarationsFile, JSON.stringify([{ user: 'collision.md', status: 'private' }]))

      const res = run(fixture.userDir, ['--pairs-file', fixture.pairsFile, '--declarations-file', declarationsFile], fixture.script)
      expect(res.status).toBe(1)
      expect(res.stdout).toContain("user 'collision.md' collides with a declared pair")
    })

    it('refuses declarations that collide with a declared pair on the SHIPPED side (review finding: this used to be accepted and silently never consulted)', () => {
      const fixture = mkPairsFixture(
        'wt-shipped-collision.md',
        '# shipped side\n',
        { user: 'local-name.md', shipped: 'wt-shipped-collision.md', partial: false },
      )
      const declarationsFile = join(fixture.userDir, 'declarations.json')
      // The declaration's `user` equals the PAIR's `shipped` basename, not its `user` basename —
      // this is the collision shape the earlier `declaredUsers`-only check missed entirely.
      writeFileSync(declarationsFile, JSON.stringify([{ user: 'wt-shipped-collision.md', status: 'private' }]))

      const res = run(fixture.userDir, ['--pairs-file', fixture.pairsFile, '--declarations-file', declarationsFile], fixture.script)
      expect(res.status).toBe(1)
      expect(res.stdout).toContain("user 'wt-shipped-collision.md' collides with a declared pair")
    })

    it('refuses a declaration with a bad status value', () => {
      const d = mkDir()
      const declarationsFile = join(d, 'declarations.json')
      writeFileSync(declarationsFile, JSON.stringify([{ user: 'bad-status.md', status: 'maybe' }]))

      const res = run(d, ['--declarations-file', declarationsFile])
      expect(res.status).toBe(1)
      expect(res.stdout).toContain("field 'status'")
    })

    it('refuses a shipped-as declaration with no target', () => {
      const d = mkDir()
      const declarationsFile = join(d, 'declarations.json')
      writeFileSync(declarationsFile, JSON.stringify([{ user: 'missing-target.md', status: 'shipped-as' }]))

      const res = run(d, ['--declarations-file', declarationsFile])
      expect(res.status).toBe(1)
      expect(res.stdout).toContain("field 'target'")
    })
  })
})
