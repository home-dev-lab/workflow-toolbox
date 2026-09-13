import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    writeFileSync(path.join(lane, '.claude', 'skills', 'one', 'SKILL.md'), 'lane')
    writeFileSync(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), 'home')
    const result = materialiseAllowedSkills({ names: ['one', 'missing'], laneDir: lane, homeDir: home, env: {} })
    expect(result.materialised).toEqual(['one']); expect(result.missing).toEqual(['missing'])
    expect(readFileSync(path.join(result.dir, 'one', 'SKILL.md'), 'utf8')).toBe('lane')
    expect(result.dir).toBe(path.join(lane, '.lane', 'opencode-skills'))
  })

  it('writes no materialised files outside the lane .lane directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(lane, 'keep'), { recursive: true })
    mkdirSync(path.join(home, '.claude', 'skills', 'one'), { recursive: true })
    writeFileSync(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), 'ok')
    const before = readdirSync(lane, { recursive: true }).sort()
    materialiseAllowedSkills({ names: ['one'], laneDir: lane, homeDir: home, env: {} })
    const outsideLaneMetadata = readdirSync(lane, { recursive: true }).map(String).filter((entry) => entry !== '.lane' && !entry.startsWith('.lane/')).sort()
    expect(outsideLaneMetadata).toEqual(before)
  })

  it('refuses a symlink rather than escaping the skill source tree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-lane-skills-')); roots.push(root)
    const lane = path.join(root, 'lane'); const home = path.join(root, 'home')
    mkdirSync(path.join(home, '.claude', 'skills', 'one'), { recursive: true })
    writeFileSync(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), 'ok')
    symlinkSync('/etc/passwd', path.join(home, '.claude', 'skills', 'one', 'outside'))
    expect(materialiseAllowedSkills({ names: ['one'], laneDir: lane, homeDir: home, env: {} }).missing).toEqual(['one'])
  })
})
