import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function journalFixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-work-journal-'))
  const project = join(root, 'project')
  const config = join(root, 'config')
  for (const dir of [project, config, join(root, 'home')]) mkdirSync(dir, { recursive: true })
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: config,
    CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: join(root, 'plugin-data'), CLAUDECODE: '1', TZ: 'UTC',
    WT_WORK_JOURNAL_DIR: join(root, 'live'), WT_WORK_JOURNAL_ARCHIVE_DIR: join(root, 'archive'), WT_WORK_JOURNAL_NOW: '2026-06-02T12:00:00Z',
    WT_GUARD_JOURNAL_DIR: join(root, 'guard'), GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  function cli(args: string[], input = '', overrides = {}) {
    return spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../../../plugin/bin/wt-work-journal.mjs'), ...args], { input, encoding: 'utf8', env: { ...env, ...overrides } })
  }
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', project, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env })
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  function init() { git('init', '-b', 'feature'); git('config', 'user.name', 'Journal Test'); git('config', 'user.email', 'journal@example.test') }
  function board() {
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'planka.json'), JSON.stringify({ boardId: 'board', baseUrl: 'https://boards.example.test' }))
  }
  return { root, project, env, cli, git, init, board, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
