import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helpers have no declaration surface.
import { REFUSED_LANE_SKILLS, resolveLaneSkillAllowlist } from '../../../../plugin/bin/lib/lane-skill-allowlist.mjs'
// @ts-expect-error Standalone plugin helpers have no declaration surface.
import { materialiseAllowedSkills } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('lane skill allow-list', () => {
  it('parses deterministically and preserves empty-config identity', () => {
    expect(resolveLaneSkillAllowlist({ env: {} })).toEqual({ allowed: [], refusals: [] })
    expect(resolveLaneSkillAllowlist({ env: { WT_LANE_SKILLS: 'one, two one' } })).toEqual({ allowed: ['one', 'two'], refusals: [] })
  })

  it('refuses invalid names and every single-writer skill', () => {
    const result = resolveLaneSkillAllowlist({ env: { WT_LANE_SKILLS: `ok ../bad /bad ${REFUSED_LANE_SKILLS.join(',')}` } })
    expect(result.allowed).toEqual(['ok'])
    expect(result.refusals.map((refusal: { name: string }) => refusal.name)).toEqual(['../bad', '/bad', ...REFUSED_LANE_SKILLS])
  })

  it('copies only requested non-symlink skill trees under .lane, preferring lane sources', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(lane, '.claude', 'skills', 'one'), { recursive: true })
    mkdirSync(path.join(home, '.claude', 'skills', 'one'), { recursive: true })
    writeFileSync(path.join(lane, '.claude', 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: lane\n---\n')
    writeFileSync(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: home\n---\n')
    const result = materialiseAllowedSkills({ names: ['one'], laneDir: lane, homeDir: home, env: {} })
    expect(result.materialised).toEqual(['one']); expect(result.failures).toEqual([])
    expect(readFileSync(path.join(result.dir, 'one', 'SKILL.md'), 'utf8')).toContain('description: lane')
    expect(result.dir).toBe(path.join(lane, '.lane', 'opencode-skills'))
    expect(materialiseAllowedSkills({ names: ['missing'], laneDir: lane, homeDir: home, env: {} }).failures).toEqual([
      expect.objectContaining({ name: 'missing', reason: 'missing-source' }),
    ])
  })

  it('writes no materialised files outside the lane .lane directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(lane, 'keep'), { recursive: true })
    mkdirSync(path.join(home, '.claude', 'skills', 'one'), { recursive: true })
    writeFileSync(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: ok\n---\n')
    const before = readdirSync(lane, { recursive: true }).sort()
    materialiseAllowedSkills({ names: ['one'], laneDir: lane, homeDir: home, env: {} })
    const outsideLaneMetadata = readdirSync(lane, { recursive: true }).map(String).filter((entry) => entry !== '.lane' && !entry.startsWith('.lane/')).sort()
    expect(outsideLaneMetadata).toEqual(before)
  })

  it('refuses a symlink rather than escaping the skill source tree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(home, '.claude', 'skills', 'one'), { recursive: true })
    writeFileSync(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: ok\n---\n')
    symlinkSync('/etc/passwd', path.join(home, '.claude', 'skills', 'one', 'outside'))
    expect(materialiseAllowedSkills({ names: ['one'], laneDir: lane, homeDir: home, env: {} }).failures).toEqual([
      expect.objectContaining({ name: 'one', reason: 'source-symlink' }),
    ])
  })

  it('requires the frontmatter name to equal the requested directory name', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(home, '.claude', 'skills', 'innocent'), { recursive: true })
    writeFileSync(path.join(home, '.claude', 'skills', 'innocent', 'SKILL.md'), '---\nname: save-memory\ndescription: alias\n---\n')
    expect(materialiseAllowedSkills({ names: ['innocent'], laneDir: lane, homeDir: home, env: {} }).failures).toEqual([
      expect.objectContaining({ name: 'innocent', reason: 'name-mismatch' }),
    ])
  })

  it('rejects nested SKILL.md files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    const skill = path.join(home, '.claude', 'skills', 'one')
    mkdirSync(path.join(skill, 'nested'), { recursive: true })
    writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: one\ndescription: root\n---\n')
    writeFileSync(path.join(skill, 'nested', 'SKILL.md'), '---\nname: save-memory\ndescription: nested\n---\n')
    expect(materialiseAllowedSkills({ names: ['one'], laneDir: lane, homeDir: home, env: {} }).failures).toEqual([
      expect.objectContaining({ name: 'one', reason: 'nested-skill' }),
    ])
  })

  it('removes stale materialisations on every launch', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(lane, '.lane', 'opencode-skills', 'stale'), { recursive: true })
    writeFileSync(path.join(lane, '.lane', 'opencode-skills', 'stale', 'SKILL.md'), '---\nname: save-memory\ndescription: stale\n---\n')
    const result = materialiseAllowedSkills({ names: [], laneDir: lane, homeDir: home, env: {} })
    expect(existsSync(path.join(result.dir, 'stale'))).toBe(false)
    expect(readdirSync(result.dir)).toEqual([])
  })

  it('refuses a symlink in every existing destination component without writing through it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home'); const outside = path.join(root, 'outside')
    mkdirSync(lane); mkdirSync(outside)
    symlinkSync(outside, path.join(lane, '.lane'))
    expect(() => materialiseAllowedSkills({ names: [], laneDir: lane, homeDir: home, env: {} })).toThrow(/destination component is a symlink/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses a pre-existing skill destination symlink instead of removing or following it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home'); const outside = path.join(root, 'outside')
    mkdirSync(path.join(lane, '.lane', 'opencode-skills'), { recursive: true }); mkdirSync(outside)
    symlinkSync(outside, path.join(lane, '.lane', 'opencode-skills', 'one'))
    expect(() => materialiseAllowedSkills({ names: [], laneDir: lane, homeDir: home, env: {} })).toThrow(/destination component is a symlink/)
    expect(existsSync(path.join(lane, '.lane', 'opencode-skills', 'one'))).toBe(true)
    expect(readdirSync(outside)).toEqual([])
  })
})
