import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const found = spawnSync('command -v opencode', { shell: true, encoding: 'utf8' })
const installed = found.status === 0 ? (found.stdout.trim().split('\n')[0] ?? '') : ''

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
    const env = { ...process.env, OPENCODE_TEST_HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state') }
    try {
      const control = spawnSync(binary, ['--pure', 'debug', 'skill'], { cwd: worktree, encoding: 'utf8', env })
      const fenced = spawnSync(binary, ['--pure', 'debug', 'skill'], { cwd: worktree, encoding: 'utf8', env: { ...env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true' } })
      expect(control.status).toBe(0); expect(fenced.status).toBe(0)
      expect(JSON.parse(control.stdout).map((skill: { name: string }) => skill.name)).toContain('claude-sentinel')
      const names = JSON.parse(fenced.stdout).map((skill: { name: string }) => skill.name)
      expect(names).not.toContain('claude-sentinel')
      expect(names).toContain('legitimate-sentinel')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
