import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BIN_DIR = join(REPO_ROOT, 'plugin/bin')
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-guard-observe-${tag}-`))
  roots.push(root)
  return root
}

function readJournal(journalDir: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = []
  for (const file of readdirSync(journalDir)) {
    if (!file.endsWith('.ndjson')) continue
    for (const line of readFileSync(join(journalDir, file), 'utf8').split('\n')) {
      if (line.trim()) entries.push(JSON.parse(line))
    }
  }
  return entries
}

function runHook(hookFile: string, payload: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) {
  const journalDir = mkRoot(`journal-${hookFile}`)
  const res = spawnSync(process.execPath, [join(BIN_DIR, hookFile)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      WT_GUARD_JOURNAL_DIR: journalDir,
    },
  })
  return {
    ...res,
    journalDir,
    entries: readJournal(journalDir),
  }
}

function runWarnAndObserve(hookFile: string, payload: Record<string, unknown>, extraEnv: NodeJS.ProcessEnv = {}) {
  const observe = runHook(hookFile, payload, { ...extraEnv, WT_GUARD_MODE: 'observe' })
  const enforce = runHook(hookFile, payload, extraEnv)
  return { observe, enforce }
}

function git(cwd: string, ...args: string[]) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC },
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout
}

function write(root: string, rel: string, body: string) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

function pluginReleaseRecordFixture() {
  const root = mkRoot('plugin-release-record')
  git(root, 'init', '-q')
  write(root, 'plugin/.claude-plugin/plugin.json', JSON.stringify({ version: '0.1.0' }))
  write(root, 'plugin/CHANGELOG.md', '# Changelog\n')
  write(root, 'plugin/bin/thing.mjs', '// v1\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  write(root, 'plugin/bin/thing.mjs', '// v2\n')
  git(root, 'add', 'plugin/bin/thing.mjs')
  return {
    payload: {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: root,
      tool_input: { command: 'git commit -m x' },
    },
    env: HERMETIC,
  }
}

function observerPairingFixture() {
  const root = mkRoot('observer-pairing')
  const cfg = join(root, 'cfg')
  const projectRoot = join(root, 'proj')
  mkdirSync(projectRoot, { recursive: true })
  const agentsDir = join(projectRoot, '.claude', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(
    join(agentsDir, 'pilot-orchestrator.md'),
    '---\nname: pilot-orchestrator\nobserver: pilot-orchestrator-watchdog\n---\nbody\n',
  )
  const slugDir = join(cfg, 'projects', 'slug-observer-pairing')
  const sessionId = '11111111-2222-3333-4444-555555555555'
  const subagentsDir = join(slugDir, sessionId, 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  writeFileSync(
    join(subagentsDir, 'agent-a1b2c3d4e5f6a7b8c.meta.json'),
    JSON.stringify({ agentType: 'pilot-orchestrator' }),
  )
  return {
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'pilot-orchestrator' },
      tool_response: { agent_id: 'a1b2c3d4e5f6a7b8c' },
      cwd: projectRoot,
      session_id: sessionId,
      transcript_path: join(slugDir, `${sessionId}.jsonl`),
    },
    env: { CLAUDE_CONFIG_DIR: cfg },
  }
}

function staleDateFixture() {
  const root = mkRoot('stale-date')
  const filePath = join(root, '.claude', 'rules', 'policy.md')
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true })
  writeFileSync(filePath, 'Le prochain compte utilisable après epuisement : le 29/07 a 13:59.\n')
  return {
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      cwd: root,
      tool_input: { file_path: filePath },
    },
  }
}

describe('WT_GUARD_MODE=observe', () => {
  const cases: Array<{
    hook: string
    make: () => { payload: Record<string, unknown>; env?: NodeJS.ProcessEnv }
    contains?: string
  }> = [
    {
      hook: 'wt-merge-chain-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git merge branch && pnpm test' } } }),
      contains: 'WARNING (not blocked)',
    },
    {
      hook: 'wt-pipestatus-bash-only-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true | false; echo "${PIPESTATUS[0]}"' } } }),
      contains: 'pipestatus guard',
    },
    {
      hook: 'wt-find-newermt-format-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'find . -newermt "5 minutes ago" | wc -l' } } }),
      contains: 'find-newermt guard',
    },
    {
      hook: 'wt-git-commit-backtick-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "the default `stretch` applied"' } } }),
      contains: 'backtick guard',
    },
    {
      hook: 'wt-var-colon-modifier-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git show "$s:src/db-base.ts"' } } }),
      contains: 'var-colon guard',
    },
    {
      hook: 'wt-missing-package-script-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: REPO_ROOT, tool_input: { command: 'pnpm definitely-missing-script' } } }),
      contains: 'missing-script guard',
    },
    {
      hook: 'wt-pgrep-env-dump-guard-hook.mjs',
      make: () => ({ payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pgrep -af opencode' } } }),
      contains: 'pgrep-env-dump guard',
    },
    {
      hook: 'wt-plugin-release-record-guard-hook.mjs',
      make: pluginReleaseRecordFixture,
      contains: 'release-record guard',
    },
    {
      hook: 'wt-isolated-spawn-report-path-hook.mjs',
      make: () => ({
        payload: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          tool_input: {
            isolation: 'worktree',
            name: 'writer',
            prompt: 'Write your report to /tmp/outside-tree/report.md before you finish.',
          },
        },
      }),
      contains: 'ISOLATED SPAWN + AN OUT-OF-TREE WRITE TARGET',
    },
    {
      hook: 'wt-observer-pairing-guard-hook.mjs',
      make: observerPairingFixture,
      contains: 'LOST its declared observer',
    },
    {
      hook: 'wt-stale-date-guard-hook.mjs',
      make: staleDateFixture,
      contains: 'STALE OPERATIONAL DEADLINE',
    },
  ]

  for (const { hook, make, contains } of cases) {
    it(`${hook} journals mode=observe and emits nothing`, () => {
      const { payload, env } = make()
      const { observe, enforce } = runWarnAndObserve(hook, payload, env)
      expect(observe.status).toBe(0)
      expect(observe.stdout).toBe('')
      expect(observe.stderr).toBe('')
      expect(observe.entries).toHaveLength(1)
      expect(observe.entries[0]).toMatchObject({ guard: hook, decision: 'silent', mode: 'observe' })
      expect(enforce.status).toBe(0)
      expect(enforce.entries).toHaveLength(1)
      expect(enforce.entries[0]).toMatchObject({ guard: hook, decision: 'warned', mode: 'enforce' })
      expect(enforce.stdout).not.toBe('')
      if (contains) {
        expect(observe.stdout).not.toContain(contains)
        expect(observe.stderr).not.toContain(contains)
        expect(enforce.stdout).toContain(contains)
      }
    })
  }
})
