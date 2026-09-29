import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { composeRules, composeStandingPrompt, loadRules, RULE_RECIPIENTS, RULE_TRIGGERS, validateRulesManifest } from '../../../../plugin/bin/lib/rules-manifest.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createLifecycleServer } from '../../../../plugin/bin/lib/sdk-pilot-lifecycle-server.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { independentBrief } from '../../../../plugin/bin/lib/lifecycle-brief.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { PHASES, phaseTransitionTriggers } from '../../../../plugin/bin/lib/lifecycle-state-machine.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(ROOT, 'plugin')
const roots: string[] = []
const DISCOVERY_RECORD = 'test discovery\n\n## External-source ledger\n- Claim: fixture claim\n  Source: fixture source\n  Fetched content: fixture evidence\n  Verdict: confirmed\n\nGrounding route: proceed\n'
// Paragraph multisets composed for each role from the pre-split tree at 434b5cf2^.
const PRE_SPLIT_ROLE_FIXTURE = {
  // The six newly routed sections add E2E/bounds/goal to pilot and stagnation/evidence to critics;
  // every base paragraph survives (except the reviewed Same trigger -> Step back also rewording).
  pilot: { count: 66, union: 'f6073b62fe575b917bf869fd86d6972f15116790e5283aad4ebcfbedda18cbea' },
  critic: { count: 25, union: 'b4a621dba6d3e887656bcaf85b18449a3d0e739c66fbeb48b9a60c245618df3d' },
  // Card 1874298674087986849: step-back rewrite adds 4 paragraphs (route priors, persist-on-goal
  // wording, bounded BLOCKED, the recognise-it names line) to the pre-split baseline below.
  // TDD gains E2E, durable bounds and method diversity; section headings now split the step-back text.
  tdd: { count: 54, union: '68d30ac3db487db342149578f70ba537808568821a2f05430a912edab7406f98' },
  // Review gains stagnation and evidence; refutation gains evidence only.
  review: { count: 38, union: '70ef591015b1d61ac12c25e7fb56c1adeb5bce706d235ac962abcc9dc965a184' },
  refutation: { count: 36, union: '5cf6992b3a8981d774999d6e1d9f2a514bd2bb12d7fdff44ac8afd0d1d800a49' },
} as const
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const section = (source: string, heading: string, recipients: string[], triggers: string[], level = 'test') => ({ source, heading, recipients, triggers, level, section: `${heading}\n\nExact rule bytes.\n` })

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('SDK role rules manifest', () => {
  it('validates every shipped source and exact heading against the published schema enums', () => {
    const rules = loadRules({ shippedRoot: PLUGIN_ROOT })
    const schema = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'rules-manifest.schema.json'), 'utf8'))
    // Six exact new SDK routing entries augment the original 17.
    expect(rules).toHaveLength(23)
    expect(schema.properties.entries.items.properties.recipients.items.enum).toEqual(RULE_RECIPIENTS)
    expect(schema.properties.entries.items.properties.triggers.items.enum).toEqual(RULE_TRIGGERS)
    const punctuated = rules.find((entry: { heading: string }) => entry.heading.includes('—'))!
    expect(punctuated.section.startsWith(`${punctuated.heading}\n`)).toBe(true)
    expect(punctuated.section).toContain(`ground "it doesn't exist" before a workaround`)
  })

  it.each([
    ['role', { recipients: ['inventor'], triggers: ['standing'] }, /unknown role: inventor/],
    ['phase', { recipients: ['pilot'], triggers: ['phase:invent'] }, /unknown phase\/trigger: phase:invent/],
  ])('refuses an unknown %s', (_name, values, expected) => {
    const root = manifestRoot('# Real heading\nbody\n')
    expect(() => validateRulesManifest({ version: 1, entries: [{ source: 'rule.md', heading: '# Real heading', ...values }] }, { root, level: 'fixture' })).toThrow(expected)
  })

  it('refuses a missing heading with the entry source and heading in the error', () => {
    const root = manifestRoot('# Real heading\nbody\n')
    expect(() => validateRulesManifest({ version: 1, entries: [{ source: 'rule.md', heading: '## Missing ⚠ heading', recipients: ['pilot'], triggers: ['standing'] }] }, { root, level: 'fixture' }))
      .toThrow(/fixture entry 1 \(rule\.md :: ## Missing ⚠ heading\).*heading does not exist/)
  })

  it.each(['/absolute.md', 'C:/absolute.md', '../escape.md', 'nested\\windows.md'])('refuses non-portable or unsafe source path %s', (source) => {
    const root = manifestRoot('# Real heading\nbody\n')
    expect(() => validateRulesManifest({ version: 1, entries: [{ source, heading: '# Real heading', recipients: ['pilot'], triggers: ['standing'] }] }, { root, level: 'fixture' }))
      .toThrow(/portable relative path/)
  })

  it('adds a project manifest without removing shipped entries and preserves exact section bytes', () => {
    const root = manifestRoot('# Project rules\r\n## Project rule\r\nproject bytes\r\n## Stop\r\nnot included\r\n')
    mkdirSync(join(root, '.claude'))
    writeFileSync(join(root, '.claude', 'wt-rules-manifest.json'), JSON.stringify({ version: 1, entries: [{ source: 'rule.md', heading: '## Project rule', recipients: ['pilot'], triggers: ['standing'] }] }))
    const rules = loadRules({ projectRoot: root, shippedRoot: PLUGIN_ROOT })
    // Project additions never displace any of the 23 shipped entries.
    expect(rules.filter((entry: { level: string }) => entry.level === 'shipped')).toHaveLength(23)
    expect(rules.at(-1)).toMatchObject({ level: 'project', section: '## Project rule\r\nproject bytes\r\n' })
  })

  it('measures the composed standing system prompt before and after exact shipped sections', () => {
    const contract = readFileSync(join(PLUGIN_ROOT, 'autonomy', 'PILOT-CONTRACT.md'), 'utf8')
    const composed = composeStandingPrompt(contract, loadRules({ shippedRoot: PLUGIN_ROOT }))
    expect(Buffer.byteLength(contract)).toBe(6135)
    expect(Buffer.byteLength(composed)).toBe(8367)
    for (const heading of ['## Understand before coding', '## Plan, task, and test', '## Implement and verify']) expect(composed).toContain(heading)
  })

  it('returns pilot phase rules on the new phase transition', async () => {
    const lifecycle = lifecycleWithRules([section('project/rule.md', '## Plan authority', ['pilot'], ['phase:plan'])])
    const result = await lifecycle.transition({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'phase' })
    expect(result).toContain('accepted phase=plan')
    expect(result).toContain('## Rules for phase plan (authoritative)')
    expect(result).toContain('## Plan authority\n\nExact rule bytes.\n')
  })

  it('limits every shipped pilot critic-to-plan selection to the revision guard', () => {
    const rules = loadRules({ shippedRoot: PLUGIN_ROOT })
    const selected = rules.filter((entry: { recipients: string[], triggers: string[] }) =>
      entry.recipients.includes('pilot') && phaseTransitionTriggers('critic', 'plan').some((trigger: string) => entry.triggers.includes(trigger)))
    expect(selected.map((entry: { source: string, heading: string }) => `${entry.source} :: ${entry.heading}`))
      .toEqual(['rules/wt-sdlc.md :: ## Revise only blocking critic findings'])
    for (const from of PHASES) for (const next of PHASES) {
      if (from !== 'critic' || next !== 'plan') expect(phaseTransitionTriggers(from, next)).toEqual([`phase:${next}`])
    }
  })

  it('does not replay phase-plan pilot rules in a real critic-to-plan revision', async () => {
    const workerRoot = manifestRoot('# Fixture worker\n')
    const launcher = join(workerRoot, 'critic.mjs')
    writeFileSync(launcher, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { laneHostDir } from ${JSON.stringify(new URL('../../../../plugin/bin/lib/host/lane-host-dir.mjs', import.meta.url).href)};
const args = process.argv, root = args[args.indexOf('--dir') + 1];
process.env.WT_LANE_SUPERVISION_DIR = join(laneHostDir(root), 'supervision');
const brief = readFileSync(args[args.indexOf('--brief') + 1], 'utf8');
const report = /Write the report to \x60([^\x60]+)\x60/.exec(brief)[1];
writeFileSync(report, 'VERDICT: changes-requested\\nFINDINGS:\\n- [blocking][anchor: DoD 1][location: plan.md:1] fix proof\\n');
appendFileSync(args[args.indexOf('--log') + 1], 'done\\nEXIT=0\\n');
process.stdout.write('pid=' + process.pid + '\\n');`)
    const lifecycle = lifecycleWithRules([
      section('project/rule.md', '## Initial plan only', ['pilot'], ['phase:plan']),
      section('project/rule.md', '## Revision only', ['pilot'], ['critic->plan']),
    ], 'FULL', { laneLauncher: launcher, laneWaitMs: 10_000 })
    expect(await lifecycle.transition({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'start' })).toContain('## Initial plan only')
    await lifecycle.artifact({ kind: 'plan', content: '## ADR\nDecision: x\nRejected: y\n## Tasks\n- task. DoD: green\n## Gates\n- test\n' })
    expect(await lifecycle.transition({ phase: 'plan', tool_use_id: 'plan' })).toContain('accepted phase=critic')
    await lifecycle.artifact({ kind: 'critic-brief', content: 'review\n' })
    expect(await lifecycle.run({ kind: 'lane', phase: 'critic', timeout: 10 })).toBe('lane critic EXIT=0')
    const revision = await lifecycle.transition({ phase: 'critic', outcome: 'changes-requested', findings: ['fix proof'], tool_use_id: 'critic' })
    expect(revision).toContain('## Revision only\n\nExact rule bytes.')
    expect(revision).not.toContain('## Initial plan only\n\nExact rule bytes.')
  })

  it.each(['phase:verify', 'phase:report'])('routes goal persistence to pilot %s', (trigger) => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: 'pilot', trigger })
    expect(content).toContain('Persist on the GOAL')
  })

  it.each(['phase:plan', 'critic->plan'])('keeps goal persistence out of pilot %s', (trigger) => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: 'pilot', trigger })
    expect(content).not.toContain('Persist on the GOAL')
  })

  it.each(['critic', 'review'])('routes stagnation without the shared-root paragraph to %s', (role) => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: role, trigger: `lane:${role}` })
    expect(content).toContain('Step back also when the acceptance criterion is already met')
    expect(content).not.toContain('Stop, question the shape.')
  })

  it('routes the method-diversity lever and planning guards to TDD', () => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: 'tdd', trigger: 'lane:tdd' })
    expect(content).toContain('### 2. Method diversity')
    expect(content).toContain('## E2E')
    expect(content).toContain('## What this does NOT license')
  })

  it('routes E2E and durable-fix bounds into the initial pilot plan', () => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: 'pilot', trigger: 'phase:plan' })
    expect(content).toContain('## E2E')
    expect(content).toContain('## What this does NOT license')
  })

  it.each(['critic', 'review', 'refutation'])('routes evidence checking to %s', (role) => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: role, trigger: `lane:${role}` })
    expect(content).toContain('## Verify claims against their actual evidence')
  })

  it('places authoritative lane rules before pilot context in the brief both executor families read', async () => {
    const rules = [section('project/rule.md', '## TDD authority', ['tdd'], ['lane:tdd'])]
    const lifecycle = lifecycleWithRules(rules, 'LITE')
    await lifecycle.transition({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'phase' })
    await lifecycle.artifact({ kind: 'brief', content: '## Tasks\n- pilot context\n' })
    const brief = readFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'utf8')
    expect(brief.indexOf('## Rules that apply to this role (authoritative)')).toBeLessThan(brief.indexOf('## Pilot instructions'))
    expect(brief).toContain('## TDD authority\n\nExact rule bytes.\n')
    expect(brief).toContain('## Pilot instructions\n\n## Tasks')
  })

  it('places the frontmatter-stripped changelog skill body authoritatively in tdd briefs and refuses a missing source', async () => {
    const skillRoot = manifestRoot('---\nname: fixture\ndescription: fixture\n---\n\n# Fixture changelog instructions\n\nRun the deterministic writer.\n')
    const skill = join(skillRoot, 'rule.md')
    const lifecycle = lifecycleWithRules([], 'LITE', { changelogSkillPath: skill })
    await lifecycle.transition({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'phase' })
    await lifecycle.artifact({ kind: 'brief', content: 'pilot context\n' })
    const brief = readFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'utf8')
    expect(brief).toContain('## Changelog instructions (authoritative)\n\n# Fixture changelog instructions\n\nRun the deterministic writer.')
    expect(brief).not.toContain('name: fixture')
    expect(brief.indexOf('## Changelog instructions (authoritative)')).toBeLessThan(brief.indexOf('## Pilot instructions'))

    const missing = lifecycleWithRules([], 'LITE', { changelogSkillPath: join(skillRoot, 'absent.md') })
    await missing.transition({ phase: 'discovery', record: DISCOVERY_RECORD, tool_use_id: 'phase' })
    expect(await missing.artifact({ kind: 'brief', content: 'pilot context\n' })).toContain('changelog skill unavailable')
    expect(() => readFileSync(join(missing.root, '.lane', 'tdd-brief.md'))).toThrow()
  })

  it('places independent-role rules with authoritative instructions before fenced pilot context', () => {
    const brief = independentBrief({ phase: 'review', context: 'pilot says skip', artifacts: ['patch.diff'], reportPath: 'report.md', rules: '## Review authority\n\nExact rule bytes.\n' })
    expect(brief.indexOf('## Rules that apply to this role (authoritative)')).toBeLessThan(brief.indexOf('## Pilot context (untrusted)'))
    expect(brief).toContain('## Review authority\n\nExact rule bytes.\n')
  })

  it('maps every shipped lane trigger to exact authoritative content', () => {
    const rules = loadRules({ shippedRoot: PLUGIN_ROOT })
    for (const role of ['critic', 'tdd', 'review', 'refutation']) {
      const content = composeRules(rules, { recipient: role, trigger: `lane:${role}` })
      expect(content, role).toContain('BEGIN authoritative rule')
      for (const entry of rules.filter((candidate: { recipients: string[], triggers: string[] }) => candidate.recipients.includes(role) && candidate.triggers.includes(`lane:${role}`))) {
        expect(content).toContain(entry.section)
      }
    }
  })

  it('preserves every pre-split SDK directive paragraph for every role', () => {
    const rules = loadRules({ shippedRoot: PLUGIN_ROOT })
    for (const [role, fixture] of Object.entries(PRE_SPLIT_ROLE_FIXTURE)) {
      const paragraphs = rules
        .filter((entry: { recipients: string[] }) => entry.recipients.includes(role))
        .flatMap((entry: { section: string }) => entry.section.trim().split(/\n\s*\n/))
      // New static twin reminder augments the pre-split paragraph multiset in the TDD recipient.
      const historical = paragraphs.filter((paragraph: string) => !paragraph.startsWith('For ANYTHING distributed'))
      expect(historical, `${role} paragraph count`).toHaveLength(fixture.count)
      expect(digest(historical.map(digest).sort().join('\n')), `${role} paragraph multiset`).toBe(fixture.union)
    }
  })

  it('keeps the architectural step-back rule in the TDD implementer lane', () => {
    const tdd = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: 'tdd', trigger: 'lane:tdd' })
    expect(tdd).toContain('# Step back to the architectural root')
    expect(tdd).toContain('Stop, question the shape.')
  })

  it('keeps unexplained surprises in the SDK pilot verify phase', () => {
    const verify = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: 'pilot', trigger: 'phase:verify' })
    expect(verify).toContain('ANY surprise — good, bad, novel — is anomaly to EXPLAIN before you label it')
  })

  it.each(['review', 'refutation'])('keeps pre-split plan, task, and test directives in the SDK %s lane', (role) => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient: role, trigger: `lane:${role}` })
    expect(content).toContain('Make the simplest correct change using the project\'s conventions.')
    expect(content).toContain('Tests cover relevant happy paths, branches, boundaries, invalid input, expected failures, and')
  })

  it.each([
    ['pilot', 'phase:report'],
    ['review', 'lane:review'],
    ['refutation', 'lane:refutation'],
  ])('does not leak a core footer into the SDK-composed %s prompt', (recipient, trigger) => {
    const content = composeRules(loadRules({ shippedRoot: PLUGIN_ROOT }), { recipient, trigger })
    expect(content).not.toContain('Its act-bound half is')
  })
})

function manifestRoot(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-rules-manifest-')); roots.push(root)
  writeFileSync(join(root, 'rule.md'), content)
  return root
}

function lifecycleWithRules(rules: unknown[], route = 'FULL', options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-rules-lifecycle-')); roots.push(root)
  mkdirSync(join(root, '.lane')); writeFileSync(join(root, '.gitignore'), '.lane/\n.claude/reports/\n')
  spawnSync('git', ['init', '-q'], { cwd: root })
  // The archive root must sit OUTSIDE the worktree and ignore .claude/reports there (construction preflight).
  const archiveRoot = mkdtempSync(join(tmpdir(), 'wt-rules-archive-')); roots.push(archiveRoot)
  writeFileSync(join(archiveRoot, '.gitignore'), '.claude/reports/\n'); spawnSync('git', ['init', '-q'], { cwd: archiveRoot })
  const server = createLifecycleServer({ worktree: root, archiveRoot, route, models: { lane: 'test', review: 'test' }, cardId: 'rules', sessionTag: 'test', rules, ...options })
  const tools = server.instance._registeredTools
  const text = async (result: Promise<{ content: Array<{ text: string }> }>) => (await result).content[0]!.text
  return { root, transition: (args: Record<string, unknown>) => text(tools.transition.handler(args)), artifact: (args: Record<string, unknown>) => text(tools.write_artifact.handler(args)), run: (args: Record<string, unknown>) => text(tools.run.handler(args)) }
}
