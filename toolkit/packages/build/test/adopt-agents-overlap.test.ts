import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SOURCE_SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
// The REAL shipped declaration — read verbatim, never re-typed, so this fixture cannot
// silently drift from plugin/skills/adopt/scripts/agent-pairs.json the way a
// hand-duplicated constant would (test-lock-invariant-not-enumeration: a copy of the
// data is not a lock on the data).
const REAL_AGENT_PAIRS_JSON = readFileSync(
  join(REPO_ROOT, 'plugin/skills/adopt/scripts/agent-pairs.json'),
  'utf8',
)
const AGENT_PAIRS = JSON.parse(REAL_AGENT_PAIRS_JSON) as Array<{
  user: string
  shipped: string
  partial: boolean
  allowExtraPatterns?: string[]
}>

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const RULE_PAIRS = [{ user: 'step-back-architectural.md', shipped: 'wt-step-back-architectural.md', partial: false }]

/** Derive the one approved model per agent pair from its OWN allowExtraPatterns entry
 *  (never a second hand-typed table) — `^model: <name>$` is the pattern shape every
 *  pair currently uses; this reads the name out instead of re-asserting it. */
function approvedModel(pair: { allowExtraPatterns?: string[] }): string {
  for (const p of pair.allowExtraPatterns ?? []) {
    const m = /^\^model: (\S+)\$$/.exec(p)
    if (m) return m[1] as string
  }
  throw new Error('pair has no ^model: <name>$ allowExtraPatterns entry — fixture assumption changed')
}
const MODELS = Object.fromEntries(AGENT_PAIRS.map((pair) => [pair.user, approvedModel(pair)])) as Record<
  string,
  string
>
/** Safe accessor over MODELS — a plain indexed access types as `string | undefined` under
 *  this repo's `noUncheckedIndexedAccess`; the original `as const` literal MODELS guaranteed
 *  the three known keys, which Object.fromEntries's derived type cannot express. Every call
 *  site below names a key this fixture is known to declare, so a lookup miss is a fixture
 *  bug, not a normal path. */
function modelFor(file: string): string {
  const m = MODELS[file]
  if (m === undefined) throw new Error(`no approved model for ${file} — fixture assumption changed`)
  return m
}

const SHIPPED_AGENTS = {
  'pilot.md':
    '---\nname: pilot\ndescription: synthetic pilot\n---\n\nIf no consented lane is available, split work to a cheaper sub-agent.\n',
  'pilot-orchestrator.md':
    '---\nname: pilot-orchestrator\ndescription: synthetic orchestrator\n---\n\nAnnounce each selected card as you take it.\n',
  'pilot-watchdog.md':
    '---\nname: pilot-watchdog\ndescription: synthetic watchdog\n---\n\nWatch for drift only.\n',
  'pilot-orchestrator-watchdog.md':
    '---\nname: pilot-orchestrator-watchdog\ndescription: synthetic orchestrator watchdog\n---\n\nWatch the orchestrator for drift only.\n',
} as const

function mkFixture() {
  const base = mkdtempSync(join(tmpdir(), 'wt-agents-overlap-'))
  roots.push(base)

  const pluginRoot = join(base, 'plugin')
  const scriptsDir = join(pluginRoot, 'skills/adopt/scripts')
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  // Pilot defs source from plugin/agent-templates/, NOT plugin/agents/ — the pilot suite was
  // moved out of the plugin-registered dir because Claude Code silently ignores `observer:`
  // on a plugin-installed agent (see install.mjs SETS.agents.srcDir).
  mkdirSync(join(pluginRoot, 'agent-templates'), { recursive: true })
  mkdirSync(join(pluginRoot, 'rules'), { recursive: true })
  mkdirSync(scriptsDir, { recursive: true })

  writeFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2) + '\n')
  writeFileSync(join(scriptsDir, 'install.mjs'), readFileSync(SOURCE_SCRIPT, 'utf8'))
  writeFileSync(join(scriptsDir, 'agent-pairs.json'), REAL_AGENT_PAIRS_JSON)
  writeFileSync(join(scriptsDir, 'rule-pairs.json'), JSON.stringify(RULE_PAIRS, null, 2) + '\n')

  for (const [file, source] of Object.entries(SHIPPED_AGENTS)) {
    writeFileSync(join(pluginRoot, 'agent-templates', file), source)
  }
  writeFileSync(join(pluginRoot, 'rules', 'wt-step-back-architectural.md'), '# synthetic shipped rule\n\nKeep this rule.\n')

  const userDir = join(base, 'user')
  mkdirSync(userDir)
  return { script: join(scriptsDir, 'install.mjs'), userDir }
}

function withModel(source: string, model: string): string {
  const lines = source.split('\n')
  const close = lines.indexOf('---', 1)
  if (close === -1) throw new Error('fixture agent is missing frontmatter')
  lines.splice(close, 0, `model: ${model}`)
  return lines.join('\n')
}

