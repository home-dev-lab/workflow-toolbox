import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(ROOT, 'plugin')
const roots: string[] = []
const section = (source: string, heading: string, recipients: string[], triggers: string[], level = 'test') => ({ source, heading, recipients, triggers, level, section: `${heading}\n\nExact rule bytes.\n` })

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('SDK role rules manifest', () => {
  it('validates every shipped source and exact heading against the published schema enums', () => {
    const rules = loadRules({ shippedRoot: PLUGIN_ROOT })
    const schema = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'rules-manifest.schema.json'), 'utf8'))
    expect(rules).toHaveLength(16)
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
    expect(rules.filter((entry: { level: string }) => entry.level === 'shipped')).toHaveLength(16)
    expect(rules.at(-1)).toMatchObject({ level: 'project', section: '## Project rule\r\nproject bytes\r\n' })
  })

  it('measures the composed standing system prompt before and after exact shipped sections', () => {
    const contract = readFileSync(join(PLUGIN_ROOT, 'autonomy', 'PILOT-CONTRACT.md'), 'utf8')
    const composed = composeStandingPrompt(contract, loadRules({ shippedRoot: PLUGIN_ROOT }))
    expect(Buffer.byteLength(contract)).toBe(6127)
    expect(Buffer.byteLength(composed)).toBe(8359)
    for (const heading of ['## Understand before coding', '## Plan, task, and test', '## Implement and verify']) expect(composed).toContain(heading)
  })

  it('returns pilot phase rules on the new phase transition', async () => {
    const lifecycle = lifecycleWithRules([section('project/rule.md', '## Plan authority', ['pilot'], ['phase:plan'])])
    const result = await lifecycle.transition({ phase: 'discovery', record: 'read it', tool_use_id: 'phase' })
    expect(result).toContain('accepted phase=plan')
    expect(result).toContain('## Rules for phase plan (authoritative)')
    expect(result).toContain('## Plan authority\n\nExact rule bytes.\n')
  })

  it('places authoritative lane rules before pilot context in the brief both executor families read', async () => {
    const rules = [section('project/rule.md', '## TDD authority', ['tdd'], ['lane:tdd'])]
    const lifecycle = lifecycleWithRules(rules, 'LITE')
    await lifecycle.transition({ phase: 'discovery', record: 'read it', tool_use_id: 'phase' })
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
    await lifecycle.transition({ phase: 'discovery', record: 'read it', tool_use_id: 'phase' })
    await lifecycle.artifact({ kind: 'brief', content: 'pilot context\n' })
    const brief = readFileSync(join(lifecycle.root, '.lane', 'tdd-brief.md'), 'utf8')
    expect(brief).toContain('## Changelog instructions (authoritative)\n\n# Fixture changelog instructions\n\nRun the deterministic writer.')
    expect(brief).not.toContain('name: fixture')
    expect(brief.indexOf('## Changelog instructions (authoritative)')).toBeLessThan(brief.indexOf('## Pilot instructions'))

    const missing = lifecycleWithRules([], 'LITE', { changelogSkillPath: join(skillRoot, 'absent.md') })
    await missing.transition({ phase: 'discovery', record: 'read it', tool_use_id: 'phase' })
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
    for (const role of ['critic', 'tdd', 'review', 'refutation', 'harden']) {
      const content = composeRules(rules, { recipient: role, trigger: `lane:${role}` })
      expect(content, role).toContain('BEGIN authoritative rule')
      for (const entry of rules.filter((candidate: { recipients: string[], triggers: string[] }) => candidate.recipients.includes(role) && candidate.triggers.includes(`lane:${role}`))) {
        expect(content).toContain(entry.section)
      }
    }
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
  return { root, transition: (args: Record<string, unknown>) => text(tools.transition.handler(args)), artifact: (args: Record<string, unknown>) => text(tools.write_artifact.handler(args)) }
}
