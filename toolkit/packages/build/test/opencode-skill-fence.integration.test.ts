import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Standalone plugin helper has no declaration surface.
import { materialiseAllowedSkills, opencodeChildEnv, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from '../../../../plugin/bin/lib/opencode-skill-fence.mjs'

const found = spawnSync('command -v opencode', { shell: true, encoding: 'utf8' })
const installed = found.status === 0 ? (found.stdout.trim().split('\n')[0] ?? '') : ''
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
// Launcher mechanics are exercised with a fake opencode the lane sandbox cannot see (by design);
// the sandbox itself is locked in lane-sandbox.test.ts.
const unfencedProcessEnv: NodeJS.ProcessEnv = { ...process.env, WT_LANE_SANDBOX: 'off' }
beforeEach(() => { vi.stubEnv('WT_LANE_SANDBOX', 'off') })
afterEach(() => { vi.unstubAllEnvs() })
delete unfencedProcessEnv.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS

describe('installed OpenCode Claude-skill fence', () => {
  const run = installed ? it : it.skip
  const realRun = installed && process.env.WT_REAL_OPENCODE_E2E === '1' ? it : it.skip
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
      const refused = spawnSync(process.execPath, [launcher, '--dir', lane, '--model', 'openai/gpt-5.6-luna', '--brief', path.join(lane, 'brief.md'), '--allow-no-git'], {
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

  run.each([
    ['project .opencode/skills', '.opencode/skills/innocent', null],
    ['project .agents/skills', '.agents/skills/innocent', null],
    ['frontmatter alias', '.opencode/skills/innocent', null],
    ['nested SKILL.md', '.opencode/skills/innocent/nested', '.opencode/skills/innocent'],
  ])('refuses effective discovery through %s', (_label, skillRelative, rootRelative) => {
    const binary = installed || 'opencode'
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-effective-skill-route-'))
    const home = path.join(root, 'home'); const lane = path.join(root, 'lane')
    const skillDir = path.join(lane, skillRelative!)
    const declaredRoot = rootRelative ? path.join(lane, rootRelative) : skillDir
    const env: NodeJS.ProcessEnv = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }
    try {
      mkdirSync(skillDir, { recursive: true })
      if (rootRelative) writeFileSync(path.join(declaredRoot, 'SKILL.md'), '---\nname: innocent\ndescription: root\n---\n')
      writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: save-memory\ndescription: refused route\n---\n')
      const result = verifyEffectiveOpencodeSkillDiscovery(binary, { cwd: lane, env })
      expect(result).toMatchObject({ ok: false, refused: [expect.objectContaining({ name: 'save-memory', location: expect.stringContaining('SKILL.md') })] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  run.each([
    ['configured Claude root', true],
    ['user skills.paths', false],
    ['inherited OPENCODE_CONFIG', false],
    ['stale materialisation', false],
  ])('refuses effective discovery through %s', (label, claudeRoot) => {
    const binary = installed || 'opencode'
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-effective-config-route-'))
    const home = path.join(root, 'home'); const lane = path.join(root, 'lane'); const external = claudeRoot ? path.join(home, '.claude', 'skills') : path.join(root, 'external')
    const configDir = path.join(root, 'config', 'opencode'); const configPath = path.join(configDir, 'opencode.json')
    const env: NodeJS.ProcessEnv = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }
    try {
      mkdirSync(path.join(external, 'save-memory'), { recursive: true }); mkdirSync(lane, { recursive: true }); mkdirSync(configDir, { recursive: true })
      writeFileSync(path.join(external, 'save-memory', 'SKILL.md'), '---\nname: save-memory\ndescription: refused configured route\n---\n')
      writeFileSync(configPath, JSON.stringify({ skills: { paths: [external] } }))
      if (label === 'inherited OPENCODE_CONFIG') {
        rmSync(path.join(root, 'config'), { recursive: true, force: true })
        env.OPENCODE_CONFIG = configPath
        mkdirSync(configDir, { recursive: true }); writeFileSync(configPath, JSON.stringify({ skills: { paths: [external] } }))
      }
      if (label === 'stale materialisation') env.OPENCODE_CONFIG = configPath
      const result = verifyEffectiveOpencodeSkillDiscovery(binary, { cwd: lane, env })
      expect(result).toMatchObject({ ok: false, refused: [expect.objectContaining({ name: 'save-memory', location: expect.stringContaining('SKILL.md') })] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  run.each(['Save-Memory', 'save_memory', 'SAVE-MEMORY'])('refuses installed OpenCode discovery of %s', (name) => {
    const binary = installed || 'opencode'
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-effective-name-variant-'))
    const home = path.join(root, 'home'); const lane = path.join(root, 'lane')
    const skillDir = path.join(lane, '.opencode', 'skills', name)
    const env: NodeJS.ProcessEnv = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' }
    try {
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: refused identity variant\n---\n`)
      const listed = spawnSync(binary, ['debug', 'skill'], { cwd: lane, encoding: 'utf8', env })
      expect(listed.status).toBe(0)
      expect(JSON.parse(listed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ name })]))
      expect(verifyEffectiveOpencodeSkillDiscovery(binary, { cwd: lane, env })).toMatchObject({ ok: false, refused: [expect.objectContaining({ name })] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  run.each(['save-memory', 'Save_Memory'])('real wt-lane refuses project-native %s before detaching', (name) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-real-lane-refusal-'))
    const home = path.join(root, 'home'); const lane = path.join(root, 'lane'); const config = path.join(home, '.claude')
    const skillDir = path.join(lane, '.opencode', 'skills', name)
    const env = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state') }
    try {
      mkdirSync(skillDir, { recursive: true }); mkdirSync(config, { recursive: true })
      writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
      writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: refused native route\n---\n`)
      const brief = path.join(lane, 'brief.md'); writeFileSync(brief, '# must not run\n')
      const result = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'bin', 'wt-lane.mjs'), '--dir', lane, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git'], { encoding: 'utf8', env })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`effective OpenCode skill discovery found ${name}`)
      expect(existsSync(path.join(lane, '.lane', 'pid'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  realRun('launches an allowed skill through real wt-lane and loads it in opencode run', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'wt-real-lane-allowed-'))
    const home = path.join(root, 'home'); const lane = path.join(root, 'lane'); const config = path.join(home, '.claude')
    const allowed = 'allowed-sentinel'; const brief = path.join(lane, 'brief.md'); const log = path.join(lane, '.lane', 'real.log')
    const env = { ...unfencedProcessEnv, HOME: home, OPENCODE_TEST_HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), WT_LANE_SKILLS: allowed }
    try {
      mkdirSync(path.join(config, 'skills', allowed), { recursive: true }); mkdirSync(lane, { recursive: true })
      writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
      writeFileSync(path.join(config, 'skills', allowed, 'SKILL.md'), `---\nname: ${allowed}\ndescription: Use when asked to prove the lane allow-list e2e.\n---\nReply with the exact token ALLOWED_SKILL_LOADED.\n`)
      writeFileSync(brief, `Invoke the \`${allowed}\` skill, follow it, and output only its exact token.\n`)
      const launch = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'bin', 'wt-lane.mjs'), '--dir', lane, '--model', process.env.WT_REAL_OPENCODE_MODEL || 'openai/gpt-5.6-luna', '--brief', brief, '--log', log, '--timeout', '120', '--allow-no-git'], { encoding: 'utf8', env })
      expect(launch.status).toBe(0)
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline && (!existsSync(log) || !/EXIT=/.test(readFileSync(log, 'utf8')))) spawnSync('sleep', ['0.1'])
      const output = readFileSync(log, 'utf8')
      expect(output).toContain('ALLOWED_SKILL_LOADED')
      expect(output).toMatch(/EXIT=0\n$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