function run(script: string, userDir: string, extraArgs: string[] = []) {
  const res = spawnSync(process.execPath, [script, '--audit-overlap', '--user-dir', userDir, ...extraArgs], { encoding: 'utf8' })
  return { ...res, stdout: (res.stdout ?? '') + (res.stderr ?? '') }
}

/** Installs via the REAL --install path, so the resulting user files carry a genuine
 *  adopt banner — the shape the audit-overlap comparison must tolerate on a
 *  correctly-adopted, unedited copy. `withModel` fixtures (used elsewhere in this file)
 *  never carry a banner, so they cannot exercise this path. */
function install(script: string, userDir: string) {
  const res = spawnSync(process.execPath, [script, '--set', 'agents', '--install', '--dir', userDir], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`fixture --install failed: ${res.stdout}${res.stderr}`)
}

describe('adopt audit-overlap --set agents', () => {
  it('accepts approved model lines as CLEAN for all declared agent pairs', () => {
    const fixture = mkFixture()
    for (const [file, model] of Object.entries(MODELS)) {
      writeFileSync(join(fixture.userDir, file), withModel(SHIPPED_AGENTS[file as keyof typeof SHIPPED_AGENTS], model))
    }

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN pilot.md')
    expect(res.stdout).toContain('CLEAN pilot-orchestrator.md')
    expect(res.stdout).toContain('CLEAN pilot-watchdog.md')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 0 drift, 0 absent, 0 unpaired, 0 unmapped')
  })

  it('a project-local agent with no pairing entry (e.g. wt-check.md / wt-reviewer.md) never blocks the exit code, but stays named (card #1828669977687753994)', () => {
    // Regression lock for the "always-red gate" defect: two local, never-managed agent files
    // present alongside a fully clean managed suite used to sink the exit code to 1 forever —
    // this is the exact shape measured at the 0.48.0 publish (0 duplicate, 0 drift, 0 absent,
    // 0 unpaired, 2 unmapped) that Frederic had to bypass without being able to tell it apart
    // from a real drift.
    const fixture = mkFixture()
    for (const [file, model] of Object.entries(MODELS)) {
      writeFileSync(join(fixture.userDir, file), withModel(SHIPPED_AGENTS[file as keyof typeof SHIPPED_AGENTS], model))
    }
    writeFileSync(join(fixture.userDir, 'wt-check.md'), '---\nname: wt-check\n---\n\nlocal-only checker\n')
    writeFileSync(join(fixture.userDir, 'wt-reviewer.md'), '---\nname: wt-reviewer\n---\n\nlocal-only reviewer\n')

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('UNMAPPED')
    expect(res.stdout).toContain('wt-check.md')
    expect(res.stdout).toContain('wt-reviewer.md')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 0 drift, 0 absent, 0 unpaired, 2 unmapped')
  })

  it('a REAL drift still fails the exit code even in the presence of unmapped local agents (unmapped never masks a genuine problem)', () => {
    const fixture = mkFixture()
    const driftedPilot = withModel(
      SHIPPED_AGENTS['pilot.md'].replace(
        'If no consented lane is available, split work to a cheaper sub-agent.',
        'otherwise implement the increments yourself.',
      ),
      modelFor('pilot.md'),
    )
    writeFileSync(join(fixture.userDir, 'pilot.md'), driftedPilot)
    writeFileSync(join(fixture.userDir, 'pilot-orchestrator.md'), withModel(SHIPPED_AGENTS['pilot-orchestrator.md'], modelFor('pilot-orchestrator.md')))
    writeFileSync(join(fixture.userDir, 'pilot-watchdog.md'), withModel(SHIPPED_AGENTS['pilot-watchdog.md'], modelFor('pilot-watchdog.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator-watchdog.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator-watchdog.md'], modelFor('pilot-orchestrator-watchdog.md')),
    )
    writeFileSync(join(fixture.userDir, 'wt-check.md'), '---\nname: wt-check\n---\n\nlocal-only checker\n')

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('DRIFT pilot.md (missing from shipped template): otherwise implement the increments yourself.')
    expect(res.stdout).toContain('UNMAPPED')
    expect(res.stdout).toContain('wt-check.md')
  })

  it('reports CLEAN on a genuinely --install-ed, unedited copy (banner must not read as drift)', () => {
    // Regression test for card #1827047859321570464: the comparison used to diff the
    // user file's RAW content (banner included) against the shipped file's STRIPPED
    // content, so a correctly-adopted copy could never go CLEAN — an always-red gate
    // silently indistinguishable from an always-green one. install() below produces the
    // exact real-world shape (banner present); withModel() fixtures elsewhere in this
    // file never carry a banner and therefore cannot exercise this path.
    const fixture = mkFixture()
    install(fixture.script, fixture.userDir)
    for (const [file, model] of Object.entries(MODELS)) {
      const installed = readFileSync(join(fixture.userDir, file), 'utf8')
      writeFileSync(join(fixture.userDir, file), withModel(installed, model))
    }

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN pilot.md')
    expect(res.stdout).toContain('CLEAN pilot-orchestrator.md')
    expect(res.stdout).toContain('CLEAN pilot-watchdog.md')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 0 drift, 0 absent, 0 unpaired, 0 unmapped')
  })

  it('still fails DRIFT on a hand-authored (no-banner) copy — the strip is conditional, not blanket', () => {
    // Negative case for the same fix: a hand-authored file's real first line must never
    // be eaten by an unconditional banner strip. Covered structurally by the withModel()
    // fixtures below (no banner is ever added), asserted here explicitly against the
    // installed-copy test above so the two cases are read together.
    const fixture = mkFixture()
    const driftedPilot = SHIPPED_AGENTS['pilot.md'].replace(
      'If no consented lane is available, split work to a cheaper sub-agent.',
      'otherwise implement the increments yourself.',
    )
    writeFileSync(join(fixture.userDir, 'pilot.md'), withModel(driftedPilot, modelFor('pilot.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator.md'], modelFor('pilot-orchestrator.md')),
    )
    writeFileSync(join(fixture.userDir, 'pilot-watchdog.md'), withModel(SHIPPED_AGENTS['pilot-watchdog.md'], modelFor('pilot-watchdog.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator-watchdog.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator-watchdog.md'], modelFor('pilot-orchestrator-watchdog.md')),
    )

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('DRIFT pilot.md (missing from shipped template): otherwise implement the increments yourself.')
  })

  it('fails when a declared agent copy is ABSENT', () => {
    const fixture = mkFixture()
    writeFileSync(join(fixture.userDir, 'pilot.md'), withModel(SHIPPED_AGENTS['pilot.md'], modelFor('pilot.md')))
    writeFileSync(join(fixture.userDir, 'pilot-watchdog.md'), withModel(SHIPPED_AGENTS['pilot-watchdog.md'], modelFor('pilot-watchdog.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator-watchdog.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator-watchdog.md'], modelFor('pilot-orchestrator-watchdog.md')),
    )

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('ABSENT pilot-orchestrator.md: ABSENT (declared pair, no user file present)')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 0 drift, 1 absent, 0 unpaired, 0 unmapped')
  })

  it('fails DRIFT when a project copy diverges beyond its approved model line', () => {
    const fixture = mkFixture()
    const driftedPilot = withModel(
      SHIPPED_AGENTS['pilot.md'].replace(
        'If no consented lane is available, split work to a cheaper sub-agent.',
        'otherwise implement the increments yourself.',
      ),
      modelFor('pilot.md'),
    )
    writeFileSync(join(fixture.userDir, 'pilot.md'), driftedPilot)
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator.md'], modelFor('pilot-orchestrator.md')),
    )
    writeFileSync(join(fixture.userDir, 'pilot-watchdog.md'), withModel(SHIPPED_AGENTS['pilot-watchdog.md'], modelFor('pilot-watchdog.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator-watchdog.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator-watchdog.md'], modelFor('pilot-orchestrator-watchdog.md')),
    )

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('DRIFT pilot.md')
    expect(res.stdout).toContain('DRIFT pilot.md (missing from shipped template): otherwise implement the increments yourself.')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 1 drift, 0 absent, 0 unpaired, 0 unmapped')
  })

  it('fails DRIFT when a project copy DELETES a shipped body line (no addition at all)', () => {
    // Regression test for the review finding on card #1827047859321570464: additions-only
    // comparison let a project copy silently drop a shipped safety line (e.g. by deleting
    // it outright, not replacing it) and still report CLEAN, because deletion adds no new
    // line for the old one-directional `extras` check to catch.
    const fixture = mkFixture()
    const deletedLinePilot = SHIPPED_AGENTS['pilot.md'].replace(
      'If no consented lane is available, split work to a cheaper sub-agent.\n',
      '',
    )
    writeFileSync(join(fixture.userDir, 'pilot.md'), withModel(deletedLinePilot, modelFor('pilot.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator.md'], modelFor('pilot-orchestrator.md')),
    )
    writeFileSync(join(fixture.userDir, 'pilot-watchdog.md'), withModel(SHIPPED_AGENTS['pilot-watchdog.md'], modelFor('pilot-watchdog.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator-watchdog.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator-watchdog.md'], modelFor('pilot-orchestrator-watchdog.md')),
    )

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('DRIFT pilot.md')
    expect(res.stdout).toContain('DRIFT pilot.md (missing from project copy): If no consented lane is available, split work to a cheaper sub-agent.')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 1 drift, 0 absent, 0 unpaired, 0 unmapped')
  })

  it('discriminates the two drift directions with different, unambiguous labels — and every DRIFT content line names its side (card #1832961693500573565)', () => {
    // The DoD's real test: fabricate a divergence in EACH direction on the SAME pair (one
    // line only the project copy has, one line only the shipped template has) and check that
    // a reader who knows nothing about this tool can tell, from the output alone, which file
    // to edit for which line. Locks the INVARIANT ("every drift content line names its
    // direction"), not an enumeration of today's two labels — the loop below scans every
    // DRIFT content line, not just the two the test happens to construct.
    const fixture = mkFixture()
    const bothDirectionsPilot = withModel(
      SHIPPED_AGENTS['pilot.md'].replace(
        'If no consented lane is available, split work to a cheaper sub-agent.\n',
        'a brand-new line only the project copy has.\n',
      ),
      modelFor('pilot.md'),
    )
    writeFileSync(join(fixture.userDir, 'pilot.md'), bothDirectionsPilot)
    writeFileSync(join(fixture.userDir, 'pilot-orchestrator.md'), withModel(SHIPPED_AGENTS['pilot-orchestrator.md'], modelFor('pilot-orchestrator.md')))
    writeFileSync(join(fixture.userDir, 'pilot-watchdog.md'), withModel(SHIPPED_AGENTS['pilot-watchdog.md'], modelFor('pilot-watchdog.md')))
    writeFileSync(
      join(fixture.userDir, 'pilot-orchestrator-watchdog.md'),
      withModel(SHIPPED_AGENTS['pilot-orchestrator-watchdog.md'], modelFor('pilot-orchestrator-watchdog.md')),
    )

    const res = run(fixture.script, fixture.userDir, ['--set', 'agents'])

    expect(res.status).toBe(1)
    // The line ONLY the project copy has: absent from the shipped template.
    expect(res.stdout).toContain('DRIFT pilot.md (missing from shipped template): a brand-new line only the project copy has.')
    // The line ONLY the shipped template has: absent from the project copy.
    expect(res.stdout).toContain('DRIFT pilot.md (missing from project copy): If no consented lane is available, split work to a cheaper sub-agent.')
    // The two labels are DIFFERENT strings — a reader cannot confuse which side is which.
    expect(res.stdout).toContain('missing from shipped template')
    expect(res.stdout).toContain('missing from project copy')
    // The summary breakdown also carries both counts, both non-zero on this fixture.
    expect(res.stdout).toContain('1 pair(s) missing from project copy (project is BEHIND the shipped template)')
    expect(res.stdout).toContain('1 pair(s) missing from shipped template (project has DIVERGED ahead of the shipped template)')

    // INVARIANT, not enumeration: every DRIFT line that carries an actual content entry (a
    // trailing `: <text>`, as opposed to the bare intro `DRIFT pilot.md` line) names one of
    // the two known directions. A future third divergence shape (were one ever added) would
    // fail THIS assertion instead of silently shipping an unlabelled line.
    const driftContentLines = res.stdout
      .split('\n')
      .filter((line) => /^DRIFT [^\s].*: /.test(line) && !/^DRIFT \S+: adopted under shipped name/.test(line))
    expect(driftContentLines.length).toBeGreaterThan(0)
    for (const line of driftContentLines) {
      expect(line).toMatch(/\((missing from shipped template|missing from project copy)\): /)
    }
  })

  it('does NOT flag a deleted rule line as drift — rules stay additions-only (editable-copy contract)', () => {
    // Companion negative case: rule copies are explicitly documented, in their own adopt
    // banner, as an editable copy users may trim/adapt — the deletion check above must stay
    // scoped to the `agents` set, never applied to `rules`. An EMPTY user file is the purest
    // "deleted everything, added nothing" case — it isolates the deletion axis from the
    // pre-existing (unrelated) first-line stripping stripRuleBanner always applies to the
    // SHIPPED side, which a hand-rolled non-empty fixture would otherwise entangle with.
    const fixture = mkFixture()
    writeFileSync(join(fixture.userDir, 'step-back-architectural.md'), '')

    const res = run(fixture.script, fixture.userDir, ['--set', 'rules'])

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('CLEAN step-back-architectural.md')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 0 drift, 0 unpaired, 0 unmapped')
  })

  it('keeps the rules-set ABSENT behavior non-failing by default', () => {
    const fixture = mkFixture()

    const res = run(fixture.script, fixture.userDir)

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('ABSENT step-back-architectural.md: ABSENT (declared pair, no user file present)')
    expect(res.stdout).toContain('audit-overlap: 0 duplicate, 0 drift, 0 unpaired, 0 unmapped')
    expect(res.stdout).not.toContain('0 absent')
  })
})
