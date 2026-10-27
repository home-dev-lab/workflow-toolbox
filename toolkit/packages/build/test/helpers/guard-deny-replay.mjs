import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const guards = ['right-sized-spawn', 'plugin-release-record', 'concurrent-test', 'grounding-pre-send', 'release-push-evidence']

function write(root, file, text) {
  const target = join(root, file)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, text)
}

function fixture(root) {
  write(root, 'empty-git-config', '')
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'config'),
    CLAUDE_PLUGIN_DATA: join(root, 'plugin-data'), XDG_STATE_HOME: join(root, 'state'),
    GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'), GIT_CONFIG_NOSYSTEM: '1',
    WT_GUARD_JOURNAL_NOW: '2026-10-27T12:00:00.000Z', WT_GUARD_JOURNAL_TEST_ORIGIN: '1',
    WT_GROUNDING_DEFAULT_REGISTRY: join(root, 'registry.json'), WT_GROUNDING_STATE_DIR: join(root, 'grounding'),
    CLAUDE_PLUGIN_OPTION_GROUNDING_PRE_SEND: 'refuse', WT_GUARD_MODE: 'enforce',
  }
  for (const args of [['init', '-q'], ['remote', 'add', 'public', root], ['symbolic-ref', 'refs/remotes/public/HEAD', 'refs/remotes/public/main']]) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  write(root, 'plugin/.claude-plugin/plugin.json', '{}')
  write(root, 'registry.json', '[]')
  write(root, 'config/plugins/store/wt-secret-guard.json', JSON.stringify({ salt: 'fixture', detections: { entries: [] } }))
  write(root, 'synthetic.jsonl', `${JSON.stringify({ type: 'user', uuid: 'human-1', message: { role: 'user', content: 'Prepare a claim.' } })}\n`)
  return env
}

function payloadFor(guard, root, agent_id) {
  const commands = { 'plugin-release-record': 'git commit -m "release: 0.2.0"', 'concurrent-test': 'pnpm test', 'release-push-evidence': 'git push public --delete main' }
  const tool_name = guard === 'right-sized-spawn' ? 'Agent' : guard === 'grounding-pre-send' ? 'mcp__plugin_atrium_atrium__speak' : 'Bash'
  const tool_input = guard === 'right-sized-spawn' ? { subagent_type: 'general-purpose', prompt: 'Implement this.' }
    : guard === 'grounding-pre-send' ? { message: 'claim' } : { command: commands[guard] }
  return { hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: root, session_id: 'synthetic-session',
    transcript_path: join(root, 'synthetic.jsonl'), agent_transcript_path: join(root, 'synthetic.jsonl'), ...(agent_id ? { agent_id } : {}) }
}

export function replayGuardCases(repoRoot, mode = 'enforce') {
  const root = mkdtempSync(join(tmpdir(), 'wt-deny-replay-'))
  try {
    const baseEnv = fixture(root)
    return guards.flatMap((guard) => [undefined, 'delegate'].map((agent_id) => {
      const journal = join(root, `${guard}-${agent_id || 'main'}`)
      const env = { ...baseEnv, WT_GUARD_JOURNAL_DIR: journal, WT_GUARD_MODE: mode,
        ...(guard === 'concurrent-test' ? { PATH: '', WT_SDK_ROLE_GUARD_FAILURE: 'closed' } : {}) }
      const hook = guard === 'grounding-pre-send' ? 'wt-grounding-pre-send-hook.mjs' : `wt-${guard}-guard-hook.mjs`
      const result = spawnSync(process.execPath, [join(repoRoot, 'plugin/bin', hook)], {
        cwd: root, input: JSON.stringify(payloadFor(guard, root, agent_id)), env, encoding: 'utf8',
      })
      const file = join(journal, '2026-W44.ndjson')
      return { guard, actor: agent_id || 'main', status: result.status, stdout: result.stdout, stderr: result.stderr,
        journal: existsSync(file) ? readFileSync(file, 'utf8') : '' }
    }))
  } finally { rmSync(root, { recursive: true, force: true }) }
}
