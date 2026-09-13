import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { materialiseAllowedSkills, opencodeChildEnv, verifyOpencodeSkillFence } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const found = spawnSync('command -v opencode', { shell: true, encoding: 'utf8' })
const installed = found.status === 0 ? (found.stdout.trim().split('\n')[0] ?? '') : ''
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const unfencedProcessEnv = { ...process.env }
delete unfencedProcessEnv.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS

describe('installed OpenCode Claude-skill fence', () => {
  const run = installed ? it : it.skip
  run('lists the Claude control, omits it fenced, and preserves a legitimate OpenCode skill', () => {
    const binary = installed || 'opencode'
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-installed-skill-fence-'))
    const home = path.join(root, 'home'); const worktree = path.join(root, 'worktree')
    mkdirSync(path.join(home, '.claude', 'skills', 'claude-sentinel'), { recursive: true })
    mkdirSync(path.join(worktree, '.opencode', 'skills', 'legitimate-sentinel'), { recursive: true })
    writeFileSync(path.join(home, '.claude', 'skills', 'claude-sentinel', 'SKILL.md'), '---\nname: claude-sentinel\ndescription: CLAUDE_SENTINEL\n---\n')
    writeFileSync(path.join(worktree, '.opencode', 'skills', 'legitimate-sentinel', 'SKILL.md'), '---\nname: legitimate-sentinel\ndescription: LEGITIMATE_SENTINEL\n---\n')
    const env = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state') }
    try {
      const control = spawnSync(binary, ['--pure', 'debug', 'skill'], { cwd: worktree, encoding: 'utf8', env })
      const fenced = spawnSync(binary, ['--pure', 'debug', 'skill'], { cwd: worktree, encoding: 'utf8', env: { ...env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' } })
      expect(control.status).toBe(0); expect(fenced.status).toBe(0)
      // OpenCode 1.18.30 reads Claude skills from HOME/.claude in this fixture (2026-09-13).
      expect(JSON.parse(control.stdout).map((skill: { name: string }) => skill.name)).toContain('claude-sentinel')
      const names = JSON.parse(fenced.stdout).map((skill: { name: string }) => skill.name)
      expect(names).not.toContain('claude-sentinel')
      expect(names).toContain('legitimate-sentinel')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  run('materialises an allowed lane skill while refusing the single-writer control', () => {
    const binary = installed || 'opencode'
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-installed-lane-allow-'))
    const home = path.join(root, 'home'); const lane = path.join(root, 'lane'); const config = path.join(home, '.claude')
    const allowed = 'allowed-sentinel'
    const env = {
      ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, CLAUDE_CONFIG_DIR: config,
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    }
    try {
      mkdirSync(path.join(home, '.claude', 'skills', allowed), { recursive: true })
      mkdirSync(path.join(home, '.claude', 'skills', 'save-memory'), { recursive: true })
      mkdirSync(config, { recursive: true }); mkdirSync(lane, { recursive: true })
      writeFileSync(path.join(home, '.claude', 'skills', allowed, 'SKILL.md'), `---\nname: ${allowed}\ndescription: allowed control\n---\n`)
      writeFileSync(path.join(home, '.claude', 'skills', 'save-memory', 'SKILL.md'), '---\nname: save-memory\ndescription: refused control\n---\n')
      writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
      const launcher = path.join(ROOT, 'plugin', 'bin', 'wt-lane.mjs')
      expect(existsSync(launcher), `the launcher is not at ${launcher}`).toBe(true)
      writeFileSync(path.join(lane, 'brief.md'), '# brief\n')
      const refused = spawnSync(process.execPath, [launcher, '--dir', lane, '--model', 'test/model', '--brief', path.join(lane, 'brief.md'), '--allow-no-git'], {
        encoding: 'utf8', env: { ...env, WT_LANE_SKILLS: `${allowed},save-memory` },
      })
      expect(refused.status).toBe(1); expect(refused.stderr).toContain('save-memory is a single-writer')

      const control = spawnSync(binary, ['--pure', 'debug', 'skill'], { cwd: lane, encoding: 'utf8', env })
      expect(control.status).toBe(0)
      const controlNames = JSON.parse(control.stdout).map((skill: { name: string }) => skill.name)
      expect(controlNames).toContain(allowed); expect(controlNames).toContain('save-memory')

      const materialised = materialiseAllowedSkills({ names: [allowed], laneDir: lane, env, homeDir: home })
      expect(materialised.missing).toEqual([])
      const listed = spawnSync(binary, ['--pure', 'debug', 'skill'], {
        cwd: lane, encoding: 'utf8', env: { ...opencodeChildEnv(env), OPENCODE_CONFIG: materialised.configPath },
      })
      const names = JSON.parse(listed.stdout).map((skill: { name: string }) => skill.name)
      expect(listed.status).toBe(0); expect(names).toContain(allowed); expect(names).not.toContain('save-memory')
      expect(verifyOpencodeSkillFence(binary, { env, stateDir: path.join(root, 'fence-state') })).toMatchObject({ ok: true, allowOk: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
